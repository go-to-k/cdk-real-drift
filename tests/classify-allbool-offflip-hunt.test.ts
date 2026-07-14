// Hunt 2026-07-14 (all-boolean-object off-flip class closure): a KNOWN_DEFAULTS pin whose
// value is an object with ONLY boolean leaves flips ALL-FALSE when every toggle is disabled
// out of band, and isTrivialEmpty swallowed the all-false object BEFORE the pin gate — the
// GuardDuty DataSources shape (#1092), re-found live on SES ConfigurationSet and then closed
// for the whole class by a mechanical scan of KNOWN_DEFAULTS. Members fixed here:
//   - AWS::S3::Bucket PublicAccessBlockConfiguration — live-proven END-TO-END on a fresh CFn
//     bucket (us-east-1, CdkrdHuntRevconv5): `put-public-access-block` all-false left `check
//     --fail` at exit 0 while the CC read carried the all-false object. The most
//     security-critical member (the bucket is opened to public ACLs/policies).
//   - AWS::SES::EmailIdentity DkimAttributes / FeedbackAttributes — CC-read-shape live-proven
//     on a CLI-created identity (`--no-signing-enabled` / `--no-email-forwarding-enabled`
//     each read back {SigningEnabled: false} / {EmailForwardingEnabled: false}).
// Scanned and EXCLUDED with live/schema determinations: GuardDuty DataSources (already
// guarded), ECR ImageScanningConfiguration (pin is false), AmazonMQ EncryptionOptions
// (create-only), S3 AccessPoint PABC (no out-of-band mutate API), VpcLattice SharingConfig
// (UpdateServiceNetwork cannot flip it), EMRServerless MonitoringConfiguration (the service
// rejects the all-false state: "Either S3 Logging or Managed Debugging must be enabled").
// A DELETED bucket PAB config is ABSENT from the read (not all-false) — the vanished-
// undeclared-default limitation is a separate class, out of scope here.
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

describe('S3 Bucket PublicAccessBlockConfiguration wholesale off-flip (hunt 2026-07-14)', () => {
  const res: DesiredResource = {
    logicalId: 'TrailBucketA831CE63',
    resourceType: 'AWS::S3::Bucket',
    physicalId: 'cdkrdhuntrevconv5-trailbucketa831ce63-yfd2qczd2djh',
    declared: {},
  };
  const pab = (v: boolean) => ({
    RestrictPublicBuckets: v,
    BlockPublicPolicy: v,
    BlockPublicAcls: v,
    IgnorePublicAcls: v,
  });

  it('folds the fresh-bucket all-true shape to atDefault (first-run stays CLEAN)', () => {
    const f = classifyResource(res, { PublicAccessBlockConfiguration: pab(true) }, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('PublicAccessBlockConfiguration');
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('surfaces an out-of-band all-four disable (the live-proven FN)', () => {
    const f = classifyResource(res, { PublicAccessBlockConfiguration: pab(false) }, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual(['PublicAccessBlockConfiguration']);
  });

  it('a deleted PAB config (absent from the read) stays silent — no FP on legacy buckets', () => {
    const f = classifyResource(res, {}, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });
});

describe('SES EmailIdentity dkim/feedback off-flips (hunt 2026-07-14)', () => {
  const res: DesiredResource = {
    logicalId: 'Identity',
    resourceType: 'AWS::SES::EmailIdentity',
    physicalId: 'cdkrd-hunt-offflip.example.com',
    declared: { EmailIdentity: 'cdkrd-hunt-offflip.example.com' },
  };
  const live = (signing: boolean, forwarding: boolean) => ({
    EmailIdentity: 'cdkrd-hunt-offflip.example.com',
    DkimAttributes: { SigningEnabled: signing },
    FeedbackAttributes: { EmailForwardingEnabled: forwarding },
  });

  it('folds the fresh-identity true shapes to atDefault', () => {
    const f = classifyResource(res, live(true, true), emptySchema);
    expect(pathsByTier(f, 'atDefault')).toEqual(
      expect.arrayContaining(['DkimAttributes', 'FeedbackAttributes'])
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('surfaces an out-of-band --no-signing-enabled (DKIM disable)', () => {
    const f = classifyResource(res, live(false, true), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual(['DkimAttributes']);
  });

  it('surfaces an out-of-band --no-email-forwarding-enabled', () => {
    const f = classifyResource(res, live(true, false), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual(['FeedbackAttributes']);
  });
});
