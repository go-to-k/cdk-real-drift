// #981 — no IPv6-CIDR representation tolerance (permanent declared FP + non-converging
// revert). EC2 stores/echoes IPv6 CIDRs in RFC 5952 canonical form (lowercase hex,
// leading zeros stripped per group, the longest all-zero run compressed to `::`). A
// template declaring an equivalent NON-canonical spelling — uppercase, uncompressed,
// `::0/0` — otherwise false-flags declared drift on every check, survives record, and
// the offered revert writes the non-canonical string back → EC2 re-canonicalizes → the
// revert never converges. The fix folds BOTH compare sides to the one RFC 5952 form:
// equivalent spellings compare equal, a genuinely different CIDR still surfaces.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { canonicalizeIpv6CidrsDeep, canonicalIpv6Cidr } from '../src/normalize/noise.js';
import { canonicalizeForCompare } from '../src/normalize/pipeline.js';
import type { DesiredResource, SchemaInfo } from '../src/types.js';

describe('#981 canonicalIpv6Cidr — RFC 5952 canonicalization', () => {
  it('lowercases uppercase hex', () => {
    expect(canonicalIpv6Cidr('2001:DB8::/32')).toBe('2001:db8::/32');
  });

  it('compresses an uncompressed all-zero run', () => {
    expect(canonicalIpv6Cidr('2001:db8:0:0::/32')).toBe('2001:db8::/32');
    expect(canonicalIpv6Cidr('2001:db8:0:0:0:0:0:0/32')).toBe('2001:db8::/32');
  });

  it('strips leading zeros per group', () => {
    expect(canonicalIpv6Cidr('2001:0db8::/32')).toBe('2001:db8::/32');
    expect(canonicalIpv6Cidr('2001:0DB8:0000:0000::/32')).toBe('2001:db8::/32');
  });

  it('canonicalizes the all-v6 forms `::0/0` and `0:0:0:0:0:0:0:0/0`', () => {
    expect(canonicalIpv6Cidr('::0/0')).toBe('::/0');
    expect(canonicalIpv6Cidr('0:0:0:0:0:0:0:0/0')).toBe('::/0');
    expect(canonicalIpv6Cidr('::/0')).toBe('::/0');
  });

  it('compresses the LEFTMOST longest zero run on ties', () => {
    // Two equal-length (2) zero runs → the leftmost is compressed.
    expect(canonicalIpv6Cidr('2001:0:0:1:2:0:0:3/128')).toBe('2001::1:2:0:0:3/128');
  });

  it('preserves a genuinely different IPv6 CIDR as a distinct canonical form', () => {
    expect(canonicalIpv6Cidr('2001:DB8::/32')).not.toBe(canonicalIpv6Cidr('2001:dead::/32'));
    expect(canonicalIpv6Cidr('2001:dead::/32')).toBe('2001:dead::/32');
  });

  it('returns undefined for non-IPv6-CIDR strings (pass-through gate)', () => {
    // IPv4 CIDR — must not be touched.
    expect(canonicalIpv6Cidr('10.0.0.0/16')).toBeUndefined();
    expect(canonicalIpv6Cidr('0.0.0.0/0')).toBeUndefined();
    // ARN — colon-heavy but not a valid hextet structure.
    expect(canonicalIpv6Cidr('arn:aws:iam::123456789012:role/MyRole')).toBeUndefined();
    // Arbitrary strings.
    expect(canonicalIpv6Cidr('hello:world/1')).toBeUndefined();
    expect(canonicalIpv6Cidr('not a cidr')).toBeUndefined();
    // Bare address with no prefix.
    expect(canonicalIpv6Cidr('2001:db8::')).toBeUndefined();
    // Prefix out of 0..128 range.
    expect(canonicalIpv6Cidr('2001:db8::/129')).toBeUndefined();
    // Embedded-IPv4 tail form — handled conservatively (left unchanged).
    expect(canonicalIpv6Cidr('::ffff:1.2.3.4/128')).toBeUndefined();
    // Too many / too few groups.
    expect(canonicalIpv6Cidr('2001:db8:0:0:0:0:0:0:0/32')).toBeUndefined();
    expect(canonicalIpv6Cidr('2001:db8/32')).toBeUndefined();
    // Group with > 4 hex digits.
    expect(canonicalIpv6Cidr('2001:db8:00000::/32')).toBeUndefined();
  });
});

