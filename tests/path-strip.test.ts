import { describe, expect, it } from 'vite-plus/test';
import { deepStripPaths } from '../src/normalize/path-strip.js';
import { parseSchema } from '../src/schema/schema-strip.js';

describe('deepStripPaths', () => {
  it('strips a top-level path', () => {
    const o: Record<string, unknown> = { A: 1, B: 2 };
    deepStripPaths(o, ['A']);
    expect(o).toEqual({ B: 2 });
  });

  it('strips a nested path with * over array elements', () => {
    const o: Record<string, unknown> = {
      Rules: [
        { Id: 1, Transition: 'x' },
        { Id: 2, Transition: 'y' },
      ],
    };
    deepStripPaths(o, ['Rules.*.Transition']);
    expect(o).toEqual({ Rules: [{ Id: 1 }, { Id: 2 }] });
  });

  it('tolerates missing paths', () => {
    const o: Record<string, unknown> = { A: 1 };
    deepStripPaths(o, ['X.Y.Z', 'A.nope']);
    expect(o).toEqual({ A: 1 });
  });
});

describe('parseSchema nested paths', () => {
  it('keeps nested writeOnly out of the top-level set but in writeOnlyPaths', () => {
    const info = parseSchema(
      JSON.stringify({
        readOnlyProperties: ['/properties/Arn'],
        writeOnlyProperties: [
          '/properties/AccessControl',
          '/properties/LifecycleConfiguration/Rules/*/Transition',
        ],
      })
    );
    expect([...info.writeOnly]).toEqual(['AccessControl']); // nested NOT promoted to top-level
    expect(info.writeOnlyPaths).toContain('LifecycleConfiguration.Rules.*.Transition');
    expect(info.readOnlyPaths).toEqual(['Arn']);
  });
});
