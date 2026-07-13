// #1566: a barest AWS::Glue::Job (only Role + Command.Name + Command.ScriptLocation declared)
// first-ran three [Potential Drift] entries (live 2026-07-13, us-east-1,
// CdkrdHuntGrabBag0713). These tests pin the folds per the fold-strategy decision order:
//   - Timeout — AWS MOVED the create-time default (2880-minute era → 480 for new jobs), so the
//     stale KNOWN_DEFAULTS constant becomes an era KNOWN_DEFAULT_ONE_OF {2880, 480};
//   - GlueVersion — the GA version AWS assigns and advances over time ("5.1" today) →
//     value-independent (tier 3);
//   - Command.PythonVersion — the vestigial stored constant "2" a glueetl job echoes when the
//     version is undeclared → nested equality-gated constant (KNOWN_DEFAULT_PATHS).
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
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

const pathsByTier = (findings: Finding[], tier: string) =>
  findings
    .filter((f) => f.tier === tier)
    .map((f) => f.path)
    .sort();

const res: DesiredResource = {
  logicalId: 'GlueJob',
  resourceType: 'AWS::Glue::Job',
  physicalId: 'GlueJob-abc123',
  declared: {
    Role: 'arn:aws:iam::111111111111:role/glue',
    Command: { Name: 'glueetl', ScriptLocation: 's3://bucket/script.py' },
  },
};

// The harvested live shape of the barest glueetl job (account id sanitized).
const live = (over: Record<string, unknown> = {}) => ({
  Role: 'arn:aws:iam::111111111111:role/glue',
  Command: { Name: 'glueetl', ScriptLocation: 's3://bucket/script.py', PythonVersion: '2' },
  Timeout: 480,
  GlueVersion: '5.1',
  MaxRetries: 0,
  ...over,
});

describe('#1566 Glue::Job barest first-run folds', () => {
  it('folds the full barest live shape to zero potential drift', () => {
    const f = classifyResource(res, live(), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
    expect(pathsByTier(f, 'atDefault')).toEqual(
      expect.arrayContaining(['Timeout', 'GlueVersion', 'Command.PythonVersion'])
    );
  });

  it('folds BOTH Timeout eras (2880 legacy, 480 current) via ONE_OF', () => {
    for (const timeout of [2880, 480]) {
      const f = classifyResource(res, live({ Timeout: timeout }), emptySchema);
      expect(pathsByTier(f, 'atDefault')).toContain('Timeout');
      expect(pathsByTier(f, 'undeclared')).toEqual([]);
    }
  });

  it('surfaces a THIRD out-of-band Timeout value (equality gate keeps detection)', () => {
    const f = classifyResource(res, live({ Timeout: 999 }), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual(['Timeout']);
  });

  it('folds any undeclared GlueVersion value-independently (AWS advances the GA version)', () => {
    for (const v of ['4.0', '5.0', '5.1', '6.0']) {
      const f = classifyResource(res, live({ GlueVersion: v }), emptySchema);
      expect(pathsByTier(f, 'atDefault')).toContain('GlueVersion');
      expect(pathsByTier(f, 'undeclared')).toEqual([]);
    }
  });

  it('still compares a DECLARED GlueVersion in the declared dimension', () => {
    const declaredRes: DesiredResource = {
      ...res,
      declared: { ...res.declared, GlueVersion: '4.0' },
    };
    const f = classifyResource(declaredRes, live({ GlueVersion: '5.1' }), emptySchema);
    expect(pathsByTier(f, 'declared')).toContain('GlueVersion');
  });

  it('#1569: folds the WorkerType/NumberOfWorkers sizing echo any UpdateJob materializes', () => {
    // The service normalizes capacity to the modern representation on EVERY UpdateJob
    // (including a CFn stack update), so the pair appears undeclared after any update.
    const f = classifyResource(
      res,
      live({ WorkerType: 'G.1X', NumberOfWorkers: 10, MaxCapacity: 10, AllocatedCapacity: 10 }),
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
    expect(pathsByTier(f, 'atDefault')).toEqual(
      expect.arrayContaining(['WorkerType', 'NumberOfWorkers'])
    );
  });

  it('#1569: a DECLARED WorkerType is still compared in the declared dimension', () => {
    const declaredRes: DesiredResource = {
      ...res,
      declared: { ...res.declared, WorkerType: 'G.2X', NumberOfWorkers: 4 },
    };
    const f = classifyResource(
      declaredRes,
      live({ WorkerType: 'G.1X', NumberOfWorkers: 10 }),
      emptySchema
    );
    expect(pathsByTier(f, 'declared')).toEqual(
      expect.arrayContaining(['NumberOfWorkers', 'WorkerType'])
    );
  });

  it('surfaces an out-of-band Command.PythonVersion change away from the "2" echo', () => {
    const f = classifyResource(
      res,
      live({
        Command: { Name: 'glueetl', ScriptLocation: 's3://bucket/script.py', PythonVersion: '3' },
      }),
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['Command.PythonVersion']);
  });
});
