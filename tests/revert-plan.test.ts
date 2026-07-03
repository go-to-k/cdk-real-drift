import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import type { BaselineFile } from '../src/baseline/baseline-file.js';
import { type CorpusCase, reviveSchema } from '../src/corpus/record.js';
import { UNRESOLVED } from '../src/normalize/intrinsic-resolver.js';
import {
  buildRevertPlan,
  type PatchOp,
  rejectedEmptyStripOps,
  tagPreservingOps,
  toPatchDocument,
  writeOnlyReincludeOps,
} from '../src/revert/plan.js';
import { parseSchema } from '../src/schema/schema-strip.js';
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

  it('JSON-string property (ConfigRule InputParameters) -> SDK writer (CC re-serializes with spaces; provider rejects)', () => {
    // classify reports the whole property at the top-level path. Cloud Control cannot
    // revert it (its read-modify-write re-serializes the JSON into Config's string field
    // with spaces -> "Blank spaces are not acceptable"), so it must route to the
    // type's SDK writer (PutConfigRule, compact JSON string). The op carries the whole
    // declared value; the writer compacts it.
    const f = F({
      tier: 'declared',
      resourceType: 'AWS::Config::ConfigRule',
      physicalId: 'cdkrd-access-keys-rotated',
      path: 'InputParameters',
      desired: { maxAccessKeyAge: 90 },
      actual: { maxAccessKeyAge: '365' },
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('sdk'); // NOT cc — the CC patch always fails for this prop
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/InputParameters',
      value: { maxAccessKeyAge: 90 },
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

  it('ManagedPolicy attachment detach -> SDK item, op carries the member on attributeKey', () => {
    // a declared-but-detached Role finding (path Roles, attributeKey = role name) must
    // route to the SDK writer (ManagedPolicy is a whole-type writer) and carry the
    // member so writeIamManagedPolicy re-attaches ONLY that member (AttachRolePolicy).
    const f = F({
      tier: 'declared',
      resourceType: 'AWS::IAM::ManagedPolicy',
      physicalId: 'arn:aws:iam::111122223333:policy/p',
      path: 'Roles',
      attributeKey: 'RoleA',
      desired: 'RoleA',
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('sdk');
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/Roles',
      value: 'RoleA',
      attributeKey: 'RoleA',
    });
  });

  it('an unexpected ManagedPolicy attachment (live-only) is removable ONLY with --remove-unrecorded', () => {
    // a live-only member is nested undeclared (Roles[member]) — normally record-only —
    // but ManagedPolicy has a precise DetachXPolicy op, so it IS revertable, gated by
    // the unrecorded opt-in like any unrecorded undeclared value.
    const f = F({
      tier: 'undeclared',
      resourceType: 'AWS::IAM::ManagedPolicy',
      physicalId: 'arn:aws:iam::111122223333:policy/p',
      path: 'Roles[RoleX]',
      actual: 'RoleX',
      nested: true,
      unrecorded: true,
    });
    // default revert refuses (unrecorded), but NOT with the "nested, not revertable" reason
    const noFlag = buildRevertPlan([f], undefined);
    expect(noFlag.items).toHaveLength(0);
    expect(noFlag.notRevertable).toHaveLength(1);
    expect(noFlag.notRevertable[0]!.reason).toContain('unrecorded');
    expect(noFlag.notRevertable[0]!.reason).not.toContain('nested');
    // --remove-unrecorded enables the detach (a remove op routed to the SDK writer)
    const plan = buildRevertPlan([f], undefined, { removeUnrecorded: true });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('sdk');
    expect(plan.items[0]!.ops[0]).toMatchObject({ op: 'remove', path: '/Roles[RoleX]' });
  });

  it("an undeclared LogGroup BearerTokenAuthenticationEnabled drift -> a prop-scoped 'sdk' item (CC UpdateResource fails on it)", () => {
    const f = F({
      tier: 'undeclared',
      resourceType: 'AWS::Logs::LogGroup',
      physicalId: '/aws/lambda/my-fn',
      path: 'BearerTokenAuthenticationEnabled',
      actual: true,
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('sdk');
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'remove',
      path: '/BearerTokenAuthenticationEnabled',
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

  it('appeared-since-record undeclared drift on a SET-DEFAULT property -> add op writing the AWS default', () => {
    // IAM Role MaxSessionDuration is in REVERT_SET_DEFAULT_PATHS: IAM's UpdateRole leaves
    // the value UNCHANGED when it is absent, so a bare `remove` is a silent no-op (Cloud
    // Control reports SUCCESS yet the live 7200 persists). Revert must write the known
    // 3600 default explicitly instead.
    const f = F({
      tier: 'undeclared',
      resourceType: 'AWS::IAM::Role',
      path: 'MaxSessionDuration',
      actual: 7200,
    });
    const plan = buildRevertPlan([f], baseline([]));
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/MaxSessionDuration',
      value: 3600,
      prior: 7200,
    });
  });

  it('Lambda Alias Description (SET-DEFAULT) -> add op writing the empty-string default, not a no-op remove', () => {
    // AWS::Lambda::Alias Description is in REVERT_SET_DEFAULT_PATHS: UpdateAlias leaves the
    // description UNCHANGED when it is OMITTED, so a bare `remove` is a silent no-op (Cloud
    // Control reports SUCCESS yet the live "test" persists; proven live). Revert must write
    // the empty-string default explicitly to clear it.
    const f = F({
      tier: 'undeclared',
      resourceType: 'AWS::Lambda::Alias',
      path: 'Description',
      actual: 'test',
    });
    const plan = buildRevertPlan([f], baseline([]));
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/Description',
      value: '',
      prior: 'test',
    });
  });

  it('appeared-since-record undeclared Cognito IdentityPool AllowClassicFlow -> add op writing false', () => {
    // AllowClassicFlow is in REVERT_SET_DEFAULT_PATHS: UpdateIdentityPool leaves an
    // omitted value UNCHANGED, so a bare `remove` of an out-of-band `true` is a silent
    // no-op. Revert must write the `false` default explicitly.
    const f = F({
      tier: 'undeclared',
      resourceType: 'AWS::Cognito::IdentityPool',
      path: 'AllowClassicFlow',
      actual: true,
    });
    const plan = buildRevertPlan([f], baseline([]));
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/AllowClassicFlow',
      value: false,
      prior: true,
    });
  });

  it('appeared-since-record undeclared drift on a KNOWN_DEFAULTS-but-not-SET-DEFAULT property still -> remove op', () => {
    // S3 OwnershipControls is in KNOWN_DEFAULTS but NOT in REVERT_SET_DEFAULT_PATHS:
    // DeleteBucketOwnershipControls resets it to the AWS default, so `remove` converges.
    // The set-default path must NOT fire for it (it is a curated set, not "every
    // KNOWN_DEFAULTS entry").
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

  it('a declared drift under ECS ServiceConnectConfiguration routes to the nested SDK (UpdateService) writer', () => {
    // The whole writeOnly prop cannot be sub-path patched by CC, so any drift under it is
    // reverted via the SDK_NESTED_WRITERS UpdateService writer (re-supplies the declared
    // whole config) — a single 'sdk' item, NOT a not-revertable finding nor a CC patch.
    const f = F({
      tier: 'declared',
      resourceType: 'AWS::ECS::Service',
      path: 'ServiceConnectConfiguration.Services.0.ClientAliases.0.DnsName',
      desired: 'api',
      actual: 'api-tampered',
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('sdk');
  });

  it('SSM Parameter Tier downgrade (Advanced->Standard) is notRevertable; an upgrade stays revertable', () => {
    // AWS forbids an advanced->standard downgrade via update, so reverting an out-of-band
    // upgrade (declared Standard, live Advanced) is not-revertable, not a failing patch.
    const downgrade = F({
      tier: 'declared',
      resourceType: 'AWS::SSM::Parameter',
      path: 'Tier',
      desired: 'Standard',
      actual: 'Advanced',
    });
    const plan = buildRevertPlan([downgrade], undefined);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable[0]!.reason).toContain('downgrade');
    // The reverse (restore a declared Advanced that was reduced) is an allowed upgrade.
    const upgrade = F({
      tier: 'declared',
      resourceType: 'AWS::SSM::Parameter',
      path: 'Tier',
      desired: 'Advanced',
      actual: 'Standard',
    });
    expect(buildRevertPlan([upgrade], undefined).items).toHaveLength(1);
  });

  it('a removed-since-record undeclared finding WITH a physical id is revertable (re-adds the value)', () => {
    // applyBaseline now stamps the synthesized "baseline value removed since record"
    // finding with the live physical id, so revert can restore the value it carries.
    const f = F({
      tier: 'undeclared',
      path: 'AccelerateConfiguration',
      desired: { AccelerationStatus: 'Enabled' },
      actual: undefined,
      note: 'baseline value removed since record',
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/AccelerateConfiguration',
      value: { AccelerationStatus: 'Enabled' },
    });
  });

  it('the SAME finding WITHOUT a physical id is notRevertable ("no physical id") — the bug this fixes', () => {
    const f = F({
      tier: 'undeclared',
      physicalId: undefined,
      path: 'AccelerateConfiguration',
      desired: { AccelerationStatus: 'Enabled' },
      actual: undefined,
      note: 'baseline value removed since record',
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(1);
    expect(plan.notRevertable[0]!.reason).toContain('no physical id');
  });

  it('a read-override type that is CC-mutable (Scheduler::Schedule) IS revertable via CC', () => {
    // Found live by the scheduler-rich bug-hunt fixture: AWS::Scheduler::Schedule has an
    // SDK READ override (its CC read handler only looks in the default group) but is CC
    // FULLY_MUTABLE, so a State revert via CC UpdateResource is valid — it must NOT be
    // classified "type not revertable yet".
    const f = F({
      resourceType: 'AWS::Scheduler::Schedule',
      path: 'State',
      desired: 'ENABLED',
      actual: 'DISABLED',
      physicalId: 'cdkrd-schedule-rich',
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ kind: 'cc', resourceType: 'AWS::Scheduler::Schedule' });
  });

  it('Cognito IdentityPool: CognitoEvents -> prop-scoped sdk item, a base prop -> cc item', () => {
    // The IdentityPool SDK override only ENRICHES the CC read with the writeOnly
    // CognitoEvents, so it is CC_REVERTABLE_DESPITE_READ_OVERRIDE: base-property reverts
    // (AllowClassicFlow) route through Cloud Control, while CognitoEvents takes its
    // dedicated SetCognitoEvents SDK writer.
    const events = F({
      tier: 'declared',
      resourceType: 'AWS::Cognito::IdentityPool',
      path: 'CognitoEvents',
      desired: { SyncTrigger: 'arn:aws:lambda:us-east-1:111122223333:function:f' },
      actual: {},
      physicalId: 'us-east-1:abc',
      logicalId: 'IdPool',
    });
    const flag = F({
      tier: 'undeclared',
      resourceType: 'AWS::Cognito::IdentityPool',
      path: 'AllowClassicFlow',
      actual: true,
      physicalId: 'us-east-1:abc',
      logicalId: 'IdPool',
    });
    const plan = buildRevertPlan([events, flag], baseline([]));
    expect(plan.notRevertable).toHaveLength(0);
    const ev = plan.items.find((i) => i.ops.some((o) => o.path === '/CognitoEvents'))!;
    const fl = plan.items.find((i) => i.ops.some((o) => o.path === '/AllowClassicFlow'))!;
    expect(ev.kind).toBe('sdk');
    expect(fl.kind).toBe('cc');
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

  it('orders DELETE items LAST so a dereference (property revert) runs before the delete', () => {
    // Mirrors the live API Gateway case: an out-of-band RequestValidator (added -> delete)
    // is still referenced by a Method's undeclared RequestValidatorId (undeclared -> remove).
    // The validator delete must run AFTER the reference is removed, else the provider rejects
    // "still in use". Findings are given delete-first to prove the plan reorders them.
    const del = F({
      tier: 'added',
      logicalId: 'Api/validator|abc',
      physicalId: 'validator|abc',
      resourceType: 'AWS::ApiGateway::RequestValidator',
      path: '',
    });
    const deref = F({
      tier: 'undeclared',
      logicalId: 'Api/method',
      physicalId: 'abc|res|OPTIONS',
      resourceType: 'AWS::ApiGateway::Method',
      path: 'RequestValidatorId',
      actual: 'abc',
      unrecorded: false,
    });
    const plan = buildRevertPlan([del, deref], undefined, { removeUnrecorded: true });
    expect(plan.items).toHaveLength(2);
    // the property revert (cc) comes first; the delete is appended last
    expect(plan.items[0]!.kind).not.toBe('delete');
    expect(plan.items[1]!.kind).toBe('delete');
    expect(plan.items[1]!.resourceType).toBe('AWS::ApiGateway::RequestValidator');
  });

  it('ApiGateway Method nested integration knobs route to kind=sdk (not record-only)', () => {
    // Both a pure-dotted knob and an ARRAY-ELEMENT knob (which the generic nested bar would
    // mark unrevertable) become revertable via the nested SDK writer, batched into one item.
    const pass = F({
      tier: 'undeclared',
      logicalId: 'Api/OPTIONS',
      physicalId: 'abc|res|OPTIONS',
      resourceType: 'AWS::ApiGateway::Method',
      path: 'Integration.PassthroughBehavior',
      actual: 'NEVER',
      nested: true,
      unrecorded: false,
    });
    const sel = F({
      tier: 'undeclared',
      logicalId: 'Api/OPTIONS',
      physicalId: 'abc|res|OPTIONS',
      resourceType: 'AWS::ApiGateway::Method',
      path: 'Integration.IntegrationResponses[204].SelectionPattern',
      actual: '5\\d{2}',
      nested: true,
      unrecorded: false,
    });
    const plan = buildRevertPlan([pass, sel], undefined);
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1); // both ops batched into ONE sdk item for the method
    expect(plan.items[0]).toMatchObject({ kind: 'sdk', resourceType: 'AWS::ApiGateway::Method' });
    expect(plan.items[0]!.ops).toHaveLength(2);
  });

  it('Backup BackupPlanRule array-element nested -> revertable sdk item, op SETS the AWS default', () => {
    // A value that "appeared since record" inside a non-standard-keyed array element is now
    // revertable (Cloud Control index-revert writer), and a KNOWN_DEFAULT_PATHS default makes
    // the op SET the default (not a `remove` the provider may ignore).
    const f = F({
      tier: 'undeclared',
      logicalId: 'Plan',
      physicalId: 'plan|abc',
      resourceType: 'AWS::Backup::BackupPlan',
      path: 'BackupPlan.BackupPlanRule[Daily].CompletionWindowMinutes',
      actual: 5000,
      nested: true,
      unrecorded: false,
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items[0]).toMatchObject({ kind: 'sdk', resourceType: 'AWS::Backup::BackupPlan' });
    expect(plan.items[0]!.ops[0]).toMatchObject({ op: 'add', value: 10080 });
  });

  it('Route53Resolver FirewallRules array-element nested -> revertable sdk item, sets default', () => {
    const f = F({
      tier: 'undeclared',
      logicalId: 'RG',
      physicalId: 'rslvr-frg-x',
      resourceType: 'AWS::Route53Resolver::FirewallRuleGroup',
      path: 'FirewallRules[100].FirewallDomainRedirectionAction',
      actual: 'TRUST_REDIRECTION_DOMAIN',
      nested: true,
      unrecorded: false,
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items[0]).toMatchObject({
      kind: 'sdk',
      resourceType: 'AWS::Route53Resolver::FirewallRuleGroup',
    });
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      value: 'INSPECT_REDIRECTION_DOMAIN',
    });
  });

  it('SecretsManager ReplicaRegions array-element nested -> revertable sdk item, sets default KmsKeyId', () => {
    const f = F({
      tier: 'undeclared',
      logicalId: 'Secret',
      physicalId: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:s-AbCdEf',
      resourceType: 'AWS::SecretsManager::Secret',
      path: 'ReplicaRegions[us-west-2].KmsKeyId',
      actual: 'arn:aws:kms:us-west-2:111111111111:key/abcd',
      nested: true,
      unrecorded: false,
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items[0]).toMatchObject({
      kind: 'sdk',
      resourceType: 'AWS::SecretsManager::Secret',
    });
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      value: 'alias/aws/secretsmanager',
    });
  });

  it('ApiGateway Stage MethodSettings array-element nested -> revertable sdk item, sets default TTL', () => {
    const f = F({
      tier: 'undeclared',
      logicalId: 'Stage',
      physicalId: 'prod',
      resourceType: 'AWS::ApiGateway::Stage',
      path: 'MethodSettings[*].CacheTtlInSeconds',
      actual: 600,
      nested: true,
      unrecorded: false,
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items[0]).toMatchObject({ kind: 'sdk', resourceType: 'AWS::ApiGateway::Stage' });
    expect(plan.items[0]!.ops[0]).toMatchObject({ op: 'add', value: 300 });
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

  it("an IAM Role Policies finding marked siblingPolicyNames:'unresolved' is NOT revertable (would delete a managed policy)", () => {
    const plan = buildRevertPlan(
      [
        F({
          tier: 'declared',
          resourceType: 'AWS::IAM::Role',
          path: 'Policies',
          desired: [{ PolicyName: 'inline-a' }],
          actual: [{ PolicyName: 'inline-a' }, { PolicyName: 'RoleDefaultPolicyABC' }],
          siblingPolicyNames: 'unresolved',
        }),
      ],
      undefined
    );
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(1);
    expect(plan.notRevertable[0]!.reason).toContain('sibling AWS::IAM::Policy whose name');
  });

  it('an IAM Role Policies finding with a RESOLVED sibling (no marker) stays revertable', () => {
    const plan = buildRevertPlan(
      [
        F({
          tier: 'declared',
          resourceType: 'AWS::IAM::Role',
          path: 'Policies',
          desired: [{ PolicyName: 'inline-a' }],
          actual: [{ PolicyName: 'inline-a' }, { PolicyName: 'rogue' }],
        }),
      ],
      undefined
    );
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
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

  it('a PARENT finding of a create-only sub-path is notRevertable (revert would replace the subtree)', () => {
    // drift-calculator emits a finding at the PARENT path for a length-/shape-changed
    // array or object; reverting it rewrites the whole subtree, INCLUDING the create-only
    // descendant. Block it up front instead of failing at apply time.
    const efs = schemaWithCreateOnly('AWS::EFS::AccessPoint', 'PosixUser.Uid');
    const plan = (path: string) =>
      buildRevertPlan(
        [
          F({
            resourceType: 'AWS::EFS::AccessPoint',
            tier: 'declared',
            path,
            desired: [],
            actual: [1],
          }),
        ],
        undefined,
        { schemas: efs }
      );
    // the whole PosixUser object reverted -> would rewrite the create-only Uid
    expect(plan('PosixUser').notRevertable[0]!.reason).toContain('create-only');
    expect(plan('PosixUser').items).toHaveLength(0);
    // an unrelated parent that contains NO create-only descendant stays revertable
    expect(plan('RootDirectory').items).toHaveLength(1);
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

  it('SecurityGroup ingress revert merges sibling-declared rules into the value (no clobber)', () => {
    // Reverting an SG's reflected SecurityGroupIngress is a whole-array Cloud Control
    // replacement. The live SG reflects rules declared by sibling standalone SG-rule resources
    // (a self-ref / prefix-list rule CDK could not inline); without merging them back, the
    // replacement DELETES them (silent data loss, observed live). The merged value preserves
    // them — including the injected SourceSecurityGroupOwnerId so CC sees the rule unchanged.
    const inlineDeclared = [
      { CidrIp: '10.0.0.0/24', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
    ];
    const siblingRule = {
      SourceSecurityGroupId: 'sg-1',
      SourceSecurityGroupOwnerId: '111122223333',
      IpProtocol: 'tcp',
      FromPort: 9000,
      ToPort: 9000,
    };
    const f = F({
      tier: 'declared',
      resourceType: 'AWS::EC2::SecurityGroup',
      physicalId: 'sg-1',
      path: 'SecurityGroupIngress',
      desired: inlineDeclared,
      actual: inlineDeclared,
    });
    const plan = buildRevertPlan([f], undefined, {
      siblingSgRules: { 'sg-1': { ingress: [siblingRule], egress: [] } },
    });
    expect(plan.items[0]!.kind).toBe('cc');
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/SecurityGroupIngress',
      value: [...inlineDeclared, siblingRule],
    });
  });

  it('SecurityGroup ingress revert without siblings leaves the declared value unchanged', () => {
    const inlineDeclared = [
      { CidrIp: '10.0.0.0/24', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
    ];
    const f = F({
      tier: 'declared',
      resourceType: 'AWS::EC2::SecurityGroup',
      physicalId: 'sg-1',
      path: 'SecurityGroupIngress',
      desired: inlineDeclared,
      actual: [],
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/SecurityGroupIngress',
      value: inlineDeclared,
    });
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

  it('a PURE-DOTTED object-nested value IS revertable (valid RFC6902 pointer, CC applies it)', () => {
    // A clean dotted path (no array bracket) is a valid pointer Cloud Control applies
    // read-modify-write — e.g. a free-form map key like a Lambda env var. A recorded value
    // reverts by restoring the baseline; the op targets the nested pointer `/Conf/Destination`.
    const f = F({ tier: 'undeclared', path: 'Conf.Destination', actual: 's3', nested: true });
    const b = baseline([
      { logicalId: 'R', resourceType: 'AWS::S3::Bucket', path: 'Conf.Destination', value: 'old' },
    ]);
    const plan = buildRevertPlan([f], b);
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.ops[0]!.path).toBe('/Conf/Destination');
  });

  it('a free-form map key (env var) appeared since record IS revertable -> remove op', () => {
    // The reported Lambda Environment.Variables case: an undeclared env var present in live
    // but gone from the baseline reverts by REMOVING the nested key via Cloud Control.
    const f = F({
      tier: 'undeclared',
      resourceType: 'AWS::Lambda::Function',
      path: 'Environment.Variables.testtesttess',
      actual: 'testtesttess',
      nested: true,
      freeFormKey: true,
    });
    const plan = buildRevertPlan([f], baseline([]));
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'remove',
      path: '/Environment/Variables/testtesttess',
    });
  });

  it('a MAP-shaped tag key (Tags.<key>) IS revertable — single-key CC remove preserves aws:* tags', () => {
    // Proven live on an AWS::SSM::Parameter: `remove /Tags/<key>` succeeds and leaves the
    // aws:cloudformation:* managed tags untouched (Cloud Control read-modify-write keeps
    // every other key). A LIST-shaped tag element (`Tags[<id>].sub`) stays barred (bracket).
    const f = F({
      tier: 'undeclared',
      resourceType: 'AWS::SSM::Parameter',
      path: 'Tags.rogueKey',
      actual: 'rogueVal',
      nested: true,
    });
    const plan = buildRevertPlan([f], baseline([]));
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.ops[0]).toMatchObject({ op: 'remove', path: '/Tags/rogueKey' });
  });

  it('a LIST-shaped tag element (Tags[<id>].sub) stays notRevertable (bracket can not form a pointer)', () => {
    const f = F({
      tier: 'undeclared',
      resourceType: 'AWS::S3::Bucket',
      path: 'Tags[k1].Value',
      actual: 'v',
      nested: true,
    });
    const plan = buildRevertPlan([f], baseline([]));
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable[0]!.reason).toContain('array-element');
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

  it('--remove-unrecorded does NOT override the array-element guard', () => {
    const f = F({
      tier: 'undeclared',
      resourceType: 'AWS::CloudFront::Distribution',
      path: 'DistributionConfig.Origins[o1].ConnectionTimeout',
      actual: 60,
      nested: true,
      unrecorded: true,
    });
    const plan = buildRevertPlan([f], baseline([]), { removeUnrecorded: true });
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable[0]!.reason).toContain('nested undeclared array-element');
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

  it('does NOT re-include a write-only prop that is ALSO create-only (ElastiCache CacheSubnetGroupName) — CC rejects an op on a create-only path', () => {
    // AWS::ElastiCache::ReplicationGroup: CacheSubnetGroupName is in BOTH writeOnlyPaths
    // and createOnlyPaths. Re-including it to satisfy the read-modify-write contract made
    // every revert fail at apply time ("createOnlyProperties [/properties/
    // CacheSubnetGroupName] cannot be updated"), e.g. reverting an out-of-band
    // SnapshotRetentionLimit change. The create-only prop must be omitted from the patch.
    const ecSchema: SchemaInfo = {
      readOnly: new Set<string>(),
      writeOnly: new Set(['CacheSubnetGroupName', 'PreferredMaintenanceWindow']),
      createOnly: new Set(['CacheSubnetGroupName']),
      readOnlyPaths: [],
      writeOnlyPaths: ['CacheSubnetGroupName', 'PreferredMaintenanceWindow'],
      createOnlyPaths: ['CacheSubnetGroupName'],
      defaults: {},
      defaultPaths: {},
    };
    const ecDeclared = {
      SnapshotRetentionLimit: 1,
      CacheSubnetGroupName: 'cdkrd-elasticache-rich',
      PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
    };
    const ops = writeOnlyReincludeOps(ecDeclared, ecSchema, [
      { op: 'add', path: '/SnapshotRetentionLimit', value: 1, human: '' },
    ]);
    // The mutable write-only prop is still re-included; the create-only one is not.
    expect(ops).toEqual([
      {
        op: 'add',
        path: '/PreferredMaintenanceWindow',
        value: 'sun:05:00-sun:06:00',
        human:
          'PreferredMaintenanceWindow -> re-include write-only (Cloud Control read-modify-write contract)',
      },
    ]);
  });

  it('re-includes a NESTED write-only prop (IAM User LoginProfile.Password) — no credential reset (WAVE24)', () => {
    // AWS::IAM::User has only the NESTED write-only path LoginProfile.Password; the
    // top-level write-only set is EMPTY, so the old top-level-only loop re-included
    // nothing and a cc revert touching another property dropped the password.
    const userSchema = schemaWithWriteOnly('LoginProfile.Password');
    const userDeclared = {
      Path: '/team/',
      LoginProfile: { Password: 'S3cret!', PasswordResetRequired: true },
    };
    const ops = writeOnlyReincludeOps(userDeclared, userSchema, [
      { op: 'add', path: '/Path', value: '/team/', human: '' },
    ]);
    expect(ops).toEqual([
      {
        op: 'add',
        path: '/LoginProfile/Password',
        value: 'S3cret!',
        human:
          'LoginProfile.Password -> re-include write-only (Cloud Control read-modify-write contract)',
      },
    ]);
  });

  it('skips a nested write-only path absent from the declared model (nothing to re-include)', () => {
    // the template declares no LoginProfile -> no value to preserve
    const ops = writeOnlyReincludeOps(
      { Path: '/team/' },
      schemaWithWriteOnly('LoginProfile.Password'),
      []
    );
    expect(ops).toEqual([]);
  });

  it('skips an UNRESOLVED nested write-only value', () => {
    const ops = writeOnlyReincludeOps(
      { LoginProfile: { Password: UNRESOLVED } },
      schemaWithWriteOnly('LoginProfile.Password'),
      []
    );
    expect(ops).toEqual([]);
  });

  it('skips a wildcard (array-element) write-only path', () => {
    const ops = writeOnlyReincludeOps(
      { Items: [{ Secret: 'a' }] },
      schemaWithWriteOnly('Items.*.Secret'),
      []
    );
    expect(ops).toEqual([]);
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

  describe('MAP-shaped Tags (AWS::SSM::Parameter — key->value, WAVE24)', () => {
    // CC returns SSM Parameter Tags as a map; the managed tags are aws:* KEYS
    const liveMapManaged = {
      Tags: {
        'aws:cloudformation:stack-name': 'S',
        'aws:cloudformation:logical-id': 'Param',
        Team: 'platform',
      },
    };

    it('a `remove /Tags` keeps ONLY the live aws:* map keys (not a dropped-managed reject)', () => {
      const [out] = tagPreservingOps([op({ op: 'remove' })], liveMapManaged);
      expect(out).toMatchObject({
        op: 'add',
        path: '/Tags',
        value: {
          'aws:cloudformation:stack-name': 'S',
          'aws:cloudformation:logical-id': 'Param',
        },
      });
      expect(out!.value).not.toHaveProperty('Team'); // user key dropped by the remove
    });

    it('an `add /Tags` merges the user map with the live aws:* keys (and drops any aws:* from the value)', () => {
      const [out] = tagPreservingOps(
        [op({ op: 'add', value: { Team: 'data', 'aws:should-not-be-here': 'x' } })],
        liveMapManaged
      );
      expect(out!.value).toEqual({
        Team: 'data',
        'aws:cloudformation:stack-name': 'S',
        'aws:cloudformation:logical-id': 'Param',
      });
    });

    it('leaves the op unchanged when a map-shaped Tags has no aws:* keys', () => {
      const ops = [op({ op: 'remove' })];
      expect(tagPreservingOps(ops, { Tags: { Team: 'x' } })).toBe(ops);
    });
  });
});

// Data-driven guarantee for the #252 fix across EVERY real resource schema we have
// captured. The bug class — a property that is BOTH write-only and create-only
// being re-included into a Cloud Control UpdateResource patch and then hard-
// rejected ("createOnlyProperties [...] cannot be updated") — is NOT specific to
// ElastiCache: the golden corpus alone holds ~17 types with such an intersection
// (RDS DBInstance, DynamoDB Table, EC2 EIP/Subnet/VPC, EFS MountTarget, S3 Bucket,
// SNS Subscription, SSM Document, Lambda LayerVersion, Kinesis Firehose,
// ApiGateway ApiKey, AutoScaling, ApplicationAutoScaling, ElastiCache, ...). This
// test loads each corpus case's REAL schema, builds a declared model that sets a
// value at every write-only path (so re-inclusion would fire), and asserts
// writeOnlyReincludeOps emits NO op for any write-only∩create-only path — for ALL
// of them. It self-extends: any future type added to the corpus is covered for
// free. corpus-replay.test.ts covers the classify pipeline; this covers the revert
// patch path, which corpus-replay does not.
const corpusDir = join(dirname(fileURLToPath(import.meta.url)), 'corpus');

function setDottedPath(model: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.');
  let node = model;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (typeof node[seg] !== 'object' || node[seg] === null) node[seg] = {};
    node = node[seg] as Record<string, unknown>;
  }
  node[segs[segs.length - 1]] = value;
}

// RFC6902 pointer for a non-wildcard dotted path (mirrors plan.ts toPointer for the
// property names that appear here — plain identifiers, no `~`/`/`).
const pointerOf = (path: string): string => `/${path.split('.').join('/')}`;

describe('writeOnlyReincludeOps create-only invariant over all real corpus schemas (#252)', () => {
  const corpusFiles = readdirSync(corpusDir).filter((f) => f.endsWith('.json'));

  it('never re-includes a write-only property that is also create-only — every corpus type', () => {
    let typesExercised = 0;
    let propsAsserted = 0;
    for (const file of corpusFiles) {
      const c = JSON.parse(readFileSync(join(corpusDir, file), 'utf8')) as CorpusCase;
      const schema = reviveSchema(c.schema);
      const createOnly = new Set(schema.createOnlyPaths);
      const intersection = schema.writeOnlyPaths.filter(
        (p) => !p.includes('*') && createOnly.has(p)
      );
      if (intersection.length === 0) continue;
      typesExercised++;
      // Declared model with a value at EVERY non-wildcard write-only path, so the
      // re-include loop fires for all of them — including the create-only ones,
      // which the fix must then drop.
      const declared: Record<string, unknown> = {};
      for (const p of schema.writeOnlyPaths) {
        if (p.includes('*')) continue;
        setDottedPath(declared, p, 'cdkrd-test-value');
      }
      const emitted = new Set(writeOnlyReincludeOps(declared, schema, []).map((o) => o.path));
      for (const p of intersection) {
        expect(emitted.has(pointerOf(p))).toBe(false);
        propsAsserted++;
      }
    }
    // Guard the guard: if the corpus stops containing intersection types (e.g. a
    // refactor drops the schema field), this surfaces it instead of passing vacuously.
    expect(typesExercised).toBeGreaterThan(5);
    expect(propsAsserted).toBeGreaterThan(0);
  });
});

// Issue #421 TASK 3 — data-driven invariant for the conditional/hard create-only split.
//
// #413/#416 made `conditionalCreateOnlyProperties` NOT bar a revert (only the HARD
// `createOnlyProperties` bar): a conditional-create-only prop (e.g. RDS DBInstance
// BackupRetentionPeriod / MultiAZ / StorageType) is mutable in place in the common case,
// so barring it would be a revert false negative on a very common resource. The split is
// implemented in `parseSchema` (only `createOnlyProperties` flows into `createOnlyPaths`)
// and consumed by `plan.ts::isUnderCreateOnly` (segment-wise prefix over `createOnlyPaths`).
//
// The corpus only stores the POST-parse SchemaInfo (`createOnlyPaths` already excludes
// conditional), so a corpus replay can't tell hard from conditional and would pass
// vacuously if the split regressed. So this invariant is driven by a fixture of REAL
// CloudFormation schemas' create-only declarations (`tests/fixtures/cfn-create-only.json`,
// the literal `createOnlyProperties` + `conditionalCreateOnlyProperties` arrays captured
// from `describe-type` for 14 high-frequency types). Re-parsing them through `parseSchema`
// makes the test FAIL if conditional props are ever re-merged into `createOnlyPaths`.
// Self-extends: add a type to the fixture and it is covered. (RDS/EC2/OpenSearch/ECS/
// Lambda/ElastiCache/DynamoDB carry conditional props; S3/EKS/MSK/EFS/Logs are hard-only.)
interface CreateOnlyFixture {
  resourceType: string;
  createOnlyProperties: string[];
  conditionalCreateOnlyProperties: string[];
}
const pointerToDotted = (p: string): string => p.replace(/^\/properties\//, '').replace(/\//g, '.');

describe('conditional/hard create-only split invariant over real CFn schemas (issue #421 TASK 3)', () => {
  const fixtures = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cfn-create-only.json'),
      'utf8'
    )
  ) as CreateOnlyFixture[];

  it('parseSchema: every HARD create-only prop IS in createOnlyPaths; every CONDITIONAL one is NOT', () => {
    let hardAsserted = 0;
    let condAsserted = 0;
    let typesWithConditional = 0;
    for (const fx of fixtures) {
      const info = parseSchema(
        JSON.stringify({
          createOnlyProperties: fx.createOnlyProperties,
          conditionalCreateOnlyProperties: fx.conditionalCreateOnlyProperties,
        })
      );
      const createOnly = new Set(info.createOnlyPaths);
      for (const p of fx.createOnlyProperties) {
        // HARD create-only must bar revert → present in createOnlyPaths
        expect(createOnly.has(pointerToDotted(p))).toBe(true);
        hardAsserted++;
      }
      if (fx.conditionalCreateOnlyProperties.length > 0) typesWithConditional++;
      for (const p of fx.conditionalCreateOnlyProperties) {
        // CONDITIONAL create-only must NOT bar revert → absent from createOnlyPaths
        // (this is the exact assertion that regresses if conditional is re-merged)
        expect(createOnly.has(pointerToDotted(p))).toBe(false);
        condAsserted++;
      }
    }
    // guard the guard: the fixture must actually exercise both arms broadly
    expect(hardAsserted).toBeGreaterThan(50);
    expect(condAsserted).toBeGreaterThan(20);
    expect(typesWithConditional).toBeGreaterThan(3);
  });

  it('consumer (buildRevertPlan/isUnderCreateOnly): a HARD create-only top-level prop bars revert, a CONDITIONAL one does not', () => {
    // For every fixture type that has BOTH a hard and a conditional TOP-LEVEL prop, build a
    // declared finding at each and prove the revert plan bars the hard one (notRevertable)
    // and keeps the conditional one revertable — the behavioral consequence of the split.
    const topLevel = (p: string): string | undefined => {
      const d = pointerToDotted(p);
      return d.includes('.') ? undefined : d;
    };
    let exercised = 0;
    for (const fx of fixtures) {
      const hardTop = fx.createOnlyProperties.map(topLevel).find(Boolean);
      const condTop = fx.conditionalCreateOnlyProperties.map(topLevel).find(Boolean);
      if (!hardTop || !condTop) continue;
      exercised++;
      const info = parseSchema(
        JSON.stringify({
          createOnlyProperties: fx.createOnlyProperties,
          conditionalCreateOnlyProperties: fx.conditionalCreateOnlyProperties,
        })
      );
      const schemas = new Map<string, SchemaInfo>([[fx.resourceType, info]]);
      const find = (path: string): Finding => ({
        tier: 'declared',
        logicalId: 'R',
        physicalId: 'phys-1',
        resourceType: fx.resourceType,
        path,
        desired: 'x',
        actual: 'y',
      });

      // HARD create-only → notRevertable with the create-only reason
      const hardPlan = buildRevertPlan([find(hardTop)], undefined, { schemas });
      expect(hardPlan.items).toHaveLength(0);
      expect(hardPlan.notRevertable.map((n) => n.reason).join(' ')).toContain('create-only');

      // CONDITIONAL create-only → revertable (a Cloud Control item, never barred)
      const condPlan = buildRevertPlan([find(condTop)], undefined, { schemas });
      expect(condPlan.notRevertable).toEqual([]);
      expect(condPlan.items).toHaveLength(1);
      expect(condPlan.items[0].kind).toBe('cc');
    }
    expect(exercised).toBeGreaterThan(2);
  });
});

// Issue #421 TASK 2 — a removed declared COLLECTION (whole property absent from the
// live read, #416) reverts via a single top-level Cloud Control `add /Prop`, NO SDK
// writer needed — even for collections managed by a dedicated sub-API.
//
// The hypothesis was that some common types' removed collection can't be re-applied via
// Cloud Control UpdateResource (a separate SDK API is required, like the existing
// SDK_WRITERS). Live-tested on the two strongest candidates — EventBridge Rule `Targets`
// (PutTargets/RemoveTargets) and EC2 Auto Scaling `NotificationConfigurations`
// (PutNotificationConfiguration/DeleteNotificationConfiguration): BOTH revert cleanly
// via Cloud Control. The reason generalizes — CC UpdateResource invokes the resource
// provider's UPDATE handler, the SAME path a CloudFormation stack update uses, which
// already wires those sub-APIs. So a removed collection re-applies wherever CFn itself
// can set the property; no new SDK writer is warranted for these common types. The
// integ proof lives in tests/integration/{events-rule-target-revert,asg-notification-
// revert}; this unit test locks the revert PLAN those fixtures exercise (a declared
// removed-collection finding → one `cc` item with `add /Prop`).
describe('removed declared collection reverts via Cloud Control add /Prop (issue #421 TASK 2)', () => {
  const removedCollection = (over: Partial<Finding>): Finding => ({
    tier: 'declared',
    logicalId: 'R',
    physicalId: 'phys-1',
    resourceType: 'AWS::Events::Rule',
    path: 'Targets',
    desired: [{ Id: 'Target0', Arn: 'arn:aws:sns:us-east-1:111111111111:t' }],
    actual: undefined,
    ...over,
  });

  it('EventBridge Rule Targets removed -> one cc item: add /Targets (no SDK writer)', () => {
    const f = removedCollection({});
    const plan = buildRevertPlan([f], undefined);
    expect(plan.notRevertable).toEqual([]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('cc');
    expect(plan.items[0]!.ops).toEqual([
      expect.objectContaining({ op: 'add', path: '/Targets', value: f.desired }),
    ]);
  });

  it('ASG NotificationConfigurations removed (CC omits when empty) -> add /NotificationConfigurations', () => {
    const f = removedCollection({
      resourceType: 'AWS::AutoScaling::AutoScalingGroup',
      path: 'NotificationConfigurations',
      desired: [{ TopicARN: 'arn:aws:sns:us-east-1:111111111111:t', NotificationTypes: ['x'] }],
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.notRevertable).toEqual([]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('cc'); // Cloud Control, not a dedicated SDK writer
    expect(plan.items[0]!.ops).toEqual([
      expect.objectContaining({
        op: 'add',
        path: '/NotificationConfigurations',
        value: f.desired,
      }),
    ]);
  });
});

describe('rejectedEmptyStripOps — service-rejected empty-array echoes (#481)', () => {
  const T = 'AWS::VpcLattice::Rule';
  const priorityOp: PatchOp = {
    op: 'add',
    path: '/Priority',
    value: 10,
    human: 'Priority -> deployed-template value',
  };
  const liveWithEmptyEcho = {
    Priority: 20,
    Match: {
      HttpMatch: {
        HeaderMatches: [],
        PathMatch: { Match: { Prefix: '/api' }, CaseSensitive: false },
      },
    },
  };

  it('appends a remove op for a live EMPTY HeaderMatches echo on a Priority-only revert', () => {
    // The live shape reproduced on CdkRealDriftIntegLatticeListener: the CC read echoes
    // Match.HttpMatch.HeaderMatches [] the template never declared, and the CC update
    // handler re-sends it to UpdateRule which requires >= 1 members — so the
    // Priority-only revert failed. The strip op drops the echo from the patched state.
    const strip = rejectedEmptyStripOps(T, [priorityOp], liveWithEmptyEcho);
    expect(strip).toHaveLength(1);
    expect(strip[0]).toMatchObject({ op: 'remove', path: '/Match/HttpMatch/HeaderMatches' });
    // serialized without a value (RFC6902 remove)
    expect(
      toPatchDocument({
        logicalId: 'HuntRule',
        displayId: 'HuntRule',
        resourceType: T,
        physicalId: 'arn:rule',
        kind: 'cc',
        ops: [priorityOp, ...strip],
      })
    ).toBe(
      JSON.stringify([
        { op: 'add', path: '/Priority', value: 10 },
        { op: 'remove', path: '/Match/HttpMatch/HeaderMatches' },
      ])
    );
  });

  it('a POPULATED live HeaderMatches is real data — never stripped', () => {
    const live = structuredClone(liveWithEmptyEcho);
    live.Match.HttpMatch.HeaderMatches = [
      { Name: 'x-tenant', Match: { Exact: 'a' } },
    ] as unknown as never[];
    expect(rejectedEmptyStripOps(T, [priorityOp], live)).toEqual([]);
  });

  it('an ABSENT pointer needs no strip (a remove on it would itself fail)', () => {
    expect(rejectedEmptyStripOps(T, [priorityOp], { Priority: 20 })).toEqual([]);
    expect(
      rejectedEmptyStripOps(T, [priorityOp], { Priority: 20, Match: { HttpMatch: {} } })
    ).toEqual([]);
  });

  it('an op already rewriting the pointer or an ancestor suppresses the strip', () => {
    const matchOp: PatchOp = {
      op: 'add',
      path: '/Match',
      value: { HttpMatch: { PathMatch: { Match: { Prefix: '/api' } } } },
      human: 'Match -> deployed-template value',
    };
    expect(rejectedEmptyStripOps(T, [matchOp], liveWithEmptyEcho)).toEqual([]);
    const exactOp: PatchOp = {
      op: 'remove',
      path: '/Match/HttpMatch/HeaderMatches',
      human: 'already handled',
    };
    expect(rejectedEmptyStripOps(T, [exactOp], liveWithEmptyEcho)).toEqual([]);
  });

  it('unknown types and missing live models are untouched', () => {
    expect(rejectedEmptyStripOps('AWS::SQS::Queue', [priorityOp], liveWithEmptyEcho)).toEqual([]);
    expect(rejectedEmptyStripOps(T, [priorityOp], undefined)).toEqual([]);
    expect(rejectedEmptyStripOps(T, [], liveWithEmptyEcho)).toEqual([]);
  });
});

describe('rejectedEmptyStripOps — array-WILDCARD husk inside array elements (#506)', () => {
  const T = 'AWS::ImageBuilder::DistributionConfiguration';
  const descOp: PatchOp = {
    op: 'add',
    path: '/Distributions/0/AmiDistributionConfiguration/Description',
    value: 'cdkrd probe AMI',
    human: 'Description -> deployed-template value',
  };
  // The live shape reproduced on CdkRealDriftIntegImageBuilderRich: the CC read echoes
  // TargetAccountIds [] inside EACH distribution's AmiDistributionConfiguration, and the
  // ImageBuilder update handler rejects it — so even a Description-only revert failed.
  const live = (n: number) => ({
    Distributions: Array.from({ length: n }, (_, i) => ({
      Region: 'us-east-1',
      AmiDistributionConfiguration: {
        Name: `img-${i}`,
        Description: 'cdkrd probe AMI MUTATED',
        AmiTags: { app: 'x' },
        TargetAccountIds: [],
      },
      FastLaunchConfigurations: [],
      LaunchTemplateConfigurations: [],
    })),
  });

  it('appends a remove op for the empty TargetAccountIds husk in every distribution', () => {
    const strip = rejectedEmptyStripOps(T, [descOp], live(2));
    expect(strip.map((o) => ({ op: o.op, path: o.path }))).toEqual([
      { op: 'remove', path: '/Distributions/0/AmiDistributionConfiguration/TargetAccountIds' },
      { op: 'remove', path: '/Distributions/1/AmiDistributionConfiguration/TargetAccountIds' },
    ]);
  });

  it('a POPULATED TargetAccountIds is real data — never stripped', () => {
    const l = live(1);
    (
      l.Distributions[0].AmiDistributionConfiguration as { TargetAccountIds: string[] }
    ).TargetAccountIds = ['111111111111'];
    expect(rejectedEmptyStripOps(T, [descOp], l)).toEqual([]);
  });

  it('an op already rewriting a distribution (an ancestor of the husk) suppresses the strip', () => {
    const wholeDistOp: PatchOp = {
      op: 'add',
      path: '/Distributions/0',
      value: {},
      human: 'Distributions[0] -> deployed-template value',
    };
    expect(rejectedEmptyStripOps(T, [wholeDistOp], live(1))).toEqual([]);
  });

  it('no Distributions array -> nothing to expand', () => {
    expect(rejectedEmptyStripOps(T, [descOp], { Name: 'dist' })).toEqual([]);
  });
});
