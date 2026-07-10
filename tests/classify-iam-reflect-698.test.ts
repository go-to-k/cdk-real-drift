// #698 — two IAM sibling attachment/membership reflections, live-proven on a clean deploy:
//  1. A sibling AWS::IAM::ManagedPolicy declaring `Roles:[thisRole]` attaches itself; the role's
//     live `ManagedPolicyArns` (a ListAttachedRolePolicies union) then carries the sibling ARN,
//     differing from its own declared `ManagedPolicyArns` — a DECLARED-tier FP that SURVIVES
//     record, whose whole-array revert would DETACH the sibling policy (destructive collateral).
//  2. A sibling AWS::IAM::UserToGroupAddition puts the user in a group; the user's live read echoes
//     an undeclared `Groups`. The addition resource is a CC-gap `skipped` type, verified nowhere.
// Fix: classify subtracts sibling-OWNED attachments/memberships from the reflected live arrays
// (fed from gather's buildSiblingManagedPolicyAttachments / buildSiblingUserGroups), leaving a
// genuinely out-of-band attachment/group (matching no sibling) to still surface.
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

const tierPaths = (fs: Finding[], t: string) => fs.filter((f) => f.tier === t).map((f) => f.path);

const mk = (
  resourceType: string,
  declared: Record<string, unknown>,
  physicalId = 'phys'
): DesiredResource => ({ logicalId: 'R', resourceType, physicalId, declared });

const OWN_ARN = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';
const SIBLING_ARN = 'arn:aws:iam::111111111111:policy/CdkRealDriftHuntIamSib-SiblingManaged-CMBNc4';
const OOB_ARN = 'arn:aws:iam::111111111111:policy/RogueManualAttachment';
const ROLE_PHYS = 'CdkRealDriftHuntIamSib-ProbeRole-e7vbvyk';

describe('#698 Role.ManagedPolicyArns sibling-ManagedPolicy attachment subtraction', () => {
  it('folds a sibling-attached ARN — no declared drift (the record-surviving FP is gone)', () => {
    const f = classifyResource(
      mk('AWS::IAM::Role', { ManagedPolicyArns: [OWN_ARN] }, ROLE_PHYS),
      { ManagedPolicyArns: [OWN_ARN, SIBLING_ARN] },
      emptySchema,
      { siblingManagedPolicyAttachments: { [ROLE_PHYS]: [SIBLING_ARN] } }
    );
    // The sibling ARN is subtracted from live, so live == declared == [OWN_ARN]: no drift at all.
    expect(tierPaths(f, 'declared')).not.toContain('ManagedPolicyArns');
    expect(tierPaths(f, 'undeclared')).not.toContain('ManagedPolicyArns');
    expect(f).toHaveLength(0);
  });

  it('still surfaces an out-of-band attached ARN with no matching sibling', () => {
    const f = classifyResource(
      mk('AWS::IAM::Role', { ManagedPolicyArns: [OWN_ARN] }, ROLE_PHYS),
      { ManagedPolicyArns: [OWN_ARN, SIBLING_ARN, OOB_ARN] },
      emptySchema,
      { siblingManagedPolicyAttachments: { [ROLE_PHYS]: [SIBLING_ARN] } }
    );
    // Sibling gone, but the rogue ARN remains → surfaces as a drift finding (declared array diff).
    expect(f.length).toBeGreaterThan(0);
    const drift = [...tierPaths(f, 'declared'), ...tierPaths(f, 'undeclared')];
    expect(drift).toContain('ManagedPolicyArns');
  });

  it('matches a sibling resolved to a bare name against a full-ARN live entry', () => {
    const NAME = 'CdkRealDriftHuntIamSib-SiblingManaged-CMBNc4';
    const f = classifyResource(
      mk('AWS::IAM::Role', { ManagedPolicyArns: [OWN_ARN] }, ROLE_PHYS),
      { ManagedPolicyArns: [OWN_ARN, SIBLING_ARN] },
      emptySchema,
      { siblingManagedPolicyAttachments: { [ROLE_PHYS]: [NAME] } }
    );
    expect(f).toHaveLength(0);
  });

  it('fails open — no sibling map leaves the reflected ARN surfaced (never hidden)', () => {
    const f = classifyResource(
      mk('AWS::IAM::Role', { ManagedPolicyArns: [OWN_ARN] }, ROLE_PHYS),
      { ManagedPolicyArns: [OWN_ARN, SIBLING_ARN] },
      emptySchema,
      {}
    );
    expect(f.length).toBeGreaterThan(0);
  });
});

const USER_PHYS = 'CdkRealDriftHuntIamSib-ProbeUser-L5Vk4Z';
const SIBLING_GROUP = 'CdkRealDriftHuntIamSib-ProbeGroup-ZSZE1sa';
const OOB_GROUP = 'ManuallyAddedGroup';

describe('#698 User.Groups sibling-UserToGroupAddition membership subtraction', () => {
  it('folds a group added only by a sibling UserToGroupAddition (undeclared FP is gone)', () => {
    const f = classifyResource(
      mk('AWS::IAM::User', {}, USER_PHYS),
      { UserName: USER_PHYS, Groups: [SIBLING_GROUP] },
      emptySchema,
      { siblingUserGroups: { [USER_PHYS]: [SIBLING_GROUP] } }
    );
    expect(tierPaths(f, 'undeclared')).not.toContain('Groups');
    // The whole Groups array folds away (empty == absent) — no per-member undeclared entry either.
    expect(f.some((x) => typeof x.path === 'string' && x.path.startsWith('Groups'))).toBe(false);
  });

  it('still surfaces an out-of-band group with no matching sibling', () => {
    const f = classifyResource(
      mk('AWS::IAM::User', {}, USER_PHYS),
      { UserName: USER_PHYS, Groups: [SIBLING_GROUP, OOB_GROUP] },
      emptySchema,
      { siblingUserGroups: { [USER_PHYS]: [SIBLING_GROUP] } }
    );
    // Sibling group subtracted; the manual group remains as undeclared inventory.
    const undeclared = tierPaths(f, 'undeclared');
    expect(undeclared.some((p) => typeof p === 'string' && p.includes('Groups'))).toBe(true);
    // And the sibling group is NOT reported anywhere.
    expect(JSON.stringify(f)).not.toContain(SIBLING_GROUP);
  });
});
