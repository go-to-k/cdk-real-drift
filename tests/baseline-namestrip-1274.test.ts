import { describe, expect, it } from 'vite-plus/test';
import {
  applyBaseline,
  type BaselineFile,
  baselineOnlyEntries,
} from '../src/baseline/baseline-file.js';

// #1274: the SECOND upgrade-asymmetry mechanism of #766 (PR #1205 fixed only the value-level
// re-canonicalization one). A managed-timestamp NAME VARIANT (`CreateTime`, `UpdateTime`,
// `ModifiedAt`, an #915/#1251 variant) once surfaced as an undeclared first-run FP, so the
// user did the natural thing — `cdkrd record` — blessing it into the git baseline. A later
// cdkrd now name-strips that key from the live model BEFORE classify, so there is NO finding
// at that path: applyBaseline's removed-since-record loop would SYNTHESIZE a false "baseline
// value removed since record" drift (CI --fail red on a PURE upgrade — nothing changed in AWS
// or the template) whose payload carries a physicalId + desired, so `revert` offers to write
// the STALE timestamp back to AWS. The fix folds such entries into the stale-baseline nudge
// instead. FREE_FORM_MAP_PARENTS ancestry must be honored: a USER key literally named
// `CreateTime` inside a free-form map is real data whose removal IS a real change.

function baseline(recorded: BaselineFile['recorded']): BaselineFile {
  return {
    schemaVersion: 1,
    stackName: 's',
    region: 'r',
    accountId: '111122223333',
    capturedAt: '',
    templateHash: '',
    recorded,
  };
}

describe('#1274 name-stripped recorded path folds into the stale-baseline nudge', () => {
  it('does NOT synthesize a "removed since record" drift for a top-level managed-timestamp-name path', () => {
    // `CreateTime` — a managed-timestamp NAME VARIANT (#915) recorded on an OLD cdkrd, now
    // name-stripped before classify → absent from currentPaths on the upgraded run.
    const b = baseline([
      {
        logicalId: 'Fn',
        resourceType: 'AWS::Lambda::Function',
        path: 'CreateTime',
        value: '2024-01-01T00:00:00Z',
      },
    ]);
    const warnings: string[] = [];
    const out = applyBaseline([], b, {
      physicalIdByLogical: new Map([['Fn', 'phys-1']]),
      warn: (m) => warnings.push(m),
    });
    // No synthetic drift finding, and specifically NO stale-timestamp revert target.
    expect(out).toHaveLength(0);
    expect(out.some((f) => f.note === 'baseline value removed since record')).toBe(false);
    // Folded into the "re-run `cdkrd record`" nudge instead.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('re-run `cdkrd record`');
    expect(warnings[0]).toContain('Fn.CreateTime');
  });

  it('also folds an exact ALWAYS_STRIPPED name (RevisionId)', () => {
    const b = baseline([
      { logicalId: 'R', resourceType: 'AWS::X::Y', path: 'RevisionId', value: 'abc123' },
    ]);
    const warnings: string[] = [];
    const out = applyBaseline([], b, { warn: (m) => warnings.push(m) });
    expect(out).toHaveLength(0);
    expect(warnings[0]).toContain('re-run `cdkrd record`');
  });

  it('STILL surfaces a real removal of a USER key named `CreateTime` inside a free-form map', () => {
    // `Environment.Variables.CreateTime` — the leaf collides with a managed name, but it lives
    // under a FREE_FORM_MAP_PARENT (`Variables`), so it is genuine user data. Its disappearance
    // is a real out-of-band removal and MUST still surface (detection preserved).
    const b = baseline([
      {
        logicalId: 'Fn',
        resourceType: 'AWS::Lambda::Function',
        path: 'Environment.Variables.CreateTime',
        value: 'user-value',
      },
    ]);
    const warnings: string[] = [];
    const out = applyBaseline([], b, {
      // `Environment` is declared with a DIFFERENT var, so the path does not resolve (not
      // promoted) — it is a genuine removal.
      declaredByLogical: new Map([['Fn', { Environment: { Variables: { OTHER: 'y' } } }]]),
      physicalIdByLogical: new Map([['Fn', 'phys-1']]),
      warn: (m) => warnings.push(m),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      tier: 'undeclared',
      path: 'Environment.Variables.CreateTime',
      desired: 'user-value',
      note: 'baseline value removed since record',
    });
    expect(warnings.some((w) => w.includes('re-run `cdkrd record`'))).toBe(false);
  });

  it('STILL surfaces a normal declared property removed since record (no over-fold)', () => {
    // `MemorySize` is not a name-stripped field, so a genuine removal must still surface.
    const b = baseline([
      { logicalId: 'Fn', resourceType: 'AWS::Lambda::Function', path: 'MemorySize', value: 512 },
    ]);
    const out = applyBaseline([], b, { physicalIdByLogical: new Map([['Fn', 'phys-1']]) });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      path: 'MemorySize',
      desired: 512,
      note: 'baseline value removed since record',
    });
  });

  it('baselineOnlyEntries does NOT offer a name-stripped entry as a drop-candidate', () => {
    const b = baseline([
      {
        logicalId: 'Fn',
        resourceType: 'AWS::Lambda::Function',
        path: 'CreateTime',
        value: '2024-01-01T00:00:00Z',
      },
      // a real value that IS gone -> still a drop-candidate (control)
      { logicalId: 'Fn', resourceType: 'AWS::Lambda::Function', path: 'MemorySize', value: 512 },
    ]);
    // recorded (this run) = [] -> both entries are absent; only the real one is a drop-candidate.
    const out = baselineOnlyEntries([], b, []);
    expect(out.map((e) => e.path)).toEqual(['MemorySize']);
  });
});
