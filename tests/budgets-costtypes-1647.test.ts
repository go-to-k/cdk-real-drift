// #1647 — Budgets CostTypes. readBudget deliberately omitted CostTypes from its
// projection, so classify's removed-declared-collection branch fired on any truthy
// declared CostTypes (`desired={"IncludeTax":true} actual=undefined` false drift on every
// clean check) while an all-false declared CostTypes was swallowed by the isTrivialEmpty
// exemption — a declared CostTypes was never compared in EITHER direction. Two-part fix:
//   F1 readBudget projects CostTypes (DescribeBudget returns the full 11-boolean object).
//   F2 KNOWN_DEFAULT_PATHS pins the 11 documented constants (`Budget.CostTypes.*`,
//      9 true + UseBlended/UseAmortized false, live-confirmed 2026-07-15), equality-gated
//      so the undeclared default set folds to zero first-run drift while an out-of-band
//      truthy flip (UseBlended/UseAmortized -> true) still surfaces.
import { BudgetsClient, DescribeBudgetCommand } from '@aws-sdk/client-budgets';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { SDK_OVERRIDES } from '../src/read/overrides.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// The exact live-observed 11-boolean default set from budgets:DescribeBudget (#1647).
const LIVE_COST_TYPES_DEFAULTS = {
  IncludeTax: true,
  IncludeSubscription: true,
  UseBlended: false,
  IncludeRefund: true,
  IncludeCredit: true,
  IncludeUpfront: true,
  IncludeRecurring: true,
  IncludeOtherSubscription: true,
  IncludeSupport: true,
  IncludeDiscount: true,
  UseAmortized: false,
};

const emptySchema: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};

// FULL tier:path list (not tier-filtered) so double-reporting cannot hide (#747).
const all = (fs: Finding[]) => fs.map((f) => `${f.tier}:${f.path}`).sort();

const mk = (declaredBudget: Record<string, unknown>): DesiredResource => ({
  logicalId: 'CfnBudget',
  resourceType: 'AWS::Budgets::Budget',
  physicalId: 'my-budget',
  declared: { Budget: declaredBudget },
});
const liveBudget = (costTypes: Record<string, unknown>): Record<string, unknown> => ({
  Budget: {
    BudgetName: 'my-budget',
    BudgetType: 'COST',
    TimeUnit: 'MONTHLY',
    BudgetLimit: { Amount: '5.0', Unit: 'USD' },
    CostTypes: costTypes,
  },
});
const baseDeclared = {
  BudgetName: 'my-budget',
  BudgetType: 'COST',
  TimeUnit: 'MONTHLY',
  BudgetLimit: { Amount: 5, Unit: 'USD' },
};

describe('#1647 F1 readBudget projects CostTypes', () => {
  const budgets = mockClient(BudgetsClient);
  beforeEach(() => budgets.reset());

  it('projects the full live CostTypes object so a declared CostTypes is actually compared', async () => {
    budgets.on(DescribeBudgetCommand).resolves({
      Budget: {
        BudgetName: 'b',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        CostTypes: LIVE_COST_TYPES_DEFAULTS,
      },
    });
    const out = await SDK_OVERRIDES['AWS::Budgets::Budget']({
      physicalId: 'b',
      declared: { Budget: { BudgetName: 'b' } },
      region: 'us-east-1',
      accountId: '123456789012',
    });
    expect(out).toEqual({
      Budget: {
        BudgetName: 'b',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        CostTypes: LIVE_COST_TYPES_DEFAULTS,
      },
    });
  });
});

describe('#1647 F2 CostTypes KNOWN_DEFAULT_PATHS folds', () => {
  it('an UNDECLARED CostTypes at the full 11-boolean default set folds — zero drift on a clean check', () => {
    const findings = classifyResource(
      mk(baseDeclared),
      liveBudget(LIVE_COST_TYPES_DEFAULTS),
      emptySchema
    );
    // FULL list: nothing but atDefault-tier fold(s) for CostTypes — no declared, no
    // undeclared, no double-reporting.
    expect(all(findings)).toEqual(['atDefault:Budget.CostTypes']);
  });

  it('declared IncludeTax:true matching the live true is clean (the #1647 FP direction)', () => {
    const findings = classifyResource(
      mk({ ...baseDeclared, CostTypes: { IncludeTax: true } }),
      liveBudget(LIVE_COST_TYPES_DEFAULTS),
      emptySchema
    );
    expect(all(findings).filter((p) => p.startsWith('declared:'))).toEqual([]);
    expect(all(findings).filter((p) => p.startsWith('undeclared:'))).toEqual([]);
  });

  it('declared IncludeTax:false vs live true MUST surface declared drift (the #1647 FN direction)', () => {
    const findings = classifyResource(
      mk({ ...baseDeclared, CostTypes: { IncludeTax: false } }),
      liveBudget(LIVE_COST_TYPES_DEFAULTS),
      emptySchema
    );
    const declared = findings.filter((f) => f.tier === 'declared');
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.some((f) => f.path.startsWith('Budget.CostTypes'))).toBe(true);
  });

  it('an out-of-band flip AWAY from a default (UseBlended false -> true) still surfaces', () => {
    const findings = classifyResource(
      mk(baseDeclared),
      liveBudget({ ...LIVE_COST_TYPES_DEFAULTS, UseBlended: true }),
      emptySchema
    );
    // The divergent leaf breaks the fold: the finding must land in the undeclared tier
    // (whole-object or per-leaf), never fold silently.
    const undeclared = findings.filter((f) => f.tier === 'undeclared');
    expect(undeclared.length).toBeGreaterThan(0);
    expect(undeclared.some((f) => f.path.startsWith('Budget.CostTypes'))).toBe(true);
    // and it is not ALSO reported atDefault (no double-reporting)
    expect(all(findings).filter((p) => p.startsWith('atDefault:Budget.CostTypes'))).toEqual([]);
  });

  it('an out-of-band truthy-pin flip (IncludeTax true -> false) surfaces via the whole-object pin', () => {
    // The wholly-undeclared CostTypes is emitted as ONE sub-object, so the equality-gated
    // whole-object pin re-surfaces even a true->false leaf flip (which a per-leaf pin alone
    // would lose to isTrivialEmpty).
    const findings = classifyResource(
      mk(baseDeclared),
      liveBudget({ ...LIVE_COST_TYPES_DEFAULTS, IncludeTax: false }),
      emptySchema
    );
    const undeclared = findings.filter((f) => f.tier === 'undeclared');
    expect(undeclared.some((f) => f.path.startsWith('Budget.CostTypes'))).toBe(true);
    expect(all(findings).filter((p) => p.startsWith('atDefault:Budget.CostTypes'))).toEqual([]);
  });
});
