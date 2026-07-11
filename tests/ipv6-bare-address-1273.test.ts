// #1273 — the #981 RFC 5952 IPv6 canonicalization was CIDR-only: `canonicalIpv6Cidr`
// requires a `/prefix` and returns undefined for a BARE address, so every property
// whose value is a bare IPv6 address that AWS echoes canonical (EC2 Instance /
// NetworkInterface `Ipv6Addresses[].Ipv6Address`, Route53 AAAA `ResourceRecords`)
// still false-flagged `declared` drift on a non-canonical template spelling (uppercase
// hex, uncompressed zeros), survived record, and the offered revert wrote the
// non-canonical string back → EC2 re-canonicalizes → the revert never converges. The
// fix adds `canonicalIpv6Address` (same strict `parseIpv6Groups` gate) and has
// `canonicalizeIpv6CidrsDeep` try CIDR then bare, folding both compare sides to the one
// RFC 5952 form. A genuinely different address still surfaces; the strict parse keeps
// it FP-safe unscoped.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { canonicalIpv6Address, canonicalizeIpv6CidrsDeep } from '../src/normalize/noise.js';
import { canonicalizeForCompare } from '../src/normalize/pipeline.js';
import type { DesiredResource, SchemaInfo } from '../src/types.js';

describe('#1273 canonicalIpv6Address — RFC 5952 bare-address canonicalization', () => {
  it('lowercases uppercase hex', () => {
    expect(canonicalIpv6Address('2001:DB8::1')).toBe('2001:db8::1');
  });

  it('compresses an uncompressed all-zero run', () => {
    expect(canonicalIpv6Address('2001:db8:0:0:0:0:0:1')).toBe('2001:db8::1');
    expect(canonicalIpv6Address('2001:db8:0:0::1')).toBe('2001:db8::1');
  });

  it('strips leading zeros per group', () => {
    expect(canonicalIpv6Address('2001:0db8::0001')).toBe('2001:db8::1');
    expect(canonicalIpv6Address('2001:0DB8:0000:0000::1')).toBe('2001:db8::1');
  });

  it('canonicalizes the all-zero address', () => {
    expect(canonicalIpv6Address('0:0:0:0:0:0:0:0')).toBe('::');
    expect(canonicalIpv6Address('::')).toBe('::');
  });

  it('compresses the LEFTMOST longest zero run on ties', () => {
    expect(canonicalIpv6Address('2001:0:0:1:2:0:0:3')).toBe('2001::1:2:0:0:3');
  });

  it('preserves a genuinely different bare address as a distinct canonical form', () => {
    expect(canonicalIpv6Address('2001:db8::1')).not.toBe(canonicalIpv6Address('2001:db8::2'));
    expect(canonicalIpv6Address('2001:db8::2')).toBe('2001:db8::2');
  });

  it('returns undefined for a CIDR (that is canonicalIpv6Cidr territory)', () => {
    expect(canonicalIpv6Address('2001:db8::/32')).toBeUndefined();
    expect(canonicalIpv6Address('2001:db8::1/128')).toBeUndefined();
  });

  it('returns undefined for non-IPv6 strings (pass-through gate)', () => {
    // IPv4 dotted address.
    expect(canonicalIpv6Address('10.0.0.1')).toBeUndefined();
    // ARN — colon-heavy but not a valid hextet structure.
    expect(canonicalIpv6Address('arn:aws:iam::123456789012:role/MyRole')).toBeUndefined();
    // Arbitrary strings.
    expect(canonicalIpv6Address('hello')).toBeUndefined();
    expect(canonicalIpv6Address('not an address')).toBeUndefined();
    // Embedded-IPv4 tail form — rejected (an IPv4 dotted tail is not a hextet).
    expect(canonicalIpv6Address('::ffff:1.2.3.4')).toBeUndefined();
    // Too many / too few groups.
    expect(canonicalIpv6Address('2001:db8:0:0:0:0:0:0:1')).toBeUndefined();
    expect(canonicalIpv6Address('2001:db8')).toBeUndefined();
    // Group with > 4 hex digits.
    expect(canonicalIpv6Address('2001:db8:00000::1')).toBeUndefined();
  });
});

describe('#1273 canonicalizeIpv6CidrsDeep — folds bare addresses AND CIDRs', () => {
  it('canonicalizes bare IPv6 addresses nested in objects and arrays', () => {
    const model = {
      Ipv6Addresses: [{ Ipv6Address: '2001:DB8:0:0::1' }, { Ipv6Address: '2001:0db8::2' }],
      // A CIDR sibling still folds via the CIDR path.
      CidrIpv6: '2001:DB8:0:0::/32',
    };
    expect(canonicalizeIpv6CidrsDeep(model)).toEqual({
      Ipv6Addresses: [{ Ipv6Address: '2001:db8::1' }, { Ipv6Address: '2001:db8::2' }],
      CidrIpv6: '2001:db8::/32',
    });
  });

  it('leaves IPv4 addresses, ARNs, and arbitrary strings unchanged', () => {
    const model = {
      Ip: '10.0.0.1',
      Arn: 'arn:aws:iam::123456789012:role/MyRole',
      Other: 'just a string',
      Nested: { deep: ['a:b:c', 'foo/bar'] },
    };
    expect(canonicalizeIpv6CidrsDeep(model)).toEqual(model);
  });
});

describe('#1273 canonicalizeForCompare — folds equivalent bare IPv6-address spellings', () => {
  it('folds a non-canonical declared bare address to the canonical live form', () => {
    const declared = { Ipv6Address: '2001:DB8::1' };
    const live = { Ipv6Address: '2001:db8::1' };
    expect(canonicalizeForCompare(declared)).toEqual(canonicalizeForCompare(live));
  });

  it('still surfaces a genuinely different bare IPv6 address', () => {
    const declared = { Ipv6Address: '2001:db8::1' };
    const live = { Ipv6Address: '2001:db8::2' };
    expect(canonicalizeForCompare(declared)).not.toEqual(canonicalizeForCompare(live));
  });
});

// Mirror the issue's repro through a real classifyResource run: a declared
// non-canonical bare IPv6 address vs the RFC 5952 live echo must fold to NO declared
// drift, while a genuinely different live address still surfaces.
const schema: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};

function instanceResource(declaredAddr: string): DesiredResource {
  return {
    logicalId: 'I',
    resourceType: 'AWS::EC2::Instance',
    physicalId: 'i-1',
    constructPath: 'Stack/I',
    declared: { Ipv6Addresses: [{ Ipv6Address: declaredAddr }] },
  } as DesiredResource;
}

function instanceLive(liveAddr: string): Record<string, unknown> {
  return { Ipv6Addresses: [{ Ipv6Address: liveAddr }] };
}

describe('#1273 classifyResource — EC2 Instance bare Ipv6Address', () => {
  it('non-canonical declared vs canonical live folds to NO declared drift', () => {
    const findings = classifyResource(
      instanceResource('2001:DB8::1'),
      instanceLive('2001:db8::1'),
      schema
    );
    const declared = findings.filter((f) => f.tier === 'declared');
    expect(declared).toEqual([]);
  });

  it('a genuinely different live IPv6 address still surfaces as declared drift', () => {
    const findings = classifyResource(
      instanceResource('2001:db8::1'),
      instanceLive('2001:db8::2'),
      schema
    );
    const declared = findings.filter((f) => f.tier === 'declared');
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.some((f) => f.path.includes('Ipv6Address'))).toBe(true);
  });
});
