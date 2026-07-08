// #755: the multi-stack `--json` output must be ONE valid JSON value for the whole
// invocation — a single top-level ARRAY with one element per stack — not the
// concatenated `{...}\n{...}` pretty-printed documents the old per-stack inline
// `report({ json: true })` produced (neither a single parseable value nor JSONL). An
// errored / skipped stack must still appear as an element (with an `error` field) so a
// consumer sees which stacks ran. These tests exercise the pure `buildStackJson` helper
// and the array-assembly contract the check loop uses.
import { describe, expect, it } from 'vite-plus/test';
import { buildStackJson, type StackJsonReport } from '../src/report/report.js';
import type { Finding } from '../src/types.js';

const F = (tier: Finding['tier'], path = 'P'): Finding => ({
  tier,
  logicalId: 'L',
  resourceType: 'AWS::X::Y',
  path,
  actual: 1,
});

// Mirror the check loop's --json assembly: collect one buildStackJson() object per
// checked stack, plus an { error } element for each errored/skipped stack, then
// serialize the whole array once.
function assembleJson(
  checked: { findings: Finding[]; header: string }[],
  errored: { stack: string; error: string }[] = []
): string {
  const reports: StackJsonReport[] = [
    ...checked.map((c) => buildStackJson(c.findings, c.header).json),
    ...errored.map((e) => ({ stack: e.stack, drifted: 0, findings: [], error: e.error })),
  ];
  return JSON.stringify(reports, null, 2);
}

describe('#755 multi-stack --json contract', () => {
  it('buildStackJson returns { stack, drifted, findings } + the matching exit code', () => {
    const { json, code } = buildStackJson([F('declared'), F('skipped')], 'stackA (us-east-1)');
    expect(json.stack).toBe('stackA (us-east-1)');
    expect(json.drifted).toBe(1); // declared is drift; skipped is not
    expect(json.findings).toHaveLength(2);
    expect(code).toBe(1);
    expect(json.error).toBeUndefined(); // a successfully-checked stack has no error field
  });

  it('an unrecorded value is not counted as drift (drifted excludes it)', () => {
    const u: Finding = { ...F('undeclared'), unrecorded: true };
    const { json, code } = buildStackJson([u], 'stackA (us-east-1)');
    expect(json.drifted).toBe(0);
    expect(code).toBe(0);
    expect(json.findings[0]?.unrecorded).toBe(true);
  });

  it('the multi-stack output is a SINGLE JSON.parse-able value — an array, one element per stack', () => {
    const combined = assembleJson([
      { findings: [F('declared')], header: 'stackA (us-east-1)' },
      { findings: [], header: 'stackB (us-east-1)' },
      { findings: [F('undeclared'), F('added')], header: 'stackC (us-west-2)' },
    ]);
    // The WHOLE stream parses as one value (the old concatenated {...}\n{...} did not).
    const parsed = JSON.parse(combined);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3); // one element per stack
    expect(parsed.map((r: StackJsonReport) => r.stack)).toEqual([
      'stackA (us-east-1)',
      'stackB (us-east-1)',
      'stackC (us-west-2)',
    ]);
    expect(parsed[0].drifted).toBe(1);
    expect(parsed[1].drifted).toBe(0);
    expect(parsed[2].drifted).toBe(2);
  });

  it('a single-stack run is still an array — of one — so JSON.parse always yields an array', () => {
    const parsed = JSON.parse(
      assembleJson([{ findings: [F('declared')], header: 'solo (us-east-1)' }])
    );
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].stack).toBe('solo (us-east-1)');
  });

  it('an errored / skipped stack still appears as an element, with an error marker', () => {
    const combined = assembleJson(
      [{ findings: [F('declared')], header: 'ok (us-east-1)' }],
      [{ stack: 'boom (us-east-1)', error: 'Access denied' }]
    );
    const parsed = JSON.parse(combined);
    expect(parsed).toHaveLength(2); // both the checked and the errored stack are present
    const boom = parsed.find((r: StackJsonReport) => r.stack === 'boom (us-east-1)');
    expect(boom).toBeDefined();
    expect(boom.error).toBe('Access denied'); // consumer sees WHICH stack failed
    expect(boom.drifted).toBe(0);
    expect(boom.findings).toEqual([]);
  });

  it('an empty run (no stacks reached) is an empty array — still valid JSON', () => {
    const parsed = JSON.parse(assembleJson([]));
    expect(parsed).toEqual([]);
  });
});
