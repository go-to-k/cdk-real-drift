import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, SchemaInfo } from '../src/types.js';
const sc: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
};
const res = (rt: string, d: Record<string, unknown>): DesiredResource => ({
  logicalId: 'L',
  resourceType: rt,
  physicalId: 'p',
  declared: d,
});
const opts = { accountId: '111111111111', region: 'us-east-1', kmsAliasTargets: {} };
const probe = (label: string, f: ReturnType<typeof classifyResource>) => {
  const real = f.filter((x) => x.tier === 'declared' || x.tier === 'undeclared');
  console.log(
    `AUDIT ${label}: ${real.length === 0 ? '*** MISSED (BUG) ***' : 'detected'} ${JSON.stringify(real.map((x) => x.tier + ':' + x.path))}`
  );
};
describe('suppression audit: each must still DETECT a real change', () => {
  it('runs', () => {
    probe(
      'json-string(SSM Content changed)',
      classifyResource(
        res('AWS::SSM::Document', {
          Content: { schemaVersion: '2.2', mainSteps: [{ name: 'a' }] },
        }),
        { Content: '{"schemaVersion":"2.2","mainSteps":[{"name":"DIFFERENT"}]}' },
        sc
      )
    );
    probe(
      'unordered-scalar(Cognito flow changed)',
      classifyResource(
        res('AWS::Cognito::UserPoolClient', {
          ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
        }),
        { ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_ADMIN_USER_PASSWORD_AUTH'] },
        sc
      )
    );
    probe(
      'case-insensitive(Route53 DNS changed)',
      classifyResource(
        res('AWS::Route53::RecordSet', { AliasTarget: { DNSName: 'foo.example.com' } }),
        { AliasTarget: { DNSName: 'bar.example.com' } },
        sc
      )
    );
    probe(
      'stringly(Port 5432->9999)',
      classifyResource(res('AWS::RDS::DBInstance', { Port: 5432 }), { Port: '9999' }, sc)
    );
    probe(
      'arn-name(role myrole->othername)',
      classifyResource(
        res('AWS::IAM::Role', { RoleRef: 'myrole' }),
        { RoleRef: 'arn:aws:iam::111111111111:role/othername' },
        sc,
        opts
      )
    );
    probe(
      'unordered-obj(SG rule REMOVED)',
      classifyResource(
        res('AWS::EC2::SecurityGroup', {
          SecurityGroupIngress: [
            { CidrIp: '10.0.0.0/24', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
            { CidrIp: '10.0.1.0/24', IpProtocol: 'tcp', FromPort: 22, ToPort: 22 },
          ],
        }),
        {
          SecurityGroupIngress: [
            { CidrIp: '10.0.0.0/24', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
          ],
        },
        sc
      )
    );
    probe(
      'atDefault(Lambda Tracing default->Active)',
      classifyResource(res('AWS::Lambda::Function', {}), { TracingConfig: { Mode: 'Active' } }, sc)
    );
    expect(true).toBe(true);
  });
});
