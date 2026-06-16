import { describe, expect, it } from 'vite-plus/test';
import type { BaselineFile } from '../src/baseline/baseline-file.js';
import { UNRESOLVED } from '../src/normalize/intrinsic-resolver.js';
import {
  buildRevertPlan,
  type PatchOp,
  tagPreservingOps,
  toPatchDocument,
  writeOnlyReincludeOps,
} from '../src/revert/plan.js';
import type { Finding, SchemaInfo } from '../src/types.js';

const schemaWithWriteOnly = (...names: string[]): SchemaInfo => ({
  readOnly: new Set<string>(),
  writeOnly: new Set(names),
  createOnly: new Set<string>(),
  readOnlyPaths: [],
  writeOnlyPaths: names,
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
});

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
        defaultPaths: {},
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

const baseline = (recorded: BaselineFile['recorded']): BaselineFile => ({
  schemaVersion: 1,
  stackName: 's',
  region: 'r',
  accountId: '111122223333',
  capturedAt: '',
  templateHash: '',
  recorded,
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

  it('declared drift carries the live value as `prior` (per-entry SDK writers need it)', () => {
    // A declared /Policies drift on an IAM Role (a rogue inline policy added out of
    // band → whole-array drift) must carry the live array as `prior` so
    // writeIamRoleInlinePolicies can DELETE the rogue entry, not just re-PUT the
    // declared ones. Before the fix the declared op had no `prior` → silent incomplete
    // revert (the rogue policy survived).
    const declaredPolicies = [{ PolicyName: 'P', PolicyDocument: { Statement: [] } }];
    const livePolicies = [
      { PolicyName: 'P', PolicyDocument: { Statement: [] } },
      { PolicyName: 'rogue', PolicyDocument: { Statement: [] } },
    ];
    const f = F({
      tier: 'declared',
      resourceType: 'AWS::IAM::Role',
      path: 'Policies',
      desired: declaredPolicies,
      actual: livePolicies,
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items[0]!.kind).toBe('sdk');
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/Policies',
      value: declaredPolicies,
      prior: livePolicies,
    });
  });

  it('undeclared drift with an recorded prior value -> add op restoring the baseline value', () => {
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

  it('appeared-since-record undeclared drift (entry-less, NOT unrecorded) -> remove op', () => {
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

  it('--remove-unrecorded re-enables the remove op for unrecorded values', () => {
    const f = F({
      tier: 'undeclared',
      path: 'OwnershipControls',
      actual: { Rules: [] },
      unrecorded: true,
    });
    const plan = buildRevertPlan([f], undefined, { removeUnrecorded: true });
    expect(plan.items[0]!.ops[0]).toMatchObject({ op: 'remove', path: '/OwnershipControls' });
  });

  it('declared drift is still revertable with no baseline (template is its source)', () => {
    const f = F({ tier: 'declared', desired: 'Enabled', actual: 'Suspended' });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items).toHaveLength(1);
    expect(plan.notRevertable).toHaveLength(0);
  });

  it('an `added` resource -> a `delete`-kind item keyed on its CC identifier', () => {
    const f = F({
      tier: 'added',
      logicalId: 'Api/abc|root|ANY',
      physicalId: 'abc|root|ANY',
      resourceType: 'AWS::ApiGateway::Method',
      path: '',
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      kind: 'delete',
      physicalId: 'abc|root|ANY',
      resourceType: 'AWS::ApiGateway::Method',
    });
    // single pseudo-op carrying the human label, never serialized to a patch
    expect(plan.items[0]!.ops).toHaveLength(1);
    expect(plan.items[0]!.ops[0]!.human).toContain('DELETE');
  });

  it('an `added` finding with no physical id -> notRevertable (cannot address the delete)', () => {
    const f = F({ tier: 'added', logicalId: 'X/y', physicalId: undefined, path: '' });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable[0]!.reason).toContain('no physical id');
  });

  it('PR4: an UNRECORDED `added` resource is guarded out of the default plan (no auto-delete)', () => {
    const f = F({
      tier: 'added',
      logicalId: 'Api/abc|root|ANY',
      physicalId: 'abc|root|ANY',
      resourceType: 'AWS::ApiGateway::Method',
      path: '',
      unrecorded: true,
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable[0]!.reason).toContain('unrecorded');
    expect(plan.notRevertable[0]!.reason).toContain('--remove-unrecorded');
  });

  it('PR4: --remove-unrecorded turns an unrecorded `added` resource into a DELETE item', () => {
    const f = F({
      tier: 'added',
      logicalId: 'Api/abc|root|ANY',
      physicalId: 'abc|root|ANY',
      resourceType: 'AWS::ApiGateway::Method',
      path: '',
      unrecorded: true,
    });
    const plan = buildRevertPlan([f], undefined, { removeUnrecorded: true });
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items[0]).toMatchObject({ kind: 'delete', physicalId: 'abc|root|ANY' });
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

  it('R35: UNRECORDED create-only value -> reason is unrecorded (record is the route)', () => {
    // the fundamental blocker is "no revert target" — a create-only reason would
    // mis-direct the user toward replacement when `record` records the value into the baseline
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

  it('a NESTED create-only path (parent mutable) is notRevertable, not a doomed in-place patch', () => {
    // ECR EncryptionConfiguration is mutable but EncryptionConfiguration.KmsKey is
    // create-only; the top-level-only check missed it and built a patch AWS rejects at
    // apply time. createOnlyPaths carries the nested path; isUnderCreateOnly catches it.
    const ecr = (...paths: string[]) => schemaWithCreateOnly('AWS::ECR::Repository', ...paths);
    const drift = (path: string) =>
      buildRevertPlan(
        [
          F({
            resourceType: 'AWS::ECR::Repository',
            tier: 'declared',
            path,
            desired: 'a',
            actual: 'b',
          }),
        ],
        undefined,
        { schemas: ecr('EncryptionConfiguration.KmsKey') }
      );
    expect(drift('EncryptionConfiguration.KmsKey').notRevertable[0]!.reason).toContain(
      'create-only'
    );
    expect(drift('EncryptionConfiguration.KmsKey').items).toHaveLength(0);
    // a SIBLING nested path that is NOT create-only still plans a revert op
    expect(drift('EncryptionConfiguration.RegistryId').items).toHaveLength(1);
  });

  it('a wildcard nested create-only path matches an array-index finding path', () => {
    // EFS AccessPoint PosixUser.* (and a `Foo.*.Bar` array form) are create-only
    const efs = schemaWithCreateOnly('AWS::EFS::AccessPoint', 'PosixUser.*', 'Tags.*.Key');
    const plan = (path: string) =>
      buildRevertPlan(
        [
          F({
            resourceType: 'AWS::EFS::AccessPoint',
            tier: 'declared',
            path,
            desired: 'a',
            actual: 'b',
          }),
        ],
        undefined,
        { schemas: efs }
      );
    expect(plan('PosixUser.Uid').notRevertable[0]!.reason).toContain('create-only');
    expect(plan('Tags.0.Key').notRevertable[0]!.reason).toContain('create-only'); // numeric index aligns with *
    expect(plan('Tags.0.Value').items).toHaveLength(1); // .Value is not under the create-only Key path
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

  it('an recorded Policies finding -> add op with the baseline value AND prior (current live subset)', () => {
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

describe('buildRevertPlan — nested undeclared is not revertable (R99)', () => {
  it('R98 identity-keyed array-element nested value (recorded then changed) -> notRevertable, never a malformed pointer', () => {
    // path `Origins[id].ConnectionTimeout` would become the bogus pointer
    // `/Origins[id]/ConnectionTimeout` (bracket is not RFC6902) if it reached revertOp.
    const f = F({
      tier: 'undeclared',
      resourceType: 'AWS::CloudFront::Distribution',
      path: 'DistributionConfig.Origins[o1].ConnectionTimeout',
      actual: 60,
      nested: true,
    });
    const b = baseline([
      {
        logicalId: 'R',
        resourceType: 'AWS::CloudFront::Distribution',
        path: 'DistributionConfig.Origins[o1].ConnectionTimeout',
        value: 10,
      },
    ]);
    const plan = buildRevertPlan([f], b);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(1);
    expect(plan.notRevertable[0]!.reason).toContain('nested undeclared');
  });

  it('R96 dotted object-nested value -> notRevertable (fragile deep patch)', () => {
    const f = F({ tier: 'undeclared', path: 'Conf.Destination', actual: 's3', nested: true });
    const b = baseline([
      { logicalId: 'R', resourceType: 'AWS::S3::Bucket', path: 'Conf.Destination', value: 'old' },
    ]);
    const plan = buildRevertPlan([f], b);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable[0]!.reason).toContain('nested undeclared');
  });

  it('nested guard fires by PATH SHAPE even without the flag (baseline value removed since record)', () => {
    // applyBaseline reconstructs a "removed since record" finding WITHOUT Finding.nested
    // (baseline-file.ts), but it keeps the nested path — the path-shape guard still catches it.
    const f = F({
      tier: 'undeclared',
      path: 'DistributionConfig.Origins[o1].ConnectionTimeout',
      desired: 10,
      actual: undefined,
    });
    const plan = buildRevertPlan([f], baseline([]));
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable[0]!.reason).toContain('nested undeclared');
  });

  it('--remove-unrecorded does NOT override the nested guard', () => {
    const f = F({
      tier: 'undeclared',
      path: 'Conf.Destination',
      actual: 's3',
      nested: true,
      unrecorded: true,
    });
    const plan = buildRevertPlan([f], baseline([]), { removeUnrecorded: true });
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable[0]!.reason).toContain('nested undeclared');
  });

  it('a TOP-LEVEL undeclared value (single-key path) is still revertable — guard does not over-fire', () => {
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
    expect(plan.items).toHaveLength(1);
    expect(plan.notRevertable).toHaveLength(0);
  });

  it('a DECLARED drift with a dotted path is still revertable (guard is scoped to undeclared)', () => {
    const plan = buildRevertPlan(
      [
        F({
          tier: 'declared',
          path: 'VersioningConfiguration.Status',
          desired: 'Enabled',
          actual: 'Suspended',
        }),
      ],
      undefined
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.notRevertable).toHaveLength(0);
  });
});

describe('writeOnlyReincludeOps (Cloud Control read-modify-write contract, cdkd #812)', () => {
  const declared = { DesiredCount: 0, VolumeConfigurations: [{ Name: 'ebs-data' }] };
  const schema = schemaWithWriteOnly('VolumeConfigurations');

  it('re-includes a declared write-only top-level prop the patch does not touch', () => {
    const ops = writeOnlyReincludeOps(declared, schema, [
      { op: 'add', path: '/DesiredCount', value: 0, human: '' },
    ]);
    expect(ops).toEqual([
      {
        op: 'add',
        path: '/VolumeConfigurations',
        value: [{ Name: 'ebs-data' }],
        human:
          'VolumeConfigurations -> re-include write-only (Cloud Control read-modify-write contract)',
      },
    ]);
  });

  it('does NOT duplicate a write-only prop the patch already targets', () => {
    const ops = writeOnlyReincludeOps(declared, schema, [
      { op: 'add', path: '/VolumeConfigurations', value: [], human: '' },
    ]);
    expect(ops).toEqual([]);
  });

  it('skips an UNRESOLVED write-only value (cannot send a sentinel)', () => {
    const ops = writeOnlyReincludeOps({ VolumeConfigurations: UNRESOLVED }, schema, []);
    expect(ops).toEqual([]);
  });

  it('skips a write-only value that contains a nested UNRESOLVED intrinsic', () => {
    const ops = writeOnlyReincludeOps(
      { VolumeConfigurations: [{ Name: 'x', RoleArn: UNRESOLVED }] },
      schema,
      []
    );
    expect(ops).toEqual([]);
  });

  it('ignores declared props that are NOT write-only', () => {
    const ops = writeOnlyReincludeOps({ DesiredCount: 0 }, schema, []);
    expect(ops).toEqual([]);
  });

  it('no-op when schema has no write-only props, or declared/schema missing', () => {
    expect(writeOnlyReincludeOps(declared, schemaWithWriteOnly(), [])).toEqual([]);
    expect(writeOnlyReincludeOps(undefined, schema, [])).toEqual([]);
    expect(writeOnlyReincludeOps(declared, undefined, [])).toEqual([]);
  });
});

describe('tagPreservingOps (revert must not strip aws:* managed tags — the SNS Topic bug)', () => {
  const op = (over: Partial<PatchOp>): PatchOp => ({
    op: 'remove',
    path: '/Tags',
    human: 'h',
    ...over,
  });
  // the live model as Cloud Control returns it: the user-added tag PLUS the managed tags
  const liveWithManaged = {
    Tags: [
      { Key: 'aws:cloudformation:stack-name', Value: 'S' },
      { Key: 'TestAddedTag', Value: 'TestAddedTagAAA' },
      { Key: 'aws:cloudformation:logical-id', Value: 'Topic' },
    ],
  };

  it('rewrites a bare `remove /Tags` into an `add /Tags` carrying ONLY the live aws:* tags', () => {
    // the reproducing case: removing the out-of-band user tag must KEEP the managed tags,
    // else Cloud Control tells SNS to untag aws:* keys -> "aws: prefixed tag key names are
    // not allowed for external use".
    const [out] = tagPreservingOps(
      [op({ op: 'remove', prior: [{ Key: 'TestAddedTag' }] })],
      liveWithManaged
    );
    expect(out).toMatchObject({
      op: 'add',
      path: '/Tags',
      value: [
        { Key: 'aws:cloudformation:stack-name', Value: 'S' },
        { Key: 'aws:cloudformation:logical-id', Value: 'Topic' },
      ],
      prior: [{ Key: 'TestAddedTag' }],
    });
    // the user tag is gone; no aws:* key is ever in a removal position
    expect((out!.value as { Key: string }[]).some((t) => t.Key === 'TestAddedTag')).toBe(false);
  });

  it('an `add /Tags` (restore/declared) keeps its user value AND re-attaches the live aws:* tags', () => {
    const [out] = tagPreservingOps(
      [op({ op: 'add', value: [{ Key: 'team', Value: 'x' }] })],
      liveWithManaged
    );
    expect(out!.value).toEqual([
      { Key: 'team', Value: 'x' },
      { Key: 'aws:cloudformation:stack-name', Value: 'S' },
      { Key: 'aws:cloudformation:logical-id', Value: 'Topic' },
    ]);
  });

  it('defensively drops any aws:* entry that slipped into the add value (never re-asserted twice)', () => {
    const [out] = tagPreservingOps(
      [
        op({
          op: 'add',
          value: [
            { Key: 'aws:cloudformation:stack-name', Value: 'S' },
            { Key: 'team', Value: 'x' },
          ],
        }),
      ],
      liveWithManaged
    );
    // the value's aws:* entry is dropped; the live managed set is the single source
    expect(out!.value).toEqual([
      { Key: 'team', Value: 'x' },
      { Key: 'aws:cloudformation:stack-name', Value: 'S' },
      { Key: 'aws:cloudformation:logical-id', Value: 'Topic' },
    ]);
  });

  it('leaves the op UNCHANGED when the live model has no aws:* managed tags', () => {
    const ops = [op({ op: 'remove' })];
    expect(tagPreservingOps(ops, { Tags: [{ Key: 'team', Value: 'x' }] })).toBe(ops);
    expect(tagPreservingOps(ops, {})).toBe(ops);
    expect(tagPreservingOps(ops, undefined)).toBe(ops);
  });

  it('only touches the /Tags op — sibling ops on the same resource pass through untouched', () => {
    const other = op({ op: 'add', path: '/DisplayName', value: 'X', human: 'd' });
    const out = tagPreservingOps([op({ op: 'remove' }), other], liveWithManaged);
    expect(out[0]!.path).toBe('/Tags');
    expect(out[0]!.op).toBe('add');
    expect(out[1]).toBe(other); // the non-Tags op is returned by reference, unchanged
  });
});
