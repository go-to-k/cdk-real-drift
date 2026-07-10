// #1068 — parseSchema builds the TOP-LEVEL `defaults` map from a property's `default`
// annotation EVEN when that property is written as `{ "$ref": "#/definitions/X" }` and the
// `default` lives inside definition X. Before the fix, the top-level loop only read a DIRECT
// `default` key on the property node, so a `$ref` property's default was skipped — a freshly
// deployed value that IS the schema default surfaced as first-run [Potential Drift]
// (IoTFleetWise DecoderManifest Status=DRAFT, HealthLake SseConfiguration, Deadline Queue
// DefaultBudgetAction, BedrockAgentCore Policy EnforcementMode).
//
// #1069 — the three schema collectors (collectDefaultPaths, collectUnorderedArrayPaths,
// collectFreeFormMapPaths) now descend `oneOf`/`anyOf`/`allOf` combinators. A combinator adds
// no path segment, so a fact under a variant branch is collected at the SAME path. Before the
// fix these facts were lost across ~30 registry types (Bedrock Flow LoopController default,
// CFn Hooks, VerifiedPermissions, DataBrew Recipe, SES MailManager).
import { describe, expect, it } from 'vite-plus/test';
import { parseSchema } from '../src/schema/schema-strip.js';

describe('#1068 top-level defaults resolve a $ref property', () => {
  it('pulls a `default` living inside the referenced definition into `defaults[k]`', () => {
    const info = parseSchema(
      JSON.stringify({
        typeName: 'AWS::Test::RefDefault',
        properties: {
          // A top-level property written as a bare $ref — its `default` is in definition Status.
          Status: { $ref: '#/definitions/Status' },
          // A direct default still works (regression guard).
          Mode: { type: 'string', default: 'STANDARD' },
        },
        definitions: {
          Status: { type: 'string', enum: ['ACTIVE', 'DRAFT'], default: 'DRAFT' },
        },
      })
    );
    expect(info.defaults).toEqual({ Status: 'DRAFT', Mode: 'STANDARD' });
  });

  it('follows a chain of $refs and does not loop on a recursive definition', () => {
    const info = parseSchema(
      JSON.stringify({
        typeName: 'AWS::Test::RefChain',
        properties: {
          A: { $ref: '#/definitions/A' },
          Loop: { $ref: '#/definitions/Loop' },
        },
        definitions: {
          A: { $ref: '#/definitions/B' },
          B: { type: 'string', default: 'chained' },
          // Self-referential: must not hang; contributes no default.
          Loop: { $ref: '#/definitions/Loop' },
        },
      })
    );
    expect(info.defaults).toEqual({ A: 'chained' });
  });

  it('leaves `defaults` empty when a $ref property has no default in its definition', () => {
    const info = parseSchema(
      JSON.stringify({
        typeName: 'AWS::Test::RefNoDefault',
        properties: { X: { $ref: '#/definitions/X' } },
        definitions: { X: { type: 'string' } },
      })
    );
    expect(info.defaults).toEqual({});
  });
});

describe('#1069 collectors descend oneOf/anyOf/allOf combinators', () => {
  it('collects a `default` under a oneOf branch into defaultPaths (same path)', () => {
    // Mirrors Bedrock Flow: Definition.Nodes.*.Configuration is a oneOf; one branch is a
    // LoopController whose MaxIterations has default 10.
    const info = parseSchema(
      JSON.stringify({
        typeName: 'AWS::Test::OneOfDefault',
        properties: {
          Configuration: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  LoopController: {
                    type: 'object',
                    properties: { MaxIterations: { type: 'integer', default: 10 } },
                  },
                },
              },
              { type: 'object', properties: { Other: { type: 'string' } } },
            ],
          },
        },
      })
    );
    expect(info.defaultPaths['Configuration.LoopController.MaxIterations']).toBe(10);
  });

  it('collects a `default` under an allOf branch into defaultPaths', () => {
    const info = parseSchema(
      JSON.stringify({
        typeName: 'AWS::Test::AllOfDefault',
        properties: {
          Settings: {
            allOf: [
              { type: 'object', properties: { Enabled: { type: 'boolean', default: false } } },
            ],
          },
        },
      })
    );
    expect(info.defaultPaths['Settings.Enabled']).toBe(false);
  });

  it('collects an insertionOrder:false scalar array under a oneOf branch (unorderedScalarPaths)', () => {
    const info = parseSchema(
      JSON.stringify({
        typeName: 'AWS::Test::OneOfUnordered',
        properties: {
          Variant: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  Ids: { type: 'array', insertionOrder: false, items: { type: 'string' } },
                },
              },
            ],
          },
        },
      })
    );
    expect(info.unorderedScalarPaths).toContain('Variant.Ids');
  });

  it('collects a free-form map under an anyOf branch (freeFormMapPaths)', () => {
    const info = parseSchema(
      JSON.stringify({
        typeName: 'AWS::Test::AnyOfMap',
        properties: {
          Config: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  Params: {
                    type: 'object',
                    additionalProperties: { type: 'string' },
                  },
                },
              },
            ],
          },
        },
      })
    );
    expect(info.freeFormMapPaths).toContain('Config.Params');
  });

  it('unions facts across MULTIPLE combinator branches', () => {
    // Each branch contributes a distinct default at a distinct path — all must be collected.
    const info = parseSchema(
      JSON.stringify({
        typeName: 'AWS::Test::MultiBranch',
        properties: {
          Node: {
            oneOf: [
              { type: 'object', properties: { A: { type: 'string', default: 'a' } } },
              { type: 'object', properties: { B: { type: 'string', default: 'b' } } },
            ],
          },
        },
      })
    );
    expect(info.defaultPaths).toMatchObject({ 'Node.A': 'a', 'Node.B': 'b' });
  });
});
