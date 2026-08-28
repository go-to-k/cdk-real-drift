<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 4. CLAIM the chosen issues BEFORE editing

For EACH issue you will start:

```bash
gh issue comment <n> --body "Working on this in PR/branch <ref> — touching <files>. \
Claiming to avoid collision with parallel agents."
```

(English only — committed/public artifacts are English.) This is mandatory and
comes BEFORE the first edit. It is the issue-level twin of the worktree
DISJOINT-FILE rule. Re-check for a competing claim/PR right before you start; if
one appeared, pick a different issue.

**Claim what you FILE, too — filing is not claiming.** An issue this run files as
its own deferral is invisible to every ownership probe: no branch, no PR, no comment,
and only §3-a's hour covers it. So when the issue is one THIS run means to pick up
itself (a `Session-fit: now` line in the body, where you write one), post the claim
comment in the same turn you file it. Name the LANE and what it defers from, not just
your current branch: a merged branch is deleted, so a claim naming the branch you are
on now reads stale at exactly the moment you come back for the issue — re-post the
claim with the real branch when you open that lane. An issue you are handing off to a
later session gets NO claim at filing time — that would park a released issue under a
session that has decided not to do it — but this says nothing about the LATER run
that takes it: that run claims it normally, per the mandatory rule above.

**`Severity` and `Effort` also ride the filing command as LABELS** — the body
lines stay exactly as written, and the same two values go on as
`--label severity:<high|medium|low> --label effort:<small|medium|large>`, or as
`--add-label` on the `gh issue edit` that rewrites an old packed body into the
four-line shape. Prose is invisible to `gh issue list`, so ranking by `Severity`
costs one `gh issue view` per candidate without them. `Session-fit` and
`Estimate` get no label (see `CLAUDE.md` → "The four TODO fields"). Enforced by
`.claude/hooks/issue-classification-label-gate.sh`; the lane's PR inherits the
issue's labels via `.github/workflows/pr-inherit-issue-labels.yml`, so never
hand-add them to a PR.

**English-only covers the issue BODIES this flow files, not just the comment above.**
Write the classification lines in English too — `Session-fit` / `Severity` /
`Effort` / `Estimate`, one field per line (see `CLAUDE.md` → "The four TODO
fields"), glosses included: `Session-fit: next (not this session)`,
`Estimate: ~1-3 h — one live run` — never in the session's chat language. Nothing enforces this
half: `non-english-text-gate` fires only on `gh pr create` / `gh pr edit` /
`gh pr merge` (its `"if"` clause in `.claude/settings.json`), and it identifies its
target by resolving a PR NUMBER and scanning `gh pr diff`, so it structurally cannot
see an issue at all. Three `"if"` clauses DO name `gh issue` now, so the sentence
that used to stand here — "no `gh issue` command appears in any hook's `"if"`
clause" — is no longer true: `issue-dup-check-gate` on `create` (§5), and
`issue-classification-label-gate` on `create` and on `edit`. But the first reads
the body for one `Dup-check:` line and the second for a `Severity:` / `Effort:`
value, so neither says anything about the LANGUAGE of the body and this half
remains unenforced. Discipline is still the only guard here, and
it has already failed once: a `/work-issues` run in
go-to-k/cdk-local filed its follow-up on 2026-08-19 with both halves of the
`Session-fit` line glossed in the session's chat language, and had to patch the body
after creation (go-to-k/cdk-real-drift#1777).
