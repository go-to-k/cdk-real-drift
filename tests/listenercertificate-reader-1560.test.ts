// #1560 — AWS::ElasticLoadBalancingV2::ListenerCertificate has NO registry read handler, so Cloud
// Control throws UnsupportedActionException and the resource is silently Skipped. This SDK override
// reads elbv2:DescribeListenerCertificates (deriving the listener ARN from the declared ListenerArn)
// and projects ONLY this resource's DECLARED certs that are still in the live NON-DEFAULT set
// (FP-safe when multiple ListenerCertificate resources target one listener). A declared cert removed
// out of band drops from the model → declared drift; the listener's default cert is excluded.
import {
  DescribeListenerCertificatesCommand,
  ElasticLoadBalancingV2Client,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { SDK_OVERRIDES } from '../src/read/overrides.js';

const elbv2 = mockClient(ElasticLoadBalancingV2Client);

const LARN = 'arn:aws:elasticloadbalancing:us-east-1:111111111111:listener/app/HuntAlb/abc/def';
const A = 'arn:aws:acm:us-east-1:111111111111:certificate/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'arn:aws:acm:us-east-1:111111111111:certificate/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const C = 'arn:aws:acm:us-east-1:111111111111:certificate/cccccccc-cccc-cccc-cccc-cccccccccccc';
const DEFAULT_CERT =
  'arn:aws:acm:us-east-1:111111111111:certificate/dddddddd-dddd-dddd-dddd-dddddddddddd';

const ctx = (declared: Record<string, unknown>, physicalId = 'lc-composite-id') => ({
  physicalId,
  declared,
  region: 'us-east-1',
  accountId: '111111111111',
});
const read = (c: ReturnType<typeof ctx>) =>
  SDK_OVERRIDES['AWS::ElasticLoadBalancingV2::ListenerCertificate'](c);

beforeEach(() => elbv2.reset());

describe('AWS::ElasticLoadBalancingV2::ListenerCertificate SDK override (#1560)', () => {
  it('projects the declared extra cert(s), echoes ListenerArn, excludes the default cert', async () => {
    elbv2.on(DescribeListenerCertificatesCommand).resolves({
      Certificates: [
        { CertificateArn: DEFAULT_CERT, IsDefault: true },
        { CertificateArn: A, IsDefault: false },
      ],
    });
    const out = await read(ctx({ ListenerArn: LARN, Certificates: [{ CertificateArn: A }] }));
    expect(out).toEqual({ ListenerArn: LARN, Certificates: [{ CertificateArn: A }] });
    // scoped to the derived listener ARN
    expect(elbv2.commandCalls(DescribeListenerCertificatesCommand)[0].args[0].input).toEqual({
      ListenerArn: LARN,
      Marker: undefined,
    });
  });

  it('drops a declared cert that was removed out of band (→ surfaces as declared drift)', async () => {
    // declared [A,B] but live non-default only has A (B removed via remove-listener-certificates)
    elbv2.on(DescribeListenerCertificatesCommand).resolves({
      Certificates: [
        { CertificateArn: DEFAULT_CERT, IsDefault: true },
        { CertificateArn: A, IsDefault: false },
      ],
    });
    const out = await read(
      ctx({ ListenerArn: LARN, Certificates: [{ CertificateArn: A }, { CertificateArn: B }] })
    );
    expect(out).toEqual({ ListenerArn: LARN, Certificates: [{ CertificateArn: A }] });
  });

  it('is FP-safe when multiple ListenerCertificate resources target one listener', async () => {
    // this resource declares only A; the live listener also carries B + C (other resources / OOB)
    elbv2.on(DescribeListenerCertificatesCommand).resolves({
      Certificates: [
        { CertificateArn: DEFAULT_CERT, IsDefault: true },
        { CertificateArn: A, IsDefault: false },
        { CertificateArn: B, IsDefault: false },
        { CertificateArn: C, IsDefault: false },
      ],
    });
    const out = await read(ctx({ ListenerArn: LARN, Certificates: [{ CertificateArn: A }] }));
    // only A (declared ∩ live) — B/C are NOT attributed to this resource, so no false positive
    expect(out).toEqual({ ListenerArn: LARN, Certificates: [{ CertificateArn: A }] });
  });

  it('paginates the Marker so a cert on a later page is not misread as removed', async () => {
    elbv2
      .on(DescribeListenerCertificatesCommand)
      .resolvesOnce({
        Certificates: [{ CertificateArn: A, IsDefault: false }],
        NextMarker: 'page2',
      })
      .resolves({ Certificates: [{ CertificateArn: B, IsDefault: false }] });
    const out = await read(
      ctx({ ListenerArn: LARN, Certificates: [{ CertificateArn: A }, { CertificateArn: B }] })
    );
    expect(out).toEqual({
      ListenerArn: LARN,
      Certificates: [{ CertificateArn: A }, { CertificateArn: B }],
    });
    expect(elbv2.commandCalls(DescribeListenerCertificatesCommand)).toHaveLength(2);
  });

  it('returns undefined (skip) when the declared ListenerArn is unresolved', async () => {
    const out = await read(ctx({ Certificates: [{ CertificateArn: A }] }));
    expect(out).toBeUndefined();
    expect(elbv2.commandCalls(DescribeListenerCertificatesCommand)).toHaveLength(0);
  });
});
