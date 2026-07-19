// Budgets CostTypes all-false off-flip (the #1092 GuardDuty DataSources / #1635 S3
// PublicAccessBlockConfiguration all-boolean-object class, on the #1658 pins).
//
// An out-of-band `update-budget` disabling ALL nine Include* cost types on a budget
// that does NOT declare CostTypes reads back an all-false object: the whole-object
// `Budget.CostTypes` pin equality breaks, but the all-false object is trivially empty,
// so isTrivialEmpty swallowed it in emitNested before the pin gate — the budget then
// measures almost nothing and the gutting was invisible. Live-proven 2026-07-20
// (us-east-1, budget-scope fixture): DescribeBudget RETURNS the all-false object (it
// does not vanish from the read), and `check --fail` stayed CLEAN. Fixed by the
// MEANINGFUL_WHEN_OFF_NESTED['AWS::Budgets::Budget']['Budget.CostTypes'] gate.
//
// Replays the harvested AWS__Budgets__Budget.MonthlyCost corpus case with the current
// reader's full 11-boolean CostTypes projection synthesized into liveRaw (the case was
// harvested under the pre-#1658 thin projection).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import {
  type CorpusCase,
  decodeUnresolved,
  reviveOpts,
  reviveSchema,
} from '../src/corpus/record.js';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource } from '../src/types.js';

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), 'corpus');

// The full CostTypes object DescribeBudget returns for a fresh budget (live-observed
// 2026-07-20): nine Include* members true, the two Use* members false.
const fullCostTypes = (over: Record<string, boolean>) => ({
  IncludeTax: true,
  IncludeSubscription: true,
  IncludeRefund: true,
  IncludeCredit: true,
  IncludeUpfront: true,
  IncludeRecurring: true,
  IncludeOtherSubscription: true,
  IncludeSupport: true,
  IncludeDiscount: true,
  UseBlended: false,
  UseAmortized: false,
  ...over,
});

const ALL_OFF = {
  IncludeTax: false,
  IncludeSubscription: false,
  IncludeRefund: false,
  IncludeCredit: false,
  IncludeUpfront: false,
  IncludeRecurring: false,
  IncludeOtherSubscription: false,
  IncludeSupport: false,
  IncludeDiscount: false,
};

const loadCase = () => {
  const c = JSON.parse(
    readFileSync(join(corpusDir, 'AWS__Budgets__Budget.MonthlyCost.json'), 'utf8')
  ) as CorpusCase;
  const resource = {
    ...c.resource,
    declared: decodeUnresolved(c.resource.declared),
  } as DesiredResource;
  return { c, resource };
};

const classifyWithCostTypes = (over: Record<string, boolean>) => {
  const { c, resource } = loadCase();
  const live = structuredClone(c.liveRaw) as Record<string, unknown>;
  (live.Budget as Record<string, unknown>).CostTypes = fullCostTypes(over);
  return classifyResource(resource, live, reviveSchema(c.schema), reviveOpts(c.opts));
};

describe('Budgets CostTypes all-boolean off-flip', () => {
  it("a fresh budget's full-default CostTypes still folds (no CostTypes drift)", () => {
    const got = classifyWithCostTypes({});
    const drift = got.filter(
      (f) =>
        (f.tier === 'undeclared' || f.tier === 'declared') && String(f.path).includes('CostTypes')
    );
    expect(drift).toEqual([]);
  });

  it('a single out-of-band off-flip surfaces (regression guard for the non-trivial shape)', () => {
    const got = classifyWithCostTypes({ IncludeTax: false });
    const hits = got.filter((f) => f.tier === 'undeclared' && String(f.path).includes('CostTypes'));
    expect(hits.length).toBeGreaterThan(0);
  });

  it('the ALL-false off-flip surfaces instead of being swallowed as trivially empty (FN fix)', () => {
    const got = classifyWithCostTypes(ALL_OFF);
    const hits = got.filter((f) => f.tier === 'undeclared' && String(f.path).includes('CostTypes'));
    expect(hits.length).toBeGreaterThan(0);
  });
});
