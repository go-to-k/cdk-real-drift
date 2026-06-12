import { describe, expect, it } from 'vite-plus/test';
import type { BaselineFile } from '../src/baseline/baseline-file.js';
import { buildRevertPlan, toPatchDocument } from '../src/revert/plan.js';
import type { Finding, SchemaInfo } from '../src/types.js';

const schemaWithCreateOnly = (type: string, ...names: string[]): Map<string, SchemaInfo> =>
  new Map([
    [
      type,
      {
        readOnly: new Set<string>(),
        writeOnly: new Set<string>(),
        createOnly: new Set(names),
        readOnlyPaths: [],
        writeOnlyPaths: [],
        createOnlyPaths: names,
        defaults: {},
      },
    ],
  ]);

const F = (over: Partial<Finding>): Finding => ({
  tier: 'declared',
  logicalId: 'R',
  physicalId: 'phys-1',
  resourceType: 'AWS::S3::Bucket',
  path: 'VersioningConfiguration.Status',
  ...over,
});

const baseline = (accepted: BaselineFile['accepted']): BaselineFile => ({
  schemaVersion: 1,
  stackName: 's',
  region: 'r',
  accountId: '111122223333',
  capturedAt: '',
  templateHash: '',
  accepted,
});

describe('buildRevertPlan', () => {
  it('declared drift -> add op with the deployed-template (desired) value', () => {
    const plan = buildRevertPlan(
      [F({ tier: 'declared', desired: 'Enabled', actual: 'Suspended' })],
      undefined
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/VersioningConfiguration/Status',
      value: 'Enabled',
    });
  });

  it('undeclared drift with an accepted prior value -> add op restoring the baseline value', () => {
    const f = F({
      tier: 'undeclared',
      path: 'AccelerateConfiguration',
      actual: { AccelerationStatus: 'Enabled' },
    });
    const b = baseline([
      {
        logicalId: 'R',
        resourceType: 'AWS::S3::Bucket',
        path: 'AccelerateConfiguration',
        value: { AccelerationStatus: 'Suspended' },
      },
    ]);
    const plan = buildRevertPlan([f], b);
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/AccelerateConfiguration',
      value: { AccelerationStatus: 'Suspended' },
    });
  });

  it('undeclared drift NOT in baseline (new addition) -> remove op', () => {
    const f = F({ tier: 'undeclared', path: 'OwnershipControls', actual: { Rules: [] } });
    const plan = buildRevertPlan([f], baseline([]));
    expect(plan.items[0]!.ops[0]).toMatchObject({ op: 'remove', path: '/OwnershipControls' });
    expect(plan.items[0]!.ops[0]).not.toHaveProperty('value');
  });

  it('undeclared drift with NO baseline -> notRevertable (refuse destructive bulk remove)', () => {
    const f = F({ tier: 'undeclared', path: 'OwnershipControls', actual: { Rules: [] } });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(1);
    expect(plan.notRevertable[0]!.reason).toContain('no baseline');
  });

  it('--remove-unaccepted re-enables the remove op on a no-baseline stack', () => {
    const f = F({ tier: 'undeclared', path: 'OwnershipControls', actual: { Rules: [] } });
    const plan = buildRevertPlan([f], undefined, { removeUnaccepted: true });
    expect(plan.items[0]!.ops[0]).toMatchObject({ op: 'remove', path: '/OwnershipControls' });
  });

  it('declared drift is still revertable with no baseline (template is its source)', () => {
    const f = F({ tier: 'declared', desired: 'Enabled', actual: 'Suspended' });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items).toHaveLength(1);
    expect(plan.notRevertable).toHaveLength(0);
  });

  it('removed-undeclared (baseline value gone) -> re-add the baseline value', () => {
    const f = F({
      tier: 'undeclared',
      path: 'Tags',
      desired: [{ Key: 'team', Value: 'x' }],
      actual: undefined,
    });
    const plan = buildRevertPlan([f], baseline([]));
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/Tags',
      value: [{ Key: 'team', Value: 'x' }],
    });
  });

  it('non-drift tiers skipped; writer-less CC-gap type + no-physid not revertable', () => {
    const plan = buildRevertPlan(
      [
        F({ tier: 'readGap' }),
        F({ tier: 'unresolved' }),
        F({ tier: 'declared', resourceType: 'AWS::Budgets::Budget', desired: {} }), // CC-gap, no SDK writer
        F({ tier: 'declared', physicalId: undefined, desired: 'x' }),
      ],
      undefined
    );
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable.map((n) => n.reason)).toEqual([
      expect.stringContaining('not revertable'),
      expect.stringContaining('no physical id'),
    ]);
  });

  it('a CC-gap type WITH an SDK writer (BucketPolicy) is revertable via kind=sdk', () => {
    const plan = buildRevertPlan(
      [
        F({
          tier: 'declared',
          resourceType: 'AWS::S3::BucketPolicy',
          path: 'PolicyDocument',
          desired: { Version: '2012-10-17' },
        }),
      ],
      undefined
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('sdk');
  });

  it('IAM ManagedPolicy now has an SDK writer -> revertable via kind=sdk', () => {
    const plan = buildRevertPlan(
      [
        F({
          tier: 'declared',
          resourceType: 'AWS::IAM::ManagedPolicy',
          physicalId: 'arn:aws:iam::123456789012:policy/p',
          path: 'PolicyDocument',
          desired: { Version: '2012-10-17' },
        }),
      ],
      undefined
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('sdk');
  });

  it('Lambda Permission + Budgets Budget stay not-revertable (no SDK writer)', () => {
    const plan = buildRevertPlan(
      [
        F({ tier: 'declared', resourceType: 'AWS::Lambda::Permission', desired: {} }),
        F({ tier: 'declared', resourceType: 'AWS::Budgets::Budget', desired: {} }),
      ],
      undefined
    );
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(2);
    for (const n of plan.notRevertable) expect(n.reason).toContain('not revertable');
  });

  it('R35: undeclared create-only drift on a NO-baseline stack -> reason is no-baseline (accept is the route)', () => {
    // the fundamental blocker is "no revert target" — a create-only reason would
    // mis-direct the user toward replacement when `accept` records the value into the baseline
    const plan = buildRevertPlan(
      [F({ tier: 'undeclared', path: 'BucketName', actual: 'b' })],
      undefined,
      { schemas: schemaWithCreateOnly('AWS::S3::Bucket', 'BucketName') }
    );
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable[0]!.reason).toContain('no baseline');
  });

  it('R35: undeclared create-only drift WITH a baseline -> create-only reason still applies', () => {
    const plan = buildRevertPlan(
      [F({ tier: 'undeclared', path: 'BucketName', actual: 'b' })],
      baseline([]),
      { schemas: schemaWithCreateOnly('AWS::S3::Bucket', 'BucketName') }
    );
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable[0]!.reason).toContain('create-only');
  });

  it('create-only declared drift -> notRevertable (needs replacement, not a patch)', () => {
    const plan = buildRevertPlan(
      [F({ tier: 'declared', path: 'BucketName', desired: 'a', actual: 'b' })],
      undefined,
      { schemas: schemaWithCreateOnly('AWS::S3::Bucket', 'BucketName') }
    );
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable[0]!.reason).toContain('create-only');
  });

  it('a nested path under a create-only top-level segment is still blocked', () => {
    const plan = buildRevertPlan(
      [F({ tier: 'declared', path: 'BucketName.Sub', desired: 'a', actual: 'b' })],
      undefined,
      { schemas: schemaWithCreateOnly('AWS::S3::Bucket', 'BucketName') }
    );
    expect(plan.notRevertable[0]!.reason).toContain('create-only');
  });

  it('non-create-only declared drift still plans an op when a schema is present', () => {
    const plan = buildRevertPlan(
      [F({ tier: 'declared', path: 'VersioningConfiguration.Status', desired: 'Enabled' })],
      undefined,
      { schemas: schemaWithCreateOnly('AWS::S3::Bucket', 'BucketName') }
    );
    expect(plan.items).toHaveLength(1);
  });

  it('deleted finding -> notRevertable (recreate via cdk deploy), never a patch op', () => {
    const plan = buildRevertPlan(
      [F({ tier: 'deleted', path: '', desired: undefined, actual: undefined })],
      undefined
    );
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(1);
    expect(plan.notRevertable[0]!.reason).toContain('deleted');
  });

  it('groups multiple ops on the same resource + serializes a valid patch document', () => {
    const plan = buildRevertPlan(
      [
        F({ tier: 'declared', path: 'A', desired: 1 }),
        F({ tier: 'declared', path: 'B.0', desired: 2 }),
      ],
      undefined
    );
    expect(plan.items).toHaveLength(1);
    expect(JSON.parse(toPatchDocument(plan.items[0]!))).toEqual([
      { op: 'add', path: '/A', value: 1 },
      { op: 'add', path: '/B/0', value: 2 },
    ]);
  });
});
