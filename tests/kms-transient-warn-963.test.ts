import { describe, expect, it } from 'vite-plus/test';
import { warnKmsAliasResolution } from '../src/commands/gather.js';
import {
  kmsListAliasesDeniedWarning,
  kmsListAliasesTransientWarning,
} from '../src/read/kms-aliases.js';

// #963: #789 stopped CACHING a transient kms:ListAliases failure but left the WARNING
// half wired to the wrong branch — gather only checked `.denied`, so a transient blip
// printed the permanent "denied — grant IAM" warning AND stamped the per-region
// `kmsDeniedWarned` dedupe, silencing every later stack in the region (including a later
// GENUINE denial). warnKmsAliasResolution must branch on `.transient`.

describe('warnKmsAliasResolution — transient vs definitive (#963)', () => {
  it('a TRANSIENT failure emits the transient warning, NOT the denied warning, and does NOT poison the region dedupe', () => {
    const region = 'us-east-1';
    const deniedWarned = new Set<string>();
    const msgs: string[] = [];
    const log = (m: string) => msgs.push(m);

    // Transient blip (throttle / 5xx that survived retry): not cached, flagged transient.
    warnKmsAliasResolution(
      { targets: {}, denied: true, transient: true },
      region,
      deniedWarned,
      log
    );

    expect(msgs).toEqual([kmsListAliasesTransientWarning(region)]);
    // Must NOT have printed the permanent-IAM diagnosis...
    expect(msgs[0]).not.toContain('Grant kms:ListAliases');
    // ...and must NOT have poisoned the dedupe set, so a later genuine denial still warns.
    expect(deniedWarned.has(region)).toBe(false);

    // Next stack in the SAME region hits a real denial: it must STILL surface the
    // permanent warning (the transient blip did not silence it).
    warnKmsAliasResolution({ targets: {}, denied: true }, region, deniedWarned, log);
    expect(msgs).toEqual([
      kmsListAliasesTransientWarning(region),
      kmsListAliasesDeniedWarning(region),
    ]);
    expect(deniedWarned.has(region)).toBe(true);
  });

  it('a DEFINITIVE denial emits the permanent warning once per region (dedupe holds)', () => {
    const region = 'eu-west-1';
    const deniedWarned = new Set<string>();
    const msgs: string[] = [];
    const log = (m: string) => msgs.push(m);

    warnKmsAliasResolution({ targets: {}, denied: true }, region, deniedWarned, log);
    // Second stack, same region: suppressed by the dedupe stamp.
    warnKmsAliasResolution({ targets: {}, denied: true }, region, deniedWarned, log);

    expect(msgs).toEqual([kmsListAliasesDeniedWarning(region)]);
    expect(deniedWarned.has(region)).toBe(true);
  });

  it('a successful resolution (not denied) emits nothing and leaves the dedupe untouched', () => {
    const region = 'ap-northeast-1';
    const deniedWarned = new Set<string>();
    const msgs: string[] = [];
    warnKmsAliasResolution(
      { targets: { 'alias/aws/sqs': 'key-sqs' }, denied: false },
      region,
      deniedWarned,
      (m) => msgs.push(m)
    );
    expect(msgs).toEqual([]);
    expect(deniedWarned.has(region)).toBe(false);
  });
});
