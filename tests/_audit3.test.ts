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
describe('audit3 full tiers', () => {
  it('runs', () => {
    console.log(
      'A3 nested-undeclared ALL=' +
        JSON.stringify(
          classifyResource(
            res('AWS::X::Y', { Conf: { Level: 'INFO' } }),
            { Conf: { Level: 'INFO', Destination: 's3' } },
            sc
          ).map((x) => x.tier + ':' + x.path)
        )
    );
    console.log(
      'A3 declared-missing ALL=' +
        JSON.stringify(
          classifyResource(res('AWS::X::Y', { P: 'declared-val' }), {}, sc).map(
            (x) => x.tier + ':' + x.path + '/' + (x.note ?? '')
          )
        )
    );
    console.log(
      'A3 nested-undeclared-array (declared list of obj, live obj has extra nested key)=' +
        JSON.stringify(
          classifyResource(
            res('AWS::X::Y', { Items: [{ Id: 'a', V: 1 }] }),
            { Items: [{ Id: 'a', V: 1, Extra: 9 }] },
            sc
          ).map((x) => x.tier + ':' + x.path)
        )
    );
    expect(true).toBe(true);
  });
});
