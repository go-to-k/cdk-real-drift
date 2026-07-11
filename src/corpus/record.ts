// Golden-corpus recording (R63). The normalize→classify pipeline is pure, so a
// resource's classification is fully determined by (resolved declared, raw live
// model, schema info, classify opts). Recording those four during a REAL gather
// turns every dogfood / integ run into permanent offline regression coverage:
// the replay test (tests/corpus-replay.test.ts) re-runs `classifyResource` on
// every committed case in tests/corpus/ and asserts the findings byte-for-byte
// — no AWS, runs in CI on every push.
//
// Recording is opt-in: `CDKRD_CORPUS_DIR=<dir> cdkrd check ...` writes one JSON
// case per readable resource. Account ids are sanitized automatically
// (replaced with 111111111111 EVERYWHERE, so ARN-identity suppression still
// replays identically); resource/stack NAMES are NOT — review a recording
// before committing it, and never commit cases recorded from confidential
// stacks (integ fixtures use fictional names and are always safe).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UNRESOLVED } from '../normalize/intrinsic-resolver.js';
import type { DesiredResource, Finding, SchemaInfo } from '../types.js';

export const CORPUS_DIR_ENV = 'CDKRD_CORPUS_DIR';

// The UNRESOLVED marker is a Symbol (not JSON-serializable); a recorded declared
// model swaps it for this sentinel string, and replay swaps it back — otherwise
// JSON.stringify would silently DROP the key and the replayed classification
// would diverge from the live one (no `unresolved` finding).
export const UNRESOLVED_SENTINEL = '__cdkrd_corpus_unresolved__';

function swapUnresolved(v: unknown, from: unknown, to: unknown): unknown {
  if (v === from) return to;
  if (Array.isArray(v)) return v.map((x) => swapUnresolved(x, from, to));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swapUnresolved(x, from, to)]));
  return v;
}

export function encodeUnresolved<T>(v: T): T {
  return swapUnresolved(v, UNRESOLVED, UNRESOLVED_SENTINEL) as T;
}

export function decodeUnresolved<T>(v: T): T {
  return swapUnresolved(v, UNRESOLVED_SENTINEL, UNRESOLVED) as T;
}

