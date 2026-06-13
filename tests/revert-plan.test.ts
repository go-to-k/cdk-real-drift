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

  it('appeared-since-accept undeclared drift (entry-less, NOT unrecorded) -> remove op', () => {
    // applyBaseline leaves a finding untagged only when its resource is
    // snapshot-complete — restoring the snapshot means removing the addition.
    const f = F({ tier: 'undeclared', path: 'OwnershipControls', actual: { Rules: [] } });
    const plan = buildRevertPlan([f], baseline([]));
    expect(plan.items[0]!.ops[0]).toMatchObject({ op: 'remove', path: '/OwnershipControls' });
    expect(plan.items[0]!.ops[0]).not.toHaveProperty('value');
  });

  it('UNRECORDED undeclared value -> notRevertable (refuse destructive bulk remove, R62)', () => {
    const f = F({
      tier: 'undeclared',
      path: 'OwnershipControls',
      actual: { Rules: [] },
      unrecorded: true,
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(1);
    expect(plan.notRevertable[0]!.reason).toContain('unrecorded');
  });

  it('--remove-unaccepted re-enables the remove op for unrecorded values', () => {
    const f = F({
      tier: 'undeclared',
      path: 'OwnershipControls',
      actual: { Rules: [] },
      unrecorded: true,
    });
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

  it('R78: an ELB attribute-bag drift routes to kind=sdk and carries attributeKey on the op', () => {
    const plan = buildRevertPlan(
      [
        F({
          tier: 'declared',
          resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
          physicalId: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/x/abc',
          path: 'LoadBalancerAttributes',
          attributeKey: 'idle_timeout.timeout_seconds',
          desired: '120',
          actual: '300',
        }),
      ],
      undefined
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('sdk');
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      attributeKey: 'idle_timeout.timeout_seconds',
      value: '120',
    });
  });

  it('R78: two attribute drifts on one LB collapse into ONE sdk item with two ops', () => {
    const lb = (attributeKey: string, desired: string): Finding =>
      F({
        tier: 'declared',
        resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        physicalId: 'arn:...:loadbalancer/app/x/abc',
        path: 'LoadBalancerAttributes',
        attributeKey,
        desired,
      });
    const plan = buildRevertPlan(
      [lb('idle_timeout.timeout_seconds', '120'), lb('deletion_protection.enabled', 'false')],
      undefined
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.ops.map((o) => o.attributeKey)).toEqual([
      'idle_timeout.timeout_seconds',
      'deletion_protection.enabled',
    ]);
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

  it('R35: UNRECORDED create-only value -> reason is unrecorded (accept is the route)', () => {
    // the fundamental blocker is "no revert target" — a create-only reason would
    // mis-direct the user toward replacement when `accept` records the value into the baseline
    const plan = buildRevertPlan(
      [F({ tier: 'undeclared', path: 'BucketName', actual: 'b', unrecorded: true })],
      undefined,
      { schemas: schemaWithCreateOnly('AWS::S3::Bucket', 'BucketName') }
    );
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable[0]!.reason).toContain('unrecorded');
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

describe('property-scoped SDK writer routing (IAM Role inline Policies)', () => {
  const POLICIES = [{ PolicyName: 'rogue', PolicyDocument: { Version: '2012-10-17' } }];
  const roleFinding = (over: Partial<Finding> = {}): Finding =>
    F({
      tier: 'undeclared',
      resourceType: 'AWS::IAM::Role',
      path: 'Policies',
      actual: POLICIES,
      ...over,
    });

  it('an exact Policies finding on a role routes to kind=sdk and the remove op carries prior', () => {
    const plan = buildRevertPlan([roleFinding()], baseline([]));
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('sdk');
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'remove',
      path: '/Policies',
      prior: POLICIES,
    });
  });

  it('an accepted Policies finding -> add op with the baseline value AND prior (current live subset)', () => {
    const baselineValue = [{ PolicyName: 'rogue', PolicyDocument: { Version: 'old' } }];
    const plan = buildRevertPlan(
      [roleFinding()],
      baseline([
        { logicalId: 'R', resourceType: 'AWS::IAM::Role', path: 'Policies', value: baselineValue },
      ])
    );
    expect(plan.items[0]!.kind).toBe('sdk');
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/Policies',
      value: baselineValue,
      prior: POLICIES,
    });
  });

  it('a DEEP declared Policies path on a role still goes through Cloud Control (kind=cc)', () => {
    const plan = buildRevertPlan(
      [
        F({
          tier: 'declared',
          resourceType: 'AWS::IAM::Role',
          path: 'Policies.0.PolicyDocument',
          desired: { Version: '2012-10-17' },
        }),
      ],
      undefined
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('cc');
  });

  it('mixed findings on one role split into a cc item and an sdk item', () => {
    const plan = buildRevertPlan(
      [
        F({
          tier: 'declared',
          resourceType: 'AWS::IAM::Role',
          path: 'Description',
          desired: 'x',
          actual: 'y',
        }),
        roleFinding(),
      ],
      baseline([])
    );
    expect(plan.items).toHaveLength(2);
    expect(plan.items.map((i) => i.kind).sort()).toEqual(['cc', 'sdk']);
    // the cc patch document never serializes `prior`
    const cc = plan.items.find((i) => i.kind === 'cc')!;
    expect(toPatchDocument(cc)).not.toContain('prior');
  });

  it('prior is never serialized into the Cloud Control patch document', () => {
    const item = {
      logicalId: 'R',
      displayId: 'R',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'p',
      kind: 'cc' as const,
      ops: [
        { op: 'remove' as const, path: '/X', prior: ['secret'], human: 'X -> remove' },
        { op: 'add' as const, path: '/Y', value: 1, prior: 2, human: 'Y -> add' },
      ],
    };
    expect(toPatchDocument(item)).toBe(
      '[{"op":"remove","path":"/X"},{"op":"add","path":"/Y","value":1}]'
    );
  });
});
