<!-- Part of the /hunt-bugs skill. Stages 5–5.5. READ IN FULL when your run enters this stage. -->

### 5. Harvest the live read into the golden corpus (EVERY round — bug or not)

This is the asset a hunt leaves behind even when it finds no bug: every live read you
paid for becomes a permanent **offline** regression. `tests/corpus-replay.test.ts`
re-runs `classifyResource` over `tests/corpus/*.json` and asserts the findings
reproduce exactly (R63), so a normalization change that would re-introduce an FP/FN
fails a unit test instead of waiting for the next paid hunt.

While a tracked stack is still deployed, record the corpus by setting
`CDKRD_CORPUS_DIR` on a `check` (one sanitized case per readable resource; account ids
are stripped at record time):

```bash
CDKRD_CORPUS_DIR=/tmp/corpus-<name> node "$ROOT/dist/cli.js" check "$STACK" --region "$REGION"
```

Record on the FRESH deploy BEFORE `record` (no baseline) so the case captures the full
classification — the `atDefault`/undeclared folding, not a baseline-snapshotted clean.
Then promote the cases that add coverage into `tests/corpus/`:

- Each file is named `AWS__<Service>__<Type>.<LogicalId>.json`. Copy in the cases for
  types **not already present** — `ls tests/corpus/ | grep <Type>` first.
  Genuinely-new resource types are the win; skip near-duplicates (VPC/subnet/route
  boilerplate a fixture drags along is usually already represented). **Also check the
  exact FILENAME**: generic CDK logical ids collide across fixtures and a same-name
  `cp` silently OVERWRITES the existing case — give the new one a distinct suffix.
- A promoted case whose `expected` pins an OPEN issue's wrong behavior WILL churn:
  parallel agents fix filed issues within hours, so after any rebase re-RUN classify
  over the promoted cases and regenerate `expected` (a throwaway env-gated test file
  that rewrites `c.expected` from `classifyResource` output beats hand-editing; delete
  it before commit).
- Run `vp run test` and confirm the new `corpus-replay` cases pass. Commit the new
  corpus JSONs in the SAME PR as the fixture (and the fix, if any). An intended
  behavior change updates a case's `expected` in the same diff, making the semantic
  change reviewable.

The `*-rich` fixtures are exactly the rich configs worth pinning this way, so a clean
round still ships growing regression coverage — do NOT manufacture a fix to have
something to show.

### 5.5 First-run-noise sweep (shrink `[Not Recorded]` via KNOWN_DEFAULTS)

After promoting new corpus, run the offline first-run-noise sweep — the newly
harvested cases are exactly the fresh data it mines:

```bash
bash scripts/measure-noise.sh
```

It replays classify over `tests/corpus/*.json` and ranks every `undeclared`
`(type, path)`, flagging the constant-looking ones as `CANDIDATE`s to promote into
`KNOWN_DEFAULTS` (top-level) / `KNOWN_DEFAULT_PATHS` (nested) in
`src/normalize/noise.ts`. This matters because the CFn schema annotates a `default` on
only ~1% of properties (see `scripts/measure-schema-defaults.mjs` and
`docs/ARCHITECTURE.md` § 6), so these hand tables — not the schema — are what keeps a
first run's `[Not Recorded]` inventory small.

Promote a candidate only when its value is a genuine CONSTANT service default, not a
per-resource id / ARN / name / AZ / window the heuristic may over-flag. The fold is
equality-gated, so a correct promotion can never hide a real change. Add the entries
plus a `noise-and-strip` test in the SAME PR. This is a quality/noise pass, not a bug
— skip it on a round that ships no new corpus.