// JSON-serializable mirror of the classifyResource inputs + expected output.
export interface CorpusCase {
  corpusVersion: 1;
  // free-text: what this case locks in (filled in by hand when curating)
  description?: string;
  resource: {
    logicalId: string;
    resourceType: string;
    physicalId?: string;
    constructPath?: string;
    declared: Record<string, unknown>; // RESOLVED declared (post intrinsic resolution)
    siblingPolicyNames?: string[] | 'unresolved';
  };
  liveRaw: Record<string, unknown>; // un-stripped live model, as the reader returned it
  schema: {
    readOnly: string[];
    writeOnly: string[];
    createOnly: string[];
    readOnlyPaths: string[];
    writeOnlyPaths: string[];
    createOnlyPaths: string[];
    defaults: Record<string, unknown>;
    defaultPaths: Record<string, unknown>;
    unorderedScalarPaths?: string[]; // optional for backward compat with pre-insertionOrder cases
    unorderedObjectArrayPaths?: string[]; // optional for backward compat with pre-#459 cases
    freeFormMapPaths?: string[]; // optional for backward compat with pre-free-form-map cases
  };
  opts: {
    accountId: string;
    region: string;
    kmsAliasTargets: Record<string, string>;
    oaiCanonicalIds: Record<string, string>;
    // Sibling SecurityGroupIngress/Egress rules reflected into an SG's live arrays, keyed by
    // the SG's physical id. Only present (and only its own entry) on an AWS::EC2::SecurityGroup
    // case, so replay reproduces the sibling-rule subtraction; optional for back-compat.
    siblingSgRules?: Record<string, { ingress: unknown[]; egress: unknown[] }>;
    // This bucket's own physical id, present only when its S3 notifications are managed by a
    // Custom::S3BucketNotifications CR, so replay reproduces the NotificationConfiguration drop.
    // Stored as an array (JSON has no Set); replay revives it to a Set. Optional for back-compat.
    bucketNotificationManaged?: string[];
    // This EIP's own identity (physicalId, else logicalId), present only when a declared sibling
    // (an AWS::EC2::EIPAssociation or an AWS::EC2::NatGateway consuming it) explains its live
    // NetworkInterfaceId, so replay reproduces the reflected-association drop and the case folds
    // atDefault exactly as a real check does. Stored as an array (JSON has no Set); replay revives
    // it to a Set. Optional for back-compat (pre-#892 cases and non-EIP cases lack it).
    siblingEipAssociations?: string[];
    // #1498: this Subnet's own identity (physicalId, else logicalId), present only when a declared
    // sibling AWS::EC2::SubnetCidrBlock assigns its IPv6 CIDR, so replay reproduces the reflected
    // Ipv6CidrBlock echo drop. Stored as an array (JSON has no Set); replay revives it to a Set.
    // Optional for back-compat (pre-#1498 cases and non-Subnet cases lack it).
    siblingSubnetCidrBlocks?: string[];
    // This TargetGroup's own identity (physicalId, else logicalId), present only when a declared
    // sibling dynamically registers into it (an ECS Service, an ASG, or its own lambda TargetType),
    // so replay reproduces the `generated` Targets fold and the case folds exactly as a real check
    // does. Stored as an array (JSON has no Set); replay revives it to a Set. Optional for
    // back-compat (pre-#891 cases and non-TargetGroup cases lack it).
    siblingTargetGroupRegistrars?: string[];
    // The parent DBCluster's live model keyed by THIS instance's physical id — present only on a
    // CLUSTER_ECHO_CHILD case (an Aurora DBInstance echoing its cluster), so replay reproduces the
    // cluster-echo strip. Without it a fresh-harvested reader/writer replays the un-folded echo
    // props as false undeclared drift. Optional for back-compat (pre-clusterEcho cases lack it).
    clusterEchoModel?: Record<string, Record<string, unknown>>;
    // #978: this OptionGroup's option-default catalog keyed by its own physical id — present only
    // on an AWS::RDS::OptionGroup case, so replay reproduces the default-fill fold. Optional for
    // back-compat (pre-#978 cases and non-OptionGroup cases lack it).
    rdsOptionSettingDefaults?: Record<string, Record<string, Record<string, string | null>>>;
    // #975: the sibling listener's first port, keyed by its ARN — present only on an
    // AWS::GlobalAccelerator::EndpointGroup case (carried by its declared ListenerArn), so replay
    // reproduces the HealthCheckPort derive. Optional for back-compat (non-EndpointGroup cases lack it).
    siblingListenerPorts?: Record<string, number>;
  };
  expected: Finding[]; // what classifyResource produced at record time (reviewed at commit)
}

/** Deep-replace every occurrence of `accountId` inside string values (ARNs,
 *  physical ids, policy principals, ...) with the fixed sanitized id. Applied
 *  uniformly to inputs AND expected findings, so account-scoped suppression
 *  (arn-identity) replays exactly as it ran live. */
