import { KMSClient, ListAliasesCommand } from '@aws-sdk/client-kms';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  fetchManagedAliasTargets,
  isDefinitiveDenial,
  kmsListAliasesDeniedWarning,
  kmsListAliasesTransientWarning,
  kmsWarnDecision,
} from '../src/read/kms-aliases.js';

// #789: fetchManagedAliasTargets must cache ONLY definitive outcomes (success or a
// definitive access-denial). A TRANSIENT throttle / network blip must NOT be cached, so
// the next stack in the region re-queries instead of being blinded to a customer-managed-
// key swap for the whole run. The per-region cache is process-wide, so each scenario uses
// a DISTINCT region to avoid cross-test bleed.

const kms = mockClient(KMSClient);
beforeEach(() => kms.reset());

describe('fetchManagedAliasTargets — transient vs definitive caching (#789)', () => {
  it('does NOT cache a transient throttle: the next call for the same region re-queries and succeeds', async () => {
    const region = 'us-east-2';
    const throttle = Object.assign(new Error('rate exceeded'), {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 429 },
    });
    // First send throws a throttle (survives adaptive retry); every send after resolves.
    kms
      .on(ListAliasesCommand)
      .rejectsOnce(throttle)
      .resolves({ Aliases: [{ AliasName: 'alias/aws/rds', TargetKeyId: 'key-rds' }] });

    // First stack: degrades gracefully, flagged transient, NOT cached.
    const first = await fetchManagedAliasTargets(region);
    expect(first).toEqual({ targets: {}, denied: true, transient: true });

    // Second stack (same region): must RE-QUERY (cache was not poisoned) and resolve the
    // real targets — proving the transient failure did not blind detection for the run.
    const second = await fetchManagedAliasTargets(region);
    expect(second).toEqual({ targets: { 'alias/aws/rds': 'key-rds' }, denied: false });

    // Two ListAliases calls fired (the poisoned-cache bug would fire only one).
    expect(kms.commandCalls(ListAliasesCommand).length).toBe(2);
  });

  it('DOES cache a definitive AccessDeniedException: the next call is served from cache (no re-query)', async () => {
    const region = 'eu-west-3';
    kms.on(ListAliasesCommand).rejects(
      Object.assign(new Error('not authorized'), {
        name: 'AccessDeniedException',
        $metadata: { httpStatusCode: 403 },
      })
    );

    const first = await fetchManagedAliasTargets(region);
    expect(first).toEqual({ targets: {}, denied: true });
    expect(first.transient).toBeUndefined();

    const second = await fetchManagedAliasTargets(region);
    expect(second).toEqual({ targets: {}, denied: true });

    // Only ONE call: the definitive denial was cached and reused.
    expect(kms.commandCalls(ListAliasesCommand).length).toBe(1);
  });

  it('treats a 5xx / network blip as transient (not cached)', async () => {
    const region = 'ap-south-1';
    kms
      .on(ListAliasesCommand)
      .rejectsOnce(
        Object.assign(new Error('internal failure'), {
          name: 'InternalFailure',
          $metadata: { httpStatusCode: 500 },
        })
      )
      .resolves({ Aliases: [{ AliasName: 'alias/aws/s3', TargetKeyId: 'key-s3' }] });

    const first = await fetchManagedAliasTargets(region);
    expect(first.transient).toBe(true);
    const second = await fetchManagedAliasTargets(region);
    expect(second).toEqual({ targets: { 'alias/aws/s3': 'key-s3' }, denied: false });
    expect(kms.commandCalls(ListAliasesCommand).length).toBe(2);
  });
});

describe('isDefinitiveDenial (#789)', () => {
  it('is true for AccessDenied / AccessDeniedException / UnauthorizedOperation by name', () => {
    expect(isDefinitiveDenial({ name: 'AccessDeniedException' })).toBe(true);
    expect(isDefinitiveDenial({ name: 'AccessDenied' })).toBe(true);
    expect(isDefinitiveDenial({ name: 'UnauthorizedOperation' })).toBe(true);
  });
  it('is true for a definitive denial by code or by 403 status', () => {
    expect(isDefinitiveDenial({ code: 'AccessDeniedException' })).toBe(true);
    expect(isDefinitiveDenial({ $metadata: { httpStatusCode: 403 } })).toBe(true);
  });
  it('is false for throttle / 5xx / network / undefined (transient)', () => {
    expect(isDefinitiveDenial({ name: 'ThrottlingException' })).toBe(false);
    expect(
      isDefinitiveDenial({ name: 'InternalFailure', $metadata: { httpStatusCode: 500 } })
    ).toBe(false);
    expect(isDefinitiveDenial({ name: 'TimeoutError' })).toBe(false);
    expect(isDefinitiveDenial(undefined)).toBe(false);
  });
});

describe('kmsWarnDecision — transient vs genuine denial + dedupe split (#963)', () => {
  const region = 'us-east-1';

  it('a TRANSIENT failure emits the transient warning and stamps ONLY the transient set (never poisons the denial set)', () => {
    const d = kmsWarnDecision(region, { denied: true, transient: true }, false, false);
    expect(d.warning).toBe(kmsListAliasesTransientWarning(region));
    expect(d.stampTransient).toBe(true);
    // The #963 bug: a transient blip must NOT stamp the permanent-denial set, or a later
    // stack's real denial in the same region would be silenced.
    expect(d.stampDenied).toBe(false);
  });

  it('a GENUINE denial emits the denied warning and stamps the denial set', () => {
    const d = kmsWarnDecision(region, { denied: true, transient: false }, false, false);
    expect(d.warning).toBe(kmsListAliasesDeniedWarning(region));
    expect(d.stampDenied).toBe(true);
    expect(d.stampTransient).toBe(false);
  });

  it('a genuine denial still surfaces after a transient blip already warned in the region', () => {
    // transientWarned=true (the blip already warned), deniedWarned=false → the real denial
    // is NOT deduped away, because it uses the separate denial set.
    const d = kmsWarnDecision(region, { denied: true, transient: false }, false, true);
    expect(d.warning).toBe(kmsListAliasesDeniedWarning(region));
    expect(d.stampDenied).toBe(true);
  });

  it('dedupes each kind independently: no repeat warning once its own set is stamped', () => {
    expect(kmsWarnDecision(region, { denied: true, transient: true }, false, true).warning).toBe(
      null
    );
    expect(kmsWarnDecision(region, { denied: true, transient: false }, true, false).warning).toBe(
      null
    );
  });

  it('a successful read (not denied) emits nothing and stamps nothing', () => {
    const d = kmsWarnDecision(region, { denied: false }, false, false);
    expect(d).toEqual({ warning: null, stampDenied: false, stampTransient: false });
  });
});

describe('kmsListAliasesTransientWarning (#789)', () => {
  it('names the region, says transient/retry, and does NOT claim an IAM denial', () => {
    const w = kmsListAliasesTransientWarning('ap-northeast-1');
    expect(w).toContain('ap-northeast-1');
    expect(w.toLowerCase()).toContain('transient');
    expect(w.toLowerCase()).toContain('retried');
    // Must NOT tell the user their permissions are denied.
    expect(w).not.toContain('denied');
    expect(w).not.toContain('Grant kms:ListAliases');
  });
});
