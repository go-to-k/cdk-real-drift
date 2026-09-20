<!-- Part of the /hunt-bugs skill. Stage 6. READ IN FULL when your run enters this stage. -->

### 6. On a confirmed bug: file an issue, then fix it — with a unit test (mandatory)

**Always file a GitHub issue for every confirmed bug** (`gh issue create`), even when
you fix it in the same session — every bug becomes a tracked, claimable unit, so
nothing is silently lost and parallel sessions do not duplicate it. An issue-only
round files the issue and stops there; a fix-in-session round still files it, then
closes it from the PR. The body carries the real repro (live model / commands) so the
later fixer has the evidence. Search the open issues first and fold a hit into the
existing one rather than minting a duplicate — a hunt is the highest-volume filer.

**Every issue this hunt files also carries the four classification lines**
(`CLAUDE.md` → "The four TODO fields"), in English, one field per line:

```text
Session-fit: now (do it in this session) | next (not this session) - <reason>
Severity: high | medium | low - <what stays broken while it is undone>
Effort: small (S) | medium (M) | large (L) - <which verification cycle it drags>
Estimate: <duration, e.g. ~1-3 h -- never a bare letter> - <what eats the time>
```

**Two of the four are ALSO LABELS on the filed issue** — the body lines stay exactly
as written, and the same values ride the command as
`--label severity:<high|medium|low> --label effort:<small|medium|large>`, since prose
is invisible to `gh issue list`. `Session-fit` and `Estimate` get no label (the first
is re-decided at claim time, the second is a free-form duration). The fix PR inherits
the issue's labels via `.github/workflows/pr-inherit-issue-labels.yml`, so never
hand-add them there.

A hunt is the best moment to write them: the bug is just-reproduced, so `Severity` is
measured rather than guessed.

When you then WORK an issue — this hunt's own or one already filed — **run
`/work-issues` and follow it** for the collision-safe start: it screens the issue's
comments for untrusted/malware content (never access or run an attachment) and claims
the issue with a `gh issue comment` BEFORE you edit.

Then fix it:

1. **Root-cause it** in `src/` (normalize / diff-classify / read-router / overrides /
   intrinsic-resolver / report — wherever the divergence-from-reality lives).
2. **Fix it in the worktree.**
3. **Add a unit test that fails without the fix and passes with it.** Mandatory: a bug
   found by integ MUST leave behind a unit test pinning the corrected behavior, since
   integ alone is too slow and expensive to be the only guard. Re-run `vp run build` +
   `vp run test`.
4. **Re-run the live repro with the fixed binary** to confirm the real-AWS behavior is
   now correct.
5. **Keep the fixture** as a committed regression integ under
   `tests/integration/<name>/`, in the SAME PR as the fix — never defer the integ.
6. **If the bug is a CLASS, prove it is closed for EVERY affected type.** Most real
   bugs here are not specific to the type that surfaced them: they live in shared code
   keyed on a schema flag, or in a normalizer applied to many types
   (go-to-k/cdk-real-drift#252 — found on ElastiCache, latent on RDS / DynamoDB / EC2 /
   Redshift / S3 / EFS). When the root cause generalizes:
   - **Map the blast radius.** Enumerate which other types/properties share the
     trigger (`aws cloudformation describe-type --type RESOURCE --type-name <T>
--query Schema`) and name them in the PR.
   - **Add a DATA-DRIVEN invariant test, not just a per-type one.** A hand-built
     single-type test proves the symptom is gone for ONE shape. Drive the test from
     the golden corpus's REAL schemas: load every `tests/corpus/*.json` (via
     `reviveSchema`), reproduce the trigger for each, and assert the invariant holds
     for ALL of them — it then self-extends as the corpus grows (reference:
     `tests/revert-plan.test.ts`, `create-only invariant over all real corpus
schemas`).
   - **Confirm it fails without the fix and passes with it**, like any regression
     test — then the whole class is proven closed, not just one instance.
