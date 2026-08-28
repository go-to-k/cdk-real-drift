<!-- Part of the /hunt-bugs skill. Stage files: principles.md (posture / goal / core principles), plan.md (workflow stages 0–2), deploy-and-detect.md (stages 3–4), harvest.md (stages 5–5.5), file-and-fix.md (stage 6), cleanup-and-ship.md (stages 7–9 + the cleanup gate), gotchas.md (appendix). READ THIS FILE IN FULL when your run enters this stage. -->

### 5. Harvest the live read into the golden corpus (EVERY round — bug or not)

This is the asset a hunt leaves behind even when it finds no bug. Every live read
you just paid for is a real `normalize`→`classify` pipeline input; capturing it as
a golden-corpus case turns this one-time deploy into a permanent **offline**
regression that runs in plain `vp run test` (no AWS) forever — `tests/corpus/*.json`
is replayed by `tests/corpus-replay.test.ts`, which re-runs `classifyResource` on
the recorded inputs and asserts the findings reproduce exactly (R63). A future
normalization change that would silently re-introduce an FP/FN on this resource
then fails a unit test instead of waiting for the next paid hunt.

So while a tracked stack is still deployed, record the corpus by setting
`CDKRD_CORPUS_DIR` on a `check` (it writes one sanitized case per readable
resource — account ids are stripped at record time):

```bash
CDKRD_CORPUS_DIR=/tmp/corpus-<name> node "$ROOT/dist/cli.js" check "$STACK" --region "$REGION"
```

Record on the FRESH deploy BEFORE `record` (no baseline) so the case captures the
full classification — the `atDefault`/undeclared folding, not a baseline-snapshotted
clean. Then promote the cases that add coverage into `tests/corpus/`:

- Each file is named `AWS__<Service>__<Type>.<LogicalId>.json`. Copy in the cases
  for types **not already present** — `ls tests/corpus/ | grep <Type>` first.
  Genuinely-new resource types are the win; skip near-duplicates of types already
  covered (VPC/subnet/route-table boilerplate a fixture drags along is usually
  already represented — don't flood the corpus with it). **Also check the exact
  FILENAME**: generic CDK logical ids (`VpcpublicSubnet1Subnet…`) collide across
  fixtures, and a same-name `cp` silently OVERWRITES the existing case — rename the
  new one with a distinct suffix (e.g. `AWS__EC2__Subnet.Ipv6AttachHunt.json`)
  when the id already exists (2026-07-12 hunt clobbered one this way).
- A promoted case whose `expected` pins an OPEN issue's wrong behavior WILL churn:
  parallel agents fix filed issues within hours, so after any rebase re-RUN classify
  over the promoted cases and regenerate `expected` (a throwaway env-gated test file
  that rewrites `c.expected` from `classifyResource` output beats hand-editing;
  delete it before commit). Three peer fixes landed mid-hunt on 2026-07-12 alone.
- Run `vp run test` and confirm the new `corpus-replay` cases pass. Commit the new
  corpus JSONs in the SAME PR as the fixture (and the fix, if any). An intended
  behavior change updates a case's `expected` in the same diff, making the semantic
  change reviewable.

The `*-rich` fixtures are exactly the rich configs worth pinning this way, so a
clean round still ships growing regression coverage — see the "A clean result IS a
result" gotcha.

### 5.5 First-run-noise sweep (shrink `[Not Recorded]` via KNOWN_DEFAULTS)

After promoting new corpus, run the offline first-run-noise sweep — the newly
harvested cases are exactly the fresh data it mines:

```bash
bash scripts/measure-noise.sh
```

It replays classify over `tests/corpus/*.json` and ranks every `undeclared`
`(type, path)`, flagging the constant-looking ones as `CANDIDATE`s to promote into
`KNOWN_DEFAULTS` (top-level) / `KNOWN_DEFAULT_PATHS` (nested) in
`src/normalize/noise.ts`. This matters because the CFn schema annotates a `default`
on only ~1% of properties (see `scripts/measure-schema-defaults.mjs` and
docs/ARCHITECTURE.md § 6), so these hand tables — not the schema — are what keeps a
first run's `[Not Recorded]` inventory small. Promote a candidate only when its
value is a genuine CONSTANT service default (not a per-resource id/ARN/name/AZ/window
the heuristic may over-flag); the fold is equality-gated, so a correct promotion can
never hide a real change, and a recorded value that later moves off the default
still surfaces. Add the entries + a `noise-and-strip` test in the SAME PR. This is a
quality/noise pass, not a bug — skip it on a round that ships no new corpus.
