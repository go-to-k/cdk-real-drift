// #1328 — a variant-WRAPPED top-level default (a property written as
// `"allOf": [ { "$ref": … }, { "default": "MCP" } ]`, e.g. an
// AWS::BedrockAgentCore::Gateway `ProtocolType`) must fold to atDefault on a clean
// first check, not surface as a first-run [Potential Drift] false positive.
//
// `collectDefaultPaths` already records the wrapped default under `schema.defaultPaths`
// (it descends variant branches), but the top-level undeclared fold in classify only
// consulted `schema.defaults` — which is built via `resolveRefNode` and, before this fix,
// did not descend variant branches, so it stayed absent for this shape. The fix teaches
// the fold to ALSO match `schema.defaultPaths[k]` (the authoritative per-top-level-key
// source) and, defense-in-depth, teaches `resolveRefNode` to descend variant branches so
// `schema.defaults` picks the wrapped default up too. Both stay EQUALITY-GATED: a value
// CHANGED away from the default still surfaces (out-of-band detection preserved).
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { parseSchema } from '../src/schema/schema-strip.js';
import type { DesiredResource, Finding } from '../src/types.js';

// The real BedrockAgentCore Gateway shape: ProtocolType is a variant wrapper carrying the
// annotated default, so `schema.defaults` (pre-fix) missed it while `defaultPaths` had it.
const GATEWAY_SCHEMA_JSON = JSON.stringify({
  typeName: 'AWS::BedrockAgentCore::Gateway',
  properties: {
    Name: { type: 'string' },
    ProtocolType: {
      allOf: [{ $ref: '#/definitions/GatewayProtocolType' }, { default: 'MCP' }],
    },
  },
  definitions: {
    GatewayProtocolType: { type: 'string', enum: ['MCP'] },
  },
});

const tier = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();

const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'Gateway',
  resourceType: 'AWS::BedrockAgentCore::Gateway',
  physicalId: 'test-gateway',
  declared,
});

describe('#1328 variant-wrapped top-level default folds via defaultPaths', () => {
  it('parseSchema records the allOf-wrapped default under defaultPaths (and defaults)', () => {
    const info = parseSchema(GATEWAY_SCHEMA_JSON);
    // The authoritative source — always populated for a top-level key.
    expect(info.defaultPaths.ProtocolType).toBe('MCP');
    // Defense-in-depth: resolveRefNode now descends the allOf branch, so `defaults` has it too.
    expect(info.defaults.ProtocolType).toBe('MCP');
  });

  it('does NOT surface an undeclared ProtocolType equal to the schema default (folds atDefault)', () => {
    const schema = parseSchema(GATEWAY_SCHEMA_JSON);
    const res = mk({ Name: 'my-gw' }); // ProtocolType OMITTED (undeclared)
    const f = classifyResource(res, { Name: 'my-gw', ProtocolType: 'MCP' }, schema, {});
    expect(tier(f, 'atDefault')).toContain('ProtocolType');
    expect(tier(f, 'undeclared')).not.toContain('ProtocolType');
  });

  it('STILL surfaces an out-of-band ProtocolType away from the default — detection preserved', () => {
    const schema = parseSchema(GATEWAY_SCHEMA_JSON);
    const res = mk({ Name: 'my-gw' }); // ProtocolType OMITTED (undeclared)
    const f = classifyResource(res, { Name: 'my-gw', ProtocolType: 'SOMETHING_ELSE' }, schema, {});
    expect(tier(f, 'undeclared')).toContain('ProtocolType');
    expect(tier(f, 'atDefault')).not.toContain('ProtocolType');
  });
});