export function sanitizeAccountId<T>(value: T, accountId: string): T {
  if (!accountId) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.split(accountId).join('111111111111');
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** Assemble a corpus case from one classified resource (already-sanitized by the caller). */
export function buildCorpusCase(
  resource: DesiredResource,
  liveRaw: Record<string, unknown>,
  schema: SchemaInfo,
  opts: {
    accountId: string;
    region: string;
    kmsAliasTargets: Record<string, string>;
    oaiCanonicalIds: Record<string, string>;
    siblingSgRules?: Record<string, { ingress: unknown[]; egress: unknown[] }>;
    bucketNotificationManaged?: Set<string>;
    siblingEipAssociations?: Set<string>;
    siblingSubnetCidrBlocks?: Set<string>;
    siblingTargetGroupRegistrars?: Set<string>;
    clusterEchoModel?: Record<string, Record<string, unknown>>;
    rdsOptionSettingDefaults?: Record<string, Record<string, Record<string, string | null>>>;
    siblingListenerPorts?: Record<string, number>;
  },
  findings: Finding[]
): CorpusCase {
  // Carry only THIS SG's sibling-rule entry (keyed by its own physical id) into the case, so
  // replay reproduces the subtraction without bloating every case with the stack-wide map.
  const sgSibling =
    resource.resourceType === 'AWS::EC2::SecurityGroup' && resource.physicalId
      ? opts.siblingSgRules?.[resource.physicalId]
      : undefined;
  // Same shape as sgSibling: carry ONLY this resource's own entry from the stack-wide maps, so a
  // cluster-echo / bucket-notification case replays its strip without bloating every case.
  const bucketNotif =
    resource.physicalId && opts.bucketNotificationManaged?.has(resource.physicalId)
      ? [resource.physicalId]
      : undefined;
  // Carry ONLY this EIP's own identity from the stack-wide sibling-association set. classify keys
  // the reflected-NetworkInterfaceId drop on the physicalId first, else the logicalId — carry the
  // same one that is present, so replay folds the same way the live check did.
  const eipSiblingId =
    resource.physicalId && opts.siblingEipAssociations?.has(resource.physicalId)
      ? resource.physicalId
      : opts.siblingEipAssociations?.has(resource.logicalId)
        ? resource.logicalId
        : undefined;
  // Carry ONLY this TG's own identity from the stack-wide registrar set. classify keys the
  // Targets `generated` fold on the physicalId first, else the logicalId — carry the same one that
  // is present, so replay folds the same way the live check did.
  const tgRegistrarId =
    resource.physicalId && opts.siblingTargetGroupRegistrars?.has(resource.physicalId)
      ? resource.physicalId
      : opts.siblingTargetGroupRegistrars?.has(resource.logicalId)
        ? resource.logicalId
        : undefined;
  // #1498: carry ONLY this Subnet's own identity from the stack-wide sibling-SubnetCidrBlock set.
  // classify keys the reflected Ipv6CidrBlock drop on the physicalId first, else the logicalId —
  // carry the same one that is present, so replay drops the echo the same way the live check did.
  const subnetSiblingId =
    resource.physicalId && opts.siblingSubnetCidrBlocks?.has(resource.physicalId)
      ? resource.physicalId
      : opts.siblingSubnetCidrBlocks?.has(resource.logicalId)
        ? resource.logicalId
        : undefined;
  const echoModel =
    resource.physicalId && opts.clusterEchoModel?.[resource.physicalId]
      ? opts.clusterEchoModel[resource.physicalId]
      : undefined;
  // #978: carry ONLY this OptionGroup's catalog entry (keyed by its own physical id).
  const rdsOptCatalog =
    resource.physicalId && opts.rdsOptionSettingDefaults?.[resource.physicalId]
      ? opts.rdsOptionSettingDefaults[resource.physicalId]
      : undefined;
  // #975: carry ONLY this EndpointGroup's listener-port entry (keyed by its declared ListenerArn),
  // so replay reproduces the HealthCheckPort derive without bloating every case with the map.
  const listenerArn =
    resource.resourceType === 'AWS::GlobalAccelerator::EndpointGroup'
      ? (resource.declared as Record<string, unknown>)?.ListenerArn
      : undefined;
  const gaListenerPort =
    typeof listenerArn === 'string' && opts.siblingListenerPorts?.[listenerArn] !== undefined
      ? { [listenerArn]: opts.siblingListenerPorts[listenerArn] }
      : undefined;
  const c: CorpusCase = {
    corpusVersion: 1,
    resource: {
      logicalId: resource.logicalId,
      resourceType: resource.resourceType,
      ...(resource.physicalId !== undefined && { physicalId: resource.physicalId }),
      ...(resource.constructPath !== undefined && { constructPath: resource.constructPath }),
      declared: encodeUnresolved(resource.declared),
      ...(resource.siblingPolicyNames !== undefined && {
        siblingPolicyNames: resource.siblingPolicyNames,
      }),
    },
    liveRaw,
    schema: {
      readOnly: [...schema.readOnly].sort(),
      writeOnly: [...schema.writeOnly].sort(),
      createOnly: [...schema.createOnly].sort(),
      readOnlyPaths: [...schema.readOnlyPaths].sort(),
      writeOnlyPaths: [...schema.writeOnlyPaths].sort(),
      createOnlyPaths: [...schema.createOnlyPaths].sort(),
      defaults: schema.defaults,
      defaultPaths: schema.defaultPaths,
      unorderedScalarPaths: [...(schema.unorderedScalarPaths ?? [])].sort(),
      unorderedObjectArrayPaths: [...(schema.unorderedObjectArrayPaths ?? [])].sort(),
      freeFormMapPaths: [...(schema.freeFormMapPaths ?? [])].sort(),
    },
    opts: {
      accountId: opts.accountId,
      region: opts.region,
      kmsAliasTargets: opts.kmsAliasTargets,
      oaiCanonicalIds: opts.oaiCanonicalIds,
      ...(sgSibling && resource.physicalId
        ? { siblingSgRules: { [resource.physicalId]: sgSibling } }
        : {}),
      ...(bucketNotif ? { bucketNotificationManaged: bucketNotif } : {}),
      ...(eipSiblingId ? { siblingEipAssociations: [eipSiblingId] } : {}),
      ...(subnetSiblingId ? { siblingSubnetCidrBlocks: [subnetSiblingId] } : {}),
      ...(tgRegistrarId ? { siblingTargetGroupRegistrars: [tgRegistrarId] } : {}),
      ...(echoModel && resource.physicalId
        ? { clusterEchoModel: { [resource.physicalId]: echoModel } }
        : {}),
      ...(rdsOptCatalog && resource.physicalId
        ? { rdsOptionSettingDefaults: { [resource.physicalId]: rdsOptCatalog } }
        : {}),
      ...(gaListenerPort ? { siblingListenerPorts: gaListenerPort } : {}),
    },
    expected: findings,
  };
  return sanitizeAccountId(c, opts.accountId);
}

/** Revive a case's schema arrays into the SchemaInfo Sets classify expects. */
export function reviveSchema(s: CorpusCase['schema']): SchemaInfo {
  return {
    readOnly: new Set(s.readOnly),
    writeOnly: new Set(s.writeOnly),
    createOnly: new Set(s.createOnly),
    readOnlyPaths: [...s.readOnlyPaths],
    writeOnlyPaths: [...s.writeOnlyPaths],
    createOnlyPaths: [...s.createOnlyPaths],
    defaults: s.defaults,
    defaultPaths: s.defaultPaths ?? {},
    unorderedScalarPaths: s.unorderedScalarPaths ?? [],
    unorderedObjectArrayPaths: s.unorderedObjectArrayPaths ?? [],
    freeFormMapPaths: s.freeFormMapPaths ?? [],
  };
}

/** Revive a case's stored opts into the shape classifyResource expects: the JSON case stores
 *  `bucketNotificationManaged` / `siblingEipAssociations` / `siblingTargetGroupRegistrars` as arrays
 *  (JSON has no Set) but classify wants Sets, so convert them; every other opts field passes through
 *  unchanged. Both replay call sites (corpus-replay + measure-noise) go through here so they stay in
 *  lockstep. */
export function reviveOpts(o: CorpusCase['opts']): Omit<
  CorpusCase['opts'],
  | 'bucketNotificationManaged'
  | 'siblingEipAssociations'
  | 'siblingSubnetCidrBlocks'
  | 'siblingTargetGroupRegistrars'
> & {
  bucketNotificationManaged?: Set<string>;
  siblingEipAssociations?: Set<string>;
  siblingSubnetCidrBlocks?: Set<string>;
  siblingTargetGroupRegistrars?: Set<string>;
} {
  const {
    bucketNotificationManaged,
    siblingEipAssociations,
    siblingSubnetCidrBlocks,
    siblingTargetGroupRegistrars,
    ...rest
  } = o;
  return {
    ...rest,
    ...(bucketNotificationManaged
      ? { bucketNotificationManaged: new Set(bucketNotificationManaged) }
      : {}),
    ...(siblingEipAssociations ? { siblingEipAssociations: new Set(siblingEipAssociations) } : {}),
    ...(siblingSubnetCidrBlocks
      ? { siblingSubnetCidrBlocks: new Set(siblingSubnetCidrBlocks) }
      : {}),
    ...(siblingTargetGroupRegistrars
      ? { siblingTargetGroupRegistrars: new Set(siblingTargetGroupRegistrars) }
      : {}),
  };
}

/** `AWS::S3::Bucket` + `MyBucket` -> `AWS__S3__Bucket.MyBucket.json` */
export function corpusFileName(resourceType: string, logicalId: string): string {
  return `${resourceType.replace(/::/g, '__')}.${logicalId}.json`;
}

export async function recordCorpusCase(dir: string, c: CorpusCase): Promise<string> {
  await mkdir(dir, { recursive: true });
  const p = join(dir, corpusFileName(c.resource.resourceType, c.resource.logicalId));
  await writeFile(p, JSON.stringify(c, null, 2) + '\n', 'utf8');
  return p;
}
