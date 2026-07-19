// False-positive probe: Route 53 routing policies with SetIdentifier — latency and
// failover records plus a HealthCheck. Weighted/geoproximity/multivalue have fixtures;
// latency and failover records had zero corpus/fixture coverage. The zone uses a
// placeholder domain (example.com/.test/.example are AWS-reserved and rejected); a
// public zone for an unowned domain creates fine, it just is not authoritative.
import { App, Stack, Tags } from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';

const app = new App();
Tags.of(app).add('cdkrd:ephemeral', '1');

const stack = new Stack(app, 'CdkrdHunt0720R53Policy');

const zone = new route53.PublicHostedZone(stack, 'Zone', {
  zoneName: 'cdkrd-hunt0720-x3f9.com',
});

// Latency-based pair (same name, per-region SetIdentifier).
new route53.CfnRecordSet(stack, 'LatUse1', {
  hostedZoneId: zone.hostedZoneId,
  name: 'lat.cdkrd-hunt0720-x3f9.com.',
  type: 'A',
  ttl: '60',
  resourceRecords: ['192.0.2.1'],
  setIdentifier: 'use1',
  region: 'us-east-1',
});
new route53.CfnRecordSet(stack, 'LatEuw1', {
  hostedZoneId: zone.hostedZoneId,
  name: 'lat.cdkrd-hunt0720-x3f9.com.',
  type: 'A',
  ttl: '60',
  resourceRecords: ['192.0.2.2'],
  setIdentifier: 'euw1',
  region: 'eu-west-1',
});

// Failover pair; the PRIMARY carries a health check. Route 53 REJECTS reserved /
// documentation IPs (192.0.2.x) with InvalidRequest, so probe a resolvable FQDN
// instead (example.com is reserved-but-resolvable; health status is irrelevant to
// the drift probe).
const health = new route53.CfnHealthCheck(stack, 'PrimaryHealth', {
  healthCheckConfig: {
    type: 'HTTP',
    fullyQualifiedDomainName: 'example.com',
    port: 80,
    resourcePath: '/',
    requestInterval: 30,
    failureThreshold: 3,
  },
});
new route53.CfnRecordSet(stack, 'FailPrimary', {
  hostedZoneId: zone.hostedZoneId,
  name: 'fo.cdkrd-hunt0720-x3f9.com.',
  type: 'A',
  ttl: '60',
  resourceRecords: ['192.0.2.20'],
  setIdentifier: 'primary',
  failover: 'PRIMARY',
  healthCheckId: health.attrHealthCheckId,
});
new route53.CfnRecordSet(stack, 'FailSecondary', {
  hostedZoneId: zone.hostedZoneId,
  name: 'fo.cdkrd-hunt0720-x3f9.com.',
  type: 'A',
  ttl: '60',
  resourceRecords: ['192.0.2.21'],
  setIdentifier: 'secondary',
  failover: 'SECONDARY',
});

app.synth();
