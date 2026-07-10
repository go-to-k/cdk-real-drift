// #1068 + #1069 — parseSchema must reach annotated schema defaults (and unordered-array /
// free-form-map declarations) that hide BEHIND a top-level `$ref` and INSIDE a
// oneOf/anyOf/allOf variant branch. Missing either surfaced the schema's OWN default as a
// first-run [Potential Drift] false positive (violating the zero-potential-drift invariant).
import { describe, expect, it } from 'vite-plus/test';
import { parseSchema } from '../src/schema/schema-strip.js';

describe('#1068 parseSchema resolves a top-level $ref to reach its default', () => {
  it('reads `default` from a definition referenced by a bare top-level $ref', () => {
    // Mirrors IoTFleetWise Status=DRAFT / Deadline Queue DefaultBudgetAction: the top-level
    // property is `{ "$ref": "#/definitions/StatusEnum" }` and the default lives on the def.
    const info = parseSchema(
      JSON.stringify({
        typeName: 'AWS::Test::RefDefault',
        properties: {
          Status: { $ref: '#/definitions/StatusEnum' },
          Name: { type: 'string' },
        },
        definitions: {
          StatusEnum: { type: 'string', enum: ['DRAFT', 'ACTIVE'], default: 'DRAFT' },
        },
      })
    );
    expect(info.defaults.Status).toBe('DRAFT');
    // A direct default still works, and a property with no default is absent.
    expect('Name' in info.defaults).toBe(false);
  });

  it('follows a chain of $refs to the default', () => {
    const info = parseSchema(
      JSON.stringify({
        typeName: 'AWS::Test::RefChain',
        properties: { Mode: { $ref: '#/definitions/A' } },
        definitions: {
          A: { $ref: '#/definitions/B' },
          B: { type: 'string', default: 'ENABLED' },
        },
      })
    );
    expect(info.defaults.Mode).toBe('ENABLED');
  });

  it('still reads a DIRECT top-level default (no regression)', () => {
    const info = parseSchema(
      JSON.stringify({
        typeName: 'AWS::Test::DirectDefault',
        properties: { Level: { type: 'string', default: 'INFO' } },
      })
    );
    expect(info.defaults.Level).toBe('INFO');
  });

  it('a circular / unresolvable top-level $ref yields no default (no crash)', () => {
    const info = parseSchema(
      JSON.stringify({
        typeName: 'AWS::Test::CircularRef',
        properties: { Loop: { $ref: '#/definitions/A' }, Missing: { $ref: '#/definitions/Nope' } },
        definitions: { A: { $ref: '#/definitions/A' } },
      })
    );
    expect('Loop' in info.defaults).toBe(false);
    expect('Missing' in info.defaults).toBe(false);
  });
});

describe('#1069 collectors descend oneOf/anyOf/allOf variant branches', () => {
  it('collects a nested `default` under a oneOf branch at the SAME path', () => {
    // The variant wrapper is transparent — a default inside a oneOf branch applies at the
    // property path of the node holding the oneOf, adding NO extra segment.
    const info = parseSchema(
      JSON.stringify({
        typeName: 'AWS::Test::OneOfDefault',
        properties: {
          Config: {
            type: 'object',
            properties: {
              Nested: {
                oneOf: [{ type: 'string', default: 'AUTO' }, { type: 'integer' }],
              },
            },
          },
        },
      })
    );
    expect(info.defaultPaths['Config.Nested']).toBe('AUTO');
  });

  it('collects a `default` under anyOf and a nested allOf at the same path', () => {
    const info = parseSchema(
      JSON.stringify({
        typeName: 'AWS::Test::AnyAllOf',
        properties: {
          A: { anyOf: [{ default: 'X' }, { type: 'string' }] },
          B: { allOf: [{ allOf: [{ default: 42 }] }] },
        },
      })
    );
    expect(info.defaultPaths.A).toBe('X');
    expect(info.defaultPaths.B).toBe(42);
  });

  it('collects an insertionOrder:false array declared inside a oneOf branch', () => {
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

  it('collects a free-form map declared inside an allOf branch', () => {
    const info = parseSchema(
      JSON.stringify({
        typeName: 'AWS::Test::AllOfMap',
        properties: {
          Settings: {
            allOf: [
              {
                type: 'object',
                properties: {
                  Vars: { type: 'object', additionalProperties: { type: 'string' } },
                },
              },
            ],
          },
        },
      })
    );
    expect(info.freeFormMapPaths).toContain('Settings.Vars');
  });

  it('a $ref inside a variant branch still resolves (branch + ref compose)', () => {
    const info = parseSchema(
      JSON.stringify({
        typeName: 'AWS::Test::VariantRef',
        properties: { Field: { oneOf: [{ $ref: '#/definitions/D' }] } },
        definitions: { D: { type: 'string', default: 'REF-DEFAULT' } },
      })
    );
    expect(info.defaultPaths.Field).toBe('REF-DEFAULT');
  });

  it('plain properties/items still collect (no regression)', () => {
    const info = parseSchema(
      JSON.stringify({
        typeName: 'AWS::Test::Plain',
        properties: {
          Level: {
            type: 'object',
            properties: { Depth: { type: 'integer', default: 3 } },
          },
          Names: { type: 'array', insertionOrder: false, items: { type: 'string' } },
          Labels: { type: 'object', additionalProperties: { type: 'string' } },
        },
      })
    );
    expect(info.defaultPaths['Level.Depth']).toBe(3);
    expect(info.unorderedScalarPaths).toContain('Names');
    expect(info.freeFormMapPaths).toContain('Labels');
  });

  it('does not infinitely recurse on deeply nested allOf', () => {
    // Build a pathological allOf nest deeper than the depth cap; must terminate.
    let node: unknown = { type: 'string', default: 'DEEP' };
    for (let i = 0; i < 100; i++) node = { allOf: [node] };
    const info = parseSchema(
      JSON.stringify({ typeName: 'AWS::Test::DeepAllOf', properties: { X: node } })
    );
    // Beyond the depth cap the default is simply not collected — but it does not hang/crash.
    expect(info).toBeDefined();
  });
});
