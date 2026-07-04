// Golden-corpus replay (R63): every case in tests/corpus/ is a REAL pipeline
// input set (resolved declared + raw live model + schema + opts) recorded from
// a live gather (`CDKRD_CORPUS_DIR=... cdkrd check ...`) or hand-curated. The
// normalize→classify pipeline is pure, so replaying `classifyResource` offline
// must reproduce the recorded findings exactly — any diff is a regression (or
// an intended behavior change, in which case the case's `expected` is updated
// in the same PR, making the semantic change visible in review).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import {
  type CorpusCase,
  decodeUnresolved,
  reviveOpts,
  reviveSchema,
} from '../src/corpus/record.js';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding } from '../src/types.js';

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), 'corpus');
const files = readdirSync(corpusDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

const byTierPath = (a: Finding, b: Finding): number => {
  const ka = `${a.tier} ${a.path}`;
  const kb = `${b.tier} ${b.path}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

describe('golden corpus replay (R63)', () => {
  it('corpus is not empty', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(file, () => {
      const c = JSON.parse(readFileSync(join(corpusDir, file), 'utf8')) as CorpusCase;
      expect(c.corpusVersion).toBe(1);
      const resource = {
        ...c.resource,
        declared: decodeUnresolved(c.resource.declared),
      } as DesiredResource;
      // classify strips/mutates its inputs' copies — pass fresh clones so a case file is
      // never the thing being mutated. reviveOpts turns the stored bucketNotificationManaged
      // array back into the Set classify expects (clusterEchoModel passes through as-is).
      const got = classifyResource(
        resource,
        structuredClone(c.liveRaw),
        reviveSchema(c.schema),
        reviveOpts(c.opts)
      );
      expect([...got].sort(byTierPath)).toEqual([...c.expected].sort(byTierPath));
    });
  }
});
