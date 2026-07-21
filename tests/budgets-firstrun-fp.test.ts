// #1676 follow-up — two first-run `[Potential Drift]` FPs on non-fixed AWS::Budgets::Budget
// configurations, both live-observed (Cdkrd1676AutoAdj / Cdkrd1676Planned, 2026-07-21):
//
//   FP1 (computed BudgetLimit): an AUTO-ADJUSTING budget (AutoAdjustData) and a TIME-PHASED
//   budget (PlannedBudgetLimits) both have AWS materialize a computed top-level BudgetLimit
//   ("0.01" / "100.0") that the user CANNOT declare (CreateBudget accepts exactly one of
//   BudgetLimit / PlannedBudgetLimits / AutoAdjustData). readBudget projected it -> an
//   undeclared potential-drift FP with no stable default to fold to. Fix: omit BudgetLimit
//   from the projection whenever AutoAdjustData or PlannedBudgetLimits is present (a computed
//   member, like CalculatedSpend/TimePeriod).
//
//   FP2 (numeric-string amounts): CDK stringifies a Spend Amount to "100" even from a numeric
//   input, and DescribeBudget returns "100.0", so isStringlyEqualScalar's number-vs-string arm
//   (which does NOT fold string-vs-string) missed every PlannedBudgetLimits period -> all 12
//   months false-flagged as declared drift on a clean check. Fix: NUMERIC_STRING_EQUAL_PATHS
//   folds Budget amount paths via isNumericStringEqualScalar; a genuine amount change still
//   differs.
import { BudgetsClient, DescribeBudgetCommand } from '@aws-sdk/client-budgets';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { SDK_OVERRIDES } from '../src/read/overrides.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

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
const all = (fs: Finding[]) => fs.map((f) => `${f.tier}:${f.path}`).sort();
const mk = (declaredBudget: Record<string, unknown>): DesiredResource => ({
  logicalId: 'CfnBudget',
  resourceType: 'AWS::Budgets::Budget',
  physicalId: 'my-budget',
  declared: { Budget: declaredBudget },
});

describe('#1676-followup FP1: readBudget omits the AWS-computed BudgetLimit for non-fixed budgets', () => {
  const budgets = mockClient(BudgetsClient);
  beforeEach(() => budgets.reset());
  const read = () =>
    SDK_OVERRIDES['AWS::Budgets::Budget']({
      physicalId: 'b',
      declared: { Budget: { BudgetName: 'b' } },
      region: 'us-east-1',
      accountId: '123456789012',
    });

  it('omits BudgetLimit + keeps a thin AutoAdjustData for an auto-adjusting budget', async () => {
    budgets.on(DescribeBudgetCommand).resolves({
      Budget: {
        BudgetName: 'b',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: '0.01', Unit: 'USD' }, // AWS-computed for an auto-adjust budget
        AutoAdjustData: {
          AutoAdjustType: 'HISTORICAL',
          HistoricalOptions: { BudgetAdjustmentPeriod: 2, LookBackAvailablePeriods: 2 },
          LastAutoAdjustTime: new Date('2026-07-21T00:00:00Z'),
        },
      },
    } as never);
    const out = (await read()) as { Budget: Record<string, unknown> };
    expect(out.Budget.BudgetLimit).toBeUndefined();
    expect(out.Budget.AutoAdjustData).toEqual({
      AutoAdjustType: 'HISTORICAL',
      HistoricalOptions: { BudgetAdjustmentPeriod: 2 }, // thin: computed LookBack/LastAutoAdjustTime dropped
    });
  });

  it('omits BudgetLimit for a time-phased (PlannedBudgetLimits) budget', async () => {
    budgets.on(DescribeBudgetCommand).resolves({
      Budget: {
        BudgetName: 'b',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: '100.0', Unit: 'USD' }, // AWS echoes the current period's planned amount
        PlannedBudgetLimits: { '1782864000': { Amount: '100.0', Unit: 'USD' } },
      },
    } as never);
    const out = (await read()) as { Budget: Record<string, unknown> };
    expect(out.Budget.BudgetLimit).toBeUndefined();
    expect(out.Budget.PlannedBudgetLimits).toEqual({
      '1782864000': { Amount: '100.0', Unit: 'USD' },
    });
  });

  it('KEEPS BudgetLimit for a plain FIXED budget (regression: do not over-omit)', async () => {
    budgets.on(DescribeBudgetCommand).resolves({
      Budget: {
        BudgetName: 'b',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: '100.0', Unit: 'USD' },
      },
    } as never);
    const out = (await read()) as { Budget: Record<string, unknown> };
    expect(out.Budget.BudgetLimit).toEqual({ Amount: '100.0', Unit: 'USD' });
  });
});

describe('#1676-followup FP2: numeric-string Budget amounts fold ("100" vs "100.0")', () => {
  const plannedDeclared = {
    BudgetName: 'my-budget',
    BudgetType: 'COST',
    TimeUnit: 'MONTHLY',
    // CDK stringifies Spend amounts even from numeric inputs.
    PlannedBudgetLimits: {
      '1782864000': { Amount: '100', Unit: 'USD' },
      '1785542400': { Amount: '200', Unit: 'USD' },
    },
  };
  const plannedLive = (aug: string): Record<string, unknown> => ({
    Budget: {
      BudgetName: 'my-budget',
      BudgetType: 'COST',
      TimeUnit: 'MONTHLY',
      PlannedBudgetLimits: {
        '1782864000': { Amount: '100.0', Unit: 'USD' },
        '1785542400': { Amount: aug, Unit: 'USD' },
      },
    },
  });

  it('a clean time-phased budget is CLEAN — every period folds (100=="100.0", 200=="200.0")', () => {
    const findings = classifyResource(mk(plannedDeclared), plannedLive('200.0'), emptySchema);
    expect(all(findings)).toEqual([]);
  });

  it('a genuine amount change (declared "200" vs live "500.0") STILL surfaces declared drift', () => {
    const findings = classifyResource(mk(plannedDeclared), plannedLive('500.0'), emptySchema);
    const declared = findings.filter((f) => f.tier === 'declared');
    expect(declared.map((f) => f.path)).toEqual(['Budget.PlannedBudgetLimits.1785542400.Amount']);
    // the unchanged period must NOT surface
    expect(findings.some((f) => f.path === 'Budget.PlannedBudgetLimits.1782864000.Amount')).toBe(
      false
    );
  });

  it('the top-level BudgetLimit.Amount folds for a raw-CFn STRING declaration too', () => {
    const findings = classifyResource(
      mk({
        BudgetName: 'b',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: '100', Unit: 'USD' },
      }),
      {
        Budget: {
          BudgetName: 'b',
          BudgetType: 'COST',
          TimeUnit: 'MONTHLY',
          BudgetLimit: { Amount: '100.0', Unit: 'USD' },
        },
      },
      emptySchema
    );
    expect(all(findings)).toEqual([]);
  });
});
