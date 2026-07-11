import { describe, expect, it } from 'vite-plus/test';
import {
  deriveSpecHttpApiRouteKeys,
  deriveSpecRestApiPaths,
  diffApiGatewayChildren,
  diffApiGatewayV2Children,
} from '../src/read/child-enumerators.js';

// #1270: a Body-defined (OpenAPI / SpecRestApi) or quick-create API used to be BLANKET-skipped for
// child diffing (issues #714 / #960 / #1324) — safe against false positives, but blind to a
// GENUINE out-of-band child (a console-added `GET /admin-backdoor`), a false negative. The fix
// reconciles PER-CHILD against the declared spec, and FAILS OPEN (blanket-skip) whenever it cannot
// confidently derive the spec — a missed rogue is acceptable, a spec child flagged on a clean
// deploy is NOT (the core invariant).

const API = 'restapi01';
const ROOT = 'rootres0';

describe('deriveSpecRestApiPaths (#1270)', () => {
  it('derives paths + method keys, adding every ancestor segment', () => {
    const spec = deriveSpecRestApiPaths({
      paths: {
        '/items': { get: {}, post: {} },
        '/items/{id}': { 'x-amazon-apigateway-any-method': {} },
      },
    });
    expect(spec).not.toBeNull();
    // '/items/{id}' pulls in '/', '/items', '/items/{id}'.
    expect([...(spec?.paths ?? [])].sort()).toEqual(['/', '/items', '/items/{id}']);
    expect([...(spec?.methods ?? [])].sort()).toEqual([
      '/items/{id}|ANY',
      '/items|GET',
      '/items|POST',
    ]);
  });

  it('returns null for a non-object body, a BodyS3Location-style body, and a body missing paths', () => {
    expect(deriveSpecRestApiPaths('a-string')).toBeNull();
    expect(deriveSpecRestApiPaths(null)).toBeNull();
    expect(deriveSpecRestApiPaths(['/items'])).toBeNull();
    // BodyS3Location is a separate property — a Body value that is not a parseable object.
    expect(deriveSpecRestApiPaths({ Bucket: 'b', Key: 'k' })).toBeNull();
    expect(deriveSpecRestApiPaths({ openapi: '3.0.1' })).toBeNull(); // no paths
  });

  it('normalizes a trailing slash but keeps root `/`', () => {
    const spec = deriveSpecRestApiPaths({ paths: { '/items/': { get: {} }, '/': {} } });
    expect([...(spec?.paths ?? [])].sort()).toEqual(['/', '/items']);
    expect([...(spec?.methods ?? [])]).toEqual(['/items|GET']);
  });
});

describe('diffApiGatewayChildren Body-defined per-child reconcile (#1270)', () => {
  const specChildren = deriveSpecRestApiPaths({ paths: { '/items': { get: {} } } });

  it('suppresses spec-materialized resources/methods and surfaces a genuine backdoor', () => {
    const added = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: ROOT,
      declaredResourceIds: [],
      declaredMethodKeys: [],
      bodyDefined: true,
      specChildren,
      liveResources: [
        { id: ROOT, path: '/' },
        { id: 'itemsRes', path: '/items' },
        { id: 'backdoorRes', path: '/admin-backdoor' },
      ],
      liveMethodsByResource: {
        [ROOT]: [],
        itemsRes: [{ httpMethod: 'GET' }, { httpMethod: 'OPTIONS' }],
        backdoorRes: [{ httpMethod: 'ANY' }],
      },
    });
    // '/items' + its GET are in-spec → suppressed. OPTIONS on '/items' → suppressed (CORS carve).
    // Root '/' → suppressed. Only '/admin-backdoor' (resource) surfaces; its ANY method rides with
    // the added resource, so it is NOT double-reported.
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      resourceType: 'AWS::ApiGateway::Resource',
      identifier: `${API}|backdoorRes`,
      label: '/admin-backdoor',
    });
  });

  it('surfaces an out-of-band method added to an IN-SPEC resource (but never OPTIONS)', () => {
    const added = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: ROOT,
      declaredResourceIds: [],
      declaredMethodKeys: [],
      bodyDefined: true,
      specChildren,
      liveResources: [
        { id: ROOT, path: '/' },
        { id: 'itemsRes', path: '/items' },
      ],
      liveMethodsByResource: {
        [ROOT]: [],
        // GET is in-spec; DELETE is out of band; OPTIONS is CORS → never surfaced.
        itemsRes: [{ httpMethod: 'GET' }, { httpMethod: 'DELETE' }, { httpMethod: 'OPTIONS' }],
      },
    });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      resourceType: 'AWS::ApiGateway::Method',
      identifier: `${API}|itemsRes|DELETE`,
      label: 'DELETE /items',
    });
  });

  it('FAILS OPEN (returns []) when the Body is unparseable (specChildren = null)', () => {
    const added = diffApiGatewayChildren({
      apiId: API,
      rootResourceId: ROOT,
      declaredResourceIds: [],
      declaredMethodKeys: [],
      bodyDefined: true,
      specChildren: null,
      // Live children present — must NOT be flagged (blanket-skip / no false positive).
      liveResources: [
        { id: ROOT, path: '/' },
        { id: 'someRes', path: '/whatever' },
      ],
      liveMethodsByResource: { someRes: [{ httpMethod: 'GET' }] },
    });
    expect(added).toEqual([]);
  });
});

