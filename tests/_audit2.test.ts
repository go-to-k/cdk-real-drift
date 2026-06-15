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
  defaultPaths: {},
};
const res = (rt: string, d: Record<string, unknown>): DesiredResource => ({
  logicalId: 'L',
  resourceType: rt,
  physicalId: 'p',
  declared: d,
});
const probe = (label: string, f: ReturnType<typeof classifyResource>, expectDetect = true) => {
  const real = f.filter((x) => x.tier === 'declared' || x.tier === 'undeclared');
  const got = real.length > 0;
  console.log(
    `AUDIT2 ${label}: ${got === expectDetect ? (got ? 'detected' : 'clean-ok') : '*** ' + (expectDetect ? 'MISSED (BUG)' : 'FALSE-POSITIVE') + ' ***'} ${JSON.stringify(real.map((x) => x.tier + ':' + x.path))}`
  );
};
describe('audit2: removal / nested-undeclared / type-mismatch / deep', () => {
  it('runs', () => {
    probe(
      'tag REMOVED (declared[A,B] live[A])',
      classifyResource(
        res('AWS::S3::Bucket', {
          Tags: [
            { Key: 'a', Value: '1' },
            { Key: 'b', Value: '2' },
          ],
        }),
        { Tags: [{ Key: 'a', Value: '1' }] },
        sc
      )
    );
    probe(
      'inline-policy stmt REMOVED',
      classifyResource(
        res('AWS::IAM::Role', {
          Policies: [
            {
              PolicyName: 'P',
              PolicyDocument: {
                Statement: [
                  { Effect: 'Allow', Action: 's3:Get', Resource: '*' },
                  { Effect: 'Allow', Action: 's3:Put', Resource: '*' },
                ],
              },
            },
          ],
        }),
        {
          Policies: [
            {
              PolicyName: 'P',
              PolicyDocument: { Statement: [{ Effect: 'Allow', Action: 's3:Get', Resource: '*' }] },
            },
          ],
        },
        sc
      )
    );
    probe(
      'NESTED undeclared (declared{A:{x:1}} live{A:{x:1,y:2}})',
      classifyResource(
        res('AWS::X::Y', { Conf: { Level: 'INFO' } }),
        { Conf: { Level: 'INFO', Destination: 's3' } },
        sc
      )
    );
    probe(
      'top-level undeclared (sanity)',
      classifyResource(res('AWS::X::Y', {}), { Extra: 'value' }, sc)
    );
    probe(
      'DEEP nested change (A.B.C 1->2)',
      classifyResource(res('AWS::X::Y', { A: { B: { C: 1 } } }), { A: { B: { C: 2 } } }, sc)
    );
    probe(
      'type mismatch (declared array, live scalar)',
      classifyResource(res('AWS::X::Y', { P: [1, 2] }), { P: 'scalar' }, sc)
    );
    probe(
      'declared scalar, live object',
      classifyResource(res('AWS::X::Y', { P: 'x' }), { P: { nested: 1 } }, sc)
    );
    probe(
      'declared key, live MISSING it (removed/null)',
      classifyResource(res('AWS::X::Y', { P: 'declared-val' }), {}, sc)
    );
    expect(true).toBe(true);
  });
});
