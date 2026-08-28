<!-- Part of the /hunt-bugs skill. Stage files: principles.md (posture / goal / core principles), plan.md (workflow stages 0–2), deploy-and-detect.md (stages 3–4), harvest.md (stages 5–5.5), file-and-fix.md (stage 6), cleanup-and-ship.md (stages 7–9 + the cleanup gate), gotchas.md (appendix). READ THIS FILE IN FULL when your run enters this stage. -->

### 6. On a confirmed bug: file an issue, then fix it — with a unit test (mandatory)

**Always file a GitHub issue for every confirmed bug** (`gh issue create`), even
when you fix it in the same session — every bug becomes a tracked, claimable unit,
so nothing is silently lost and parallel agents/sessions don't duplicate it. An
issue-only hunt round files the issue and stops there (the fix comes later); a
fix-in-session round still files the issue, then closes it from the PR (`Closes
#<n>`). The issue body carries the real repro (live model / commands) so the later
fixer has the evidence.

**Every issue this hunt files also carries the four classification lines**
(`CLAUDE.md` -> "The four TODO fields"), in English, one field per line. It also
carries a `Dup-check:` line, which is a filing-time record of the open-issue search
and NOT a fifth classification field -- `.claude/hooks/issue-dup-check-gate.sh`
refuses `gh issue create` without it, and `/work-issues` section 5 has the search and
the fold-into-a-checklist-row recipe for a HIT. A hunt is the highest-volume filer
here, so it is the path where minting-by-default costs the most:

```text
Session-fit: now (do it in this session) | next (not this session) - <reason>
Severity: high | medium | low - <what stays broken while it is undone>
Effort: small (S) | medium (M) | large (L) - <which verification cycle it drags>
Estimate: <duration, e.g. ~1-3 h -- never a bare letter> - <what eats the time>
```

**Two of the four are ALSO LABELS on the filed issue** -- the body lines stay
exactly as written, and the same values ride the command as
`--label severity:<high|medium|low> --label effort:<small|medium|large>`. Prose
is invisible to `gh issue list`, so ranking by `Severity` costs one
`gh issue view` per candidate without them. `Session-fit` and `Estimate` get no
label (the first is re-decided at claim time, the second is a free-form
duration). Enforced by `.claude/hooks/issue-classification-label-gate.sh`; the
fix PR inherits the issue's labels via
`.github/workflows/pr-inherit-issue-labels.yml`, so never hand-add them there.

A hunt is the single best moment to write them: the bug is just-reproduced, so
`Severity` is measured rather than guessed, and you already know which fixture
the fix drags. `/work-issues` reads these lines back when ranking candidates, so
an unclassified body is one this hunt made harder to triage.

When you then WORK an issue — this hunt's own or one already filed — **run
`/work-issues` and follow it** for the collision-safe start: its §0 screens the
issue's comments for untrusted/malware content (first-pass, then defer to the
maintainer; never access/run an attachment) and its §4 claims the issue with a
`gh issue comment` BEFORE you edit. Do NOT re-implement those steps here — the
`/work-issues` skill is the single source of truth, so this stays correct when it
changes.

Then fix it:

1. **Root-cause it** in `src/` (normalize / diff-classify / read-router / overrides
   / intrinsic-resolver / report — wherever the divergence-from-reality lives).
2. **Fix it in the worktree.**
3. **Add a unit test that fails without the fix and passes with it.** This is
   mandatory, not optional — a bug found by integ MUST leave behind a unit test that
   pins the corrected behavior, so the regression can never come back silently
   (integ alone is too slow/expensive to be the only guard). Re-run `vp run build` +
   `vp run test`.
4. **Re-run the live repro with the fixed binary** to confirm the real-AWS behavior
   is now correct.
5. **Keep the fixture** as a committed regression integ under
   `tests/integration/<name>/`, in the SAME PR as the fix — never defer the integ.
6. **If the bug is a CLASS, prove it's closed for EVERY affected type — don't stop
   at the one resource you happened to hit.** Most real bugs here are not specific
   to the type that surfaced them: they live in shared code keyed on a schema flag
   or a normalizer applied to many types (e.g. go-to-k/cdk-real-drift#252 — a property that is BOTH
   write-only and create-only was re-included into a Cloud Control patch and
   rejected; found on ElastiCache, but RDS / DynamoDB / EC2 / Redshift / S3 / EFS …
   all have such properties). When the root cause generalizes:
   - **Map the blast radius.** Enumerate which other types/properties share the
     trigger — e.g. `aws cloudformation describe-type --type RESOURCE --type-name
<T> --query Schema` and compute the relevant intersection across common types.
     Name them in the PR so the coverage is visible.
   - **Add a DATA-DRIVEN invariant test, not just a per-type one.** A hand-built
     single-type unit test proves the symptom is gone for ONE shape; it does not
     prove no oversight elsewhere. Drive the test from the golden corpus's REAL
     schemas: load every `tests/corpus/*.json` (via `reviveSchema`), reproduce the
     trigger for each, and assert the invariant holds for ALL of them. The corpus
     already spans ~17 real types, and the test self-extends as the corpus grows —
     a far stronger guard than enumerating types by hand. (`tests/revert-plan.test.ts`
     `create-only invariant over all real corpus schemas` is the reference.)
   - **Confirm it fails without the fix and passes with it**, like any regression
     test — then you have proof the whole class is closed, not just one instance.
   - This pairs with step 5's corpus harvest: harvesting rich cases during hunts is
     what makes the corpus a strong enough substrate to drive these invariants.
