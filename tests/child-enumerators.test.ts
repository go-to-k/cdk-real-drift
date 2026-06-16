import { describe, expect, it } from 'vite-plus/test';
import { diffApiGatewayChildren } from '../src/read/child-enumerators.js';

const API = 'abc123';
const ROOT = 'rootres0';

describe('diffApiGatewayChildren', () => {
  it('flags an out-of-band ANY method on the root `/` resource (the reported bug)', () => {
    // Template declares no method on root; live has an ANY method added via the console.
    const added = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: ROOT,
      declaredResourceIds: ['childA'],
      declaredMethodKeys: [`childA|POST`], // a declared method elsewhere
      liveResources: [{ id: 'childA', path: '/scoring' }],
      liveMethodsByResource: {
        [ROOT]: [{ httpMethod: 'ANY' }],
        childA: [{ httpMethod: 'POST' }],
      },
    });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      resourceType: 'AWS::ApiGateway::Method',
      identifier: `${API}|${ROOT}|ANY`,
      label: 'ANY /',
    });
  });

  it('does not flag a method that IS declared on root', () => {
    const added = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: ROOT,
      declaredResourceIds: [],
      declaredMethodKeys: [`${ROOT}|ANY`],
      liveResources: [],
      liveMethodsByResource: { [ROOT]: [{ httpMethod: 'ANY' }] },
    });
    expect(added).toEqual([]);
  });

  it('flags an out-of-band Resource and does NOT double-report its methods', () => {
    const added = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: ROOT,
      declaredResourceIds: [], // 'ghost' resource is not in the template
      declaredMethodKeys: [],
      liveResources: [{ id: 'ghost', path: '/ghost' }],
      liveMethodsByResource: {
        [ROOT]: [],
        ghost: [{ httpMethod: 'GET' }, { httpMethod: 'POST' }],
      },
    });
    // Only the resource — its methods come with it (deleting the resource removes them).
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      resourceType: 'AWS::ApiGateway::Resource',
      identifier: `${API}|ghost`,
      label: '/ghost',
    });
  });

  it('flags an undeclared method on a DECLARED child resource', () => {
    const added = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: ROOT,
      declaredResourceIds: ['childA'],
      declaredMethodKeys: [`childA|POST`],
      liveResources: [{ id: 'childA', path: '/scoring' }],
      liveMethodsByResource: {
        childA: [{ httpMethod: 'POST' }, { httpMethod: 'DELETE' }], // DELETE added out of band
      },
    });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      resourceType: 'AWS::ApiGateway::Method',
      identifier: `${API}|childA|DELETE`,
      label: 'DELETE /scoring',
    });
  });

  it('is clean when every live child is declared', () => {
    const added = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: ROOT,
      declaredResourceIds: ['childA'],
      declaredMethodKeys: [`childA|POST`, `childA|OPTIONS`, `${ROOT}|GET`],
      liveResources: [{ id: 'childA', path: '/scoring' }],
      liveMethodsByResource: {
        [ROOT]: [{ httpMethod: 'GET' }],
        childA: [{ httpMethod: 'POST' }, { httpMethod: 'OPTIONS' }],
      },
    });
    expect(added).toEqual([]);
  });

  it('treats the implicit root resource as declared even when listed live', () => {
    // The root `/` resource itself is never an "added Resource" (created with the API).
    const added = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: ROOT,
      declaredResourceIds: [],
      declaredMethodKeys: [],
      liveResources: [{ id: ROOT, path: '/' }],
      liveMethodsByResource: { [ROOT]: [] },
    });
    expect(added).toEqual([]);
  });
});
