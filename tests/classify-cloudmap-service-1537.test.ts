// #1537 — Cloud Map DNS Service double FP on a barest CDK L2 PublicDnsNamespace + Service
// (live-proven on CdkrdHunt0713CloudmapPub, us-east-1, 2026-07-13):
//   1. declared-tier: the CDK L2 Service ALWAYS declares DnsConfig.NamespaceId, but
//      GetService's DnsConfig omits the deprecated echo — the reader now mirrors the live
//      top-level Service.NamespaceId into the projected DnsConfig when the DECLARED model
//      carries it (and only then, so raw-CFn templates without it stay unprojected).
//   2. undeclared-tier: Cloud Map derives `Type` at creation from the declared shape —
//      DnsConfig present -> "DNS_HTTP", absent -> "HTTP" — a fold-tier-2 derived default,
//      equality-gated so a genuinely different mode still surfaces.
import {
  GetServiceCommand,
  type Service,
  ServiceDiscoveryClient,
} from '@aws-sdk/client-servicediscovery';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { SDK_OVERRIDES } from '../src/read/overrides.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const sd = mockClient(ServiceDiscoveryClient);

const ctx = (physicalId: string, declared: Record<string, unknown> = {}) => ({
  physicalId,
  declared,
  region: 'us-east-1',
  accountId: '123456789012',
});

const read = (c: ReturnType<typeof ctx>) => SDK_OVERRIDES['AWS::ServiceDiscovery::Service'](c);

beforeEach(() => {
  sd.reset();
});

const liveService = {
  Id: 'srv-1234567890abcdef',
  Name: 'hunt-svc',
  NamespaceId: 'ns-tn6g37nbeg3jrbke',
  Type: 'DNS_HTTP',
  DnsConfig: {
    RoutingPolicy: 'MULTIVALUE',
    DnsRecords: [{ Type: 'A', TTL: 60 }],
  },
} as Service;

describe('#1537 ServiceDiscovery Service reader — DnsConfig.NamespaceId mirror', () => {
  it('projects the live top-level NamespaceId into DnsConfig when the template declares it (CDK L2 shape)', async () => {
    sd.on(GetServiceCommand).resolves({ Service: liveService });
    const out = await read(
      ctx('srv-1234567890abcdef', {
        Name: 'hunt-svc',
        DnsConfig: {
          NamespaceId: 'ns-tn6g37nbeg3jrbke',
          DnsRecords: [{ Type: 'A', TTL: 60 }],
          RoutingPolicy: 'MULTIVALUE',
        },
      })
    );
    expect((out as Record<string, unknown>).DnsConfig).toEqual({
      NamespaceId: 'ns-tn6g37nbeg3jrbke',
      RoutingPolicy: 'MULTIVALUE',
      DnsRecords: [{ Type: 'A', TTL: 60 }],
    });
  });

  it('keeps DnsConfig unprojected of NamespaceId when the template omits it (raw-CFn shape)', async () => {
    sd.on(GetServiceCommand).resolves({ Service: liveService });
    const out = await read(
      ctx('srv-1234567890abcdef', {
        Name: 'hunt-svc',
        DnsConfig: { DnsRecords: [{ Type: 'A', TTL: 60 }], RoutingPolicy: 'MULTIVALUE' },
      })
    );
    expect((out as Record<string, unknown>).DnsConfig).toEqual({
      RoutingPolicy: 'MULTIVALUE',
      DnsRecords: [{ Type: 'A', TTL: 60 }],
    });
  });
});

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

const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'HuntService',
  resourceType: 'AWS::ServiceDiscovery::Service',
  physicalId: 'srv-1234567890abcdef',
  declared,
});

describe('#1537 ServiceDiscovery Service Type derived default', () => {
  const dnsDeclared = {
    Name: 'hunt-svc',
    DnsConfig: {
      NamespaceId: 'ns-tn6g37nbeg3jrbke',
      DnsRecords: [{ Type: 'A', TTL: 60 }],
      RoutingPolicy: 'MULTIVALUE',
    },
  };

  it('folds the DNS_HTTP echo of a DNS-config service to atDefault', () => {
    const f = classifyResource(mk(dnsDeclared), { ...dnsDeclared, Type: 'DNS_HTTP' }, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('Type');
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
    expect(pathsByTier(f, 'declared')).toEqual([]);
  });

  it('folds the HTTP echo of an HTTP-namespace service (no DnsConfig) to atDefault', () => {
    const declared = { Name: 'hunt-http-svc' };
    const f = classifyResource(mk(declared), { ...declared, Type: 'HTTP' }, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('Type');
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('a Type that does not match the derivation still surfaces (equality gate)', () => {
    const declared = { Name: 'hunt-http-svc' };
    const f = classifyResource(mk(declared), { ...declared, Type: 'DNS_HTTP' }, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual(['Type']);
  });
});