describe('diffApiGatewayV2Children route reconcile (#1270)', () => {
  const V2 = 'httpapi01';

  it('quick-create: suppresses `$default`, surfaces any other live route', () => {
    const added = diffApiGatewayV2Children({
      apiId: V2,
      declaredRouteIds: [],
      declaredIntegrationIds: [],
      liveIntegrations: [{ id: 'int0' }],
      specMaterialized: true,
      quickCreate: true,
      liveRoutes: [
        { id: 'defRoute', key: '$default' },
        { id: 'backdoorRoute', key: 'GET /admin-backdoor' },
      ],
    });
    // Integrations stay blanket-suppressed; only the non-`$default` route surfaces.
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      resourceType: 'AWS::ApiGatewayV2::Route',
      identifier: `${V2}|backdoorRoute`,
      label: 'GET /admin-backdoor',
    });
  });

  it('Body-defined: suppresses an in-spec route, surfaces an out-of-band one', () => {
    const specRouteKeys = deriveSpecHttpApiRouteKeys({ paths: { '/items': { get: {} } } });
    const added = diffApiGatewayV2Children({
      apiId: V2,
      declaredRouteIds: [],
      declaredIntegrationIds: [],
      liveIntegrations: [{ id: 'int0' }],
      specMaterialized: true,
      specRouteKeys,
      liveRoutes: [
        { id: 'itemsRoute', key: 'GET /items' },
        { id: 'backdoorRoute', key: 'GET /admin-backdoor' },
      ],
    });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      resourceType: 'AWS::ApiGatewayV2::Route',
      identifier: `${V2}|backdoorRoute`,
      label: 'GET /admin-backdoor',
    });
  });

  it('Body-defined FAILS OPEN (returns []) when specRouteKeys = null', () => {
    const added = diffApiGatewayV2Children({
      apiId: V2,
      declaredRouteIds: [],
      declaredIntegrationIds: [],
      liveIntegrations: [{ id: 'int0' }],
      specMaterialized: true,
      specRouteKeys: null,
      liveRoutes: [{ id: 'anyRoute', key: 'GET /whatever' }],
    });
    expect(added).toEqual([]);
  });

  it('deriveSpecHttpApiRouteKeys: verbs, any-method, $default, and null cases', () => {
    const keys = deriveSpecHttpApiRouteKeys({
      paths: {
        '/items': { get: {}, 'x-amazon-apigateway-any-method': {} },
        $default: {},
      },
    });
    expect([...(keys ?? [])].sort()).toEqual(['$default', 'ANY /items', 'GET /items']);
    expect(deriveSpecHttpApiRouteKeys('str')).toBeNull();
    expect(deriveSpecHttpApiRouteKeys({ openapi: '3.0' })).toBeNull();
  });
});
