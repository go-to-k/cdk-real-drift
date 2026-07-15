// #1652 — ACM DNS-validation CNAMEs false-'added' on hosted-zone stacks.
//
// An AWS::CertificateManager::Certificate with DomainValidationOptions.HostedZoneId makes
// the CFn/ACM handler write its validation record
// (`_<32-hex>.<domain> CNAME _<token>.<random>.acm-validations.aws.`) DIRECTLY into the
// zone. The record is not a stack resource in ANY stack, so the declared-record match (and
// the sibling-stack membership probe) can never fold it — every certificate showed a false
// `[Added]` CNAME on the zone. Fix: a deterministic pattern fold in
// diffRoute53HostedZoneChildren, same mechanism/placement as the apex NS/SOA filter: a live
// CNAME whose ResourceRecords are a SINGLE value inside acm-validations.aws is by
// construction ACM-managed. SES DKIM records are DELIBERATELY not folded (mail-spoofing /
// takeover vector).
import { describe, expect, it } from 'vite-plus/test';
import { diffRoute53HostedZoneChildren } from '../src/read/child-enumerators.js';

const ZONE = 'Z1234567890ABC';
const APEX = 'example.com';

const diff = (
  liveRecords: {
    name: string;
    type: string;
    setIdentifier?: string | undefined;
    live?: Record<string, unknown> | undefined;
  }[]
) =>
  diffRoute53HostedZoneChildren({
    hostedZoneId: ZONE,
    zoneApex: APEX,
    declaredRecords: [],
    liveRecords,
  });

describe('diffRoute53HostedZoneChildren — ACM DNS-validation CNAME fold (#1652)', () => {
  it('folds an ACM validation CNAME (single ResourceRecord into acm-validations.aws, trailing dot)', () => {
    const added = diff([
      {
        name: '_abc123def456abc123def456abc123de.example.com.',
        type: 'CNAME',
        live: {
          Name: '_abc123def456abc123def456abc123de.example.com.',
          Type: 'CNAME',
          ResourceRecords: ['_deadbeefdeadbeefdeadbeefdeadbeef.xyzrandom.acm-validations.aws.'],
        },
      },
    ]);
    expect(added).toEqual([]);
  });

  it('folds the variant WITHOUT the trailing dot on the target value', () => {
    const added = diff([
      {
        name: '_abc123def456abc123def456abc123de.example.com.',
        type: 'CNAME',
        live: {
          Name: '_abc123def456abc123def456abc123de.example.com.',
          Type: 'CNAME',
          ResourceRecords: ['_deadbeefdeadbeefdeadbeefdeadbeef.xyzrandom.acm-validations.aws'],
        },
      },
    ]);
    expect(added).toEqual([]);
  });

  it('KEEPS an SES DKIM CNAME (dkim.amazonses.com) — rogue DKIM is a mail-spoofing vector', () => {
    const added = diff([
      {
        name: 'token._domainkey.example.com.',
        type: 'CNAME',
        live: {
          Name: 'token._domainkey.example.com.',
          Type: 'CNAME',
          ResourceRecords: ['foo.dkim.amazonses.com'],
        },
      },
    ]);
    expect(added.map((a) => a.label)).toEqual(['CNAME token._domainkey.example.com']);
  });

  it('KEEPS a CNAME with TWO ResourceRecords even when one matches (single-value requirement)', () => {
    const added = diff([
      {
        name: '_abc123def456abc123def456abc123de.example.com.',
        type: 'CNAME',
        live: {
          Name: '_abc123def456abc123def456abc123de.example.com.',
          Type: 'CNAME',
          ResourceRecords: [
            '_deadbeefdeadbeefdeadbeefdeadbeef.xyzrandom.acm-validations.aws.',
            'evil.example.net',
          ],
        },
      },
    ]);
    expect(added.map((a) => a.label)).toEqual([
      'CNAME _abc123def456abc123def456abc123de.example.com',
    ]);
  });

  it('KEEPS a non-CNAME (TXT) whose value matches the target pattern (CNAME-only fold)', () => {
    const added = diff([
      {
        name: '_probe.example.com.',
        type: 'TXT',
        live: {
          Name: '_probe.example.com.',
          Type: 'TXT',
          ResourceRecords: ['_deadbeefdeadbeefdeadbeefdeadbeef.xyzrandom.acm-validations.aws.'],
        },
      },
    ]);
    expect(added.map((a) => a.label)).toEqual(['TXT _probe.example.com']);
  });

  it('leaves the existing apex NS/SOA behavior untouched (apex filtered, delegation NS kept)', () => {
    const added = diff([
      { name: 'example.com.', type: 'SOA', live: {} },
      { name: 'example.com.', type: 'NS', live: {} }, // apex NS -> filtered
      { name: 'sub.example.com.', type: 'NS', live: { Name: 'sub.example.com.', Type: 'NS' } }, // delegation -> kept
      {
        name: '_abc123def456abc123def456abc123de.example.com.',
        type: 'CNAME',
        live: {
          Name: '_abc123def456abc123def456abc123de.example.com.',
          Type: 'CNAME',
          ResourceRecords: ['_deadbeefdeadbeefdeadbeefdeadbeef.xyzrandom.acm-validations.aws.'],
        },
      },
    ]);
    expect(added.map((a) => a.label)).toEqual(['NS sub.example.com']);
  });

  it('KEEPS a validation-shaped CNAME with NO live snippet (fail-safe: cannot verify the target)', () => {
    // The enumerator always builds a `live` snippet, but the pure diff accepts records
    // without one — an unverifiable target must NOT be assumed ACM-managed.
    const added = diff([{ name: '_abc123def456abc123def456abc123de.example.com.', type: 'CNAME' }]);
    expect(added.map((a) => a.label)).toEqual([
      'CNAME _abc123def456abc123def456abc123de.example.com',
    ]);
  });
});