describe('#981 canonicalizeIpv6CidrsDeep — deep walk, FP-safe', () => {
  it('canonicalizes IPv6 CIDR strings nested in objects and arrays', () => {
    const model = {
      SecurityGroupIngress: [
        { CidrIpv6: '2001:DB8:0:0::/32', IpProtocol: 'tcp' },
        { CidrIp: '10.0.0.0/24', IpProtocol: 'tcp' },
      ],
      SecurityGroupEgress: [{ CidrIpv6: '::0/0' }],
    };
    expect(canonicalizeIpv6CidrsDeep(model)).toEqual({
      SecurityGroupIngress: [
        { CidrIpv6: '2001:db8::/32', IpProtocol: 'tcp' },
        { CidrIp: '10.0.0.0/24', IpProtocol: 'tcp' },
      ],
      SecurityGroupEgress: [{ CidrIpv6: '::/0' }],
    });
  });

  it('leaves IPv4 CIDRs, ARNs, and arbitrary strings unchanged', () => {
    const model = {
      Cidr: '10.0.0.0/16',
      Arn: 'arn:aws:iam::123456789012:role/MyRole',
      Other: 'just a string',
      Nested: { deep: ['a:b:c', 'foo/bar'] },
    };
    expect(canonicalizeIpv6CidrsDeep(model)).toEqual(model);
  });
});

describe('#981 canonicalizeForCompare — folds equivalent IPv6-CIDR spellings', () => {
  it('folds a non-canonical declared spelling to the canonical live form', () => {
    const declared = { CidrIpv6: '2001:DB8:0:0::/32' };
    const live = { CidrIpv6: '2001:db8::/32' };
    expect(canonicalizeForCompare(declared)).toEqual(canonicalizeForCompare(live));
  });

  it('still surfaces a genuinely different IPv6 CIDR', () => {
    const declared = { CidrIpv6: '2001:db8::/32' };
    const live = { CidrIpv6: '2001:dead::/32' };
    expect(canonicalizeForCompare(declared)).not.toEqual(canonicalizeForCompare(live));
  });
});

// Mirror the issue's repro through a real classifyResource run: a declared
// non-canonical IPv6 CIDR vs the RFC 5952 live echo must fold to NO declared drift,
// while a genuinely widened live rule still surfaces.
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

function sgResource(declaredCidr: string): DesiredResource {
  return {
    logicalId: 'Sg',
    resourceType: 'AWS::EC2::SecurityGroup',
    physicalId: 'sg-0ba527d158588a09f',
    constructPath: 'Stack/Sg',
    declared: {
      GroupDescription: 'Stack/Sg',
      SecurityGroupIngress: [
        {
          CidrIpv6: declaredCidr,
          Description: 'ssh ipv6',
          FromPort: 22,
          IpProtocol: 'tcp',
          ToPort: 22,
        },
      ],
      VpcId: 'vpc-079229bdc16536c07',
    },
  } as DesiredResource;
}

function sgLive(liveCidr: string): Record<string, unknown> {
  return {
    GroupDescription: 'Stack/Sg',
    GroupId: 'sg-0ba527d158588a09f',
    SecurityGroupIngress: [
      {
        CidrIpv6: liveCidr,
        Description: 'ssh ipv6',
        FromPort: 22,
        IpProtocol: 'tcp',
        ToPort: 22,
      },
    ],
    VpcId: 'vpc-079229bdc16536c07',
  };
}

describe('#981 classifyResource — SecurityGroup IPv6 CIDR', () => {
  it('non-canonical declared vs canonical live folds to NO declared drift', () => {
    const findings = classifyResource(
      sgResource('2001:DB8:0:0::/32'),
      sgLive('2001:db8::/32'),
      schema
    );
    const declared = findings.filter((f) => f.tier === 'declared');
    expect(declared).toEqual([]);
  });

  it('a genuinely different (widened) live IPv6 CIDR still surfaces as declared drift', () => {
    const findings = classifyResource(
      sgResource('2001:db8::/32'),
      sgLive('2001:dead::/32'),
      schema
    );
    const declared = findings.filter((f) => f.tier === 'declared');
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.some((f) => f.path.includes('CidrIpv6'))).toBe(true);
  });
});
