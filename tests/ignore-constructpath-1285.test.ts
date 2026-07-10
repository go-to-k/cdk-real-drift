// #1285: the `ignore` verb reconciles findings via applyBaseline but OMITTED
// `constructPathByLogical` from the opts — it was the only applyBaseline caller
// that did. A synthetic "baseline value removed since record" finding therefore
// carried no `constructPath` in the ignore verb, so the constructPath-form ignore
// rule that `check` writes by preference never matched it: the finding was
// re-offered in the multiselect and `ignore <stack> --yes` appended a second,
// logicalId-form rule that mergeIgnoreRules could not dedupe.
//
// This is an OFFLINE round-trip of that bug. It drives the ACTUAL opts the ignore
// verb builds (`ignoreApplyBaselineOpts`, extracted from runIgnore) so the test
// fails if that opts builder ever drops `constructPathByLogical` again — then feeds
// those opts through applyBaseline + a constructPath-form rule + applyIgnores to
// assert the synthetic "removed since record" finding is re-tagged `ignored`.
import { describe, expect, it } from 'vite-plus/test';
import { applyBaseline, type BaselineFile } from '../src/baseline/baseline-file.js';
import { ignoreApplyBaselineOpts } from '../src/commands/ignore.js';
import { applyIgnores, ignoreRuleFor } from '../src/config/config-file.js';
import type { DesiredResource, Finding } from '../src/types.js';

const STACK = 'MyStack';
const ACCOUNT = '111122223333';
const REGION = 'us-east-1';
const LOGICAL = 'Bucket';
const CONSTRUCT_PATH = `${STACK}/Bucket/Resource`;

// A resource whose value was recorded, then removed out of band since record.
const RESOURCES: DesiredResource[] = [
  {
    logicalId: LOGICAL,
    resourceType: 'AWS::S3::Bucket',
    physicalId: 'my-bucket',
    constructPath: CONSTRUCT_PATH,
    declared: {},
  },
];

const desired: Pick<import('../src/desired/template-adapter.js').Desired, 'resources'> = {
  resources: RESOURCES,
};

function baselineWithRecordedEntry(): BaselineFile {
  return {
    schemaVersion: 1,
    stackName: STACK,
    region: REGION,
    accountId: ACCOUNT,
    capturedAt: '',
    templateHash: '',
    recorded: [
      {
        logicalId: LOGICAL,
        resourceType: 'AWS::S3::Bucket',
        path: 'AccelerateConfiguration',
        value: { AccelerationStatus: 'Enabled' },
      },
    ],
  };
}

// The live findings do NOT contain the recorded path (removed since record) and the
// resource was NOT skipped/deleted, so applyBaseline synthesizes a single undeclared
// "baseline value removed since record" finding.
const LIVE_FINDINGS: Finding[] = [];

describe('#1285: ignore verb applyBaseline opts include constructPathByLogical', () => {
  it('ignoreApplyBaselineOpts populates constructPathByLogical from desired.resources', () => {
    // The regression guard on the actual opts builder: drop the line in ignore.ts and
    // this map is empty, so the assertions below fail.
    const opts = ignoreApplyBaselineOpts(desired);
    expect(opts.constructPathByLogical?.get(LOGICAL)).toBe(CONSTRUCT_PATH);
  });

  it('the synthetic "removed since record" finding carries the constructPath under the verb opts', () => {
    const out = applyBaseline(
      LIVE_FINDINGS,
      baselineWithRecordedEntry(),
      ignoreApplyBaselineOpts(desired)
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.note).toBe('baseline value removed since record');
    expect(out[0]!.constructPath).toBe(CONSTRUCT_PATH);
  });

  it('a constructPath-form ignore rule re-tags the finding to `ignored` (no re-offer / no duplicate rule)', () => {
    // The rule check.ts writes by preference: derived from a finding WITH a
    // constructPath, so it targets the within-stack construct path — NOT the logicalId.
    const rule = ignoreRuleFor(
      {
        tier: 'undeclared',
        logicalId: LOGICAL,
        resourceType: 'AWS::S3::Bucket',
        path: 'AccelerateConfiguration',
        constructPath: CONSTRUCT_PATH,
        desired: { AccelerationStatus: 'Enabled' },
        actual: undefined,
      },
      STACK,
      ACCOUNT,
      REGION
    );
    expect(rule.path).toBe('Bucket/Resource.AccelerateConfiguration');

    const config = { ignore: [rule] };
    const scope = { stackName: STACK, accountId: ACCOUNT, region: REGION };

    // Drive the ACTUAL ignore-verb opts: the synthetic finding gets its constructPath,
    // so the constructPath-form rule matches and applyIgnores re-tags it `ignored`.
    // (Without the fix, ignoreApplyBaselineOpts would omit constructPathByLogical, the
    // finding would carry no constructPath, the rule would miss, and the finding would
    // stay `undeclared` — re-offered, appending a duplicate logicalId-form rule.)
    const reconciled = applyIgnores(
      applyBaseline(LIVE_FINDINGS, baselineWithRecordedEntry(), ignoreApplyBaselineOpts(desired)),
      scope,
      config
    );
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]!.tier).toBe('ignored');
  });
});
