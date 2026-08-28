<!-- Part of the /hunt-bugs skill. Stage files: principles.md (posture / goal / core principles), plan.md (workflow stages 0–2), deploy-and-detect.md (stages 3–4), harvest.md (stages 5–5.5), file-and-fix.md (stage 6), cleanup-and-ship.md (stages 7–9 + the cleanup gate), gotchas.md (appendix). READ THIS FILE IN FULL when your run enters this stage. -->

### 7. Cleanup — non-negotiable (see below), then ship

Run **`/sweep-resources`** — the shared cleanup phase: it deletes every tracked stack
with `delstack`, sweeps the stack-external orphans (IAM roles, log groups, RETAIN
resources, tagged-any-type), verifies `SWEEP CLEAN`, and releases the gate
(`bughunt-track.sh verify` → `clear`, incl. this session's `autoarm-<session>` owner).
Then `/check` +
`/check-docs` markers → commit → push → `/verify-pr` → `gh pr create`.

### 8. Merge + remove the worktree

Take it all the way to merged — do not leave a green PR hanging:

1. `gh pr merge <#> --squash --delete-branch` (the remote branch). If CI is down
   for billing, `--admin` after confirming the local gates passed.
2. **Remove the worktree** — a hunt always creates one (`.worktrees/<name>`), and a
   left-behind worktree is the silent residue of this flow. From the MAIN checkout:
   `git worktree remove .worktrees/<name>` (add `--force` if it refuses on
   leftover build artifacts), then `git branch -D wt-<name>` if the branch lingers,
   and `git worktree prune`. Confirm with `git worktree list` — only the main
   checkout should remain. (Mirror of CLAUDE.md's integrate-then-remove rule.)

### 9. Record what you learned

For any recurring surprise (a whole _class_ of latent bug, a verification gotcha, a
methodology improvement), **encode the durable lesson into THIS skill's stage
files** — a committed principle/gotcha survives across machines and sessions;
auto-memory is per-terminal and invisible to the next hunter, so reserve it for
session-transient notes. Fold the lesson into the relevant entry in
`references/principles.md` / `references/gotchas.md` — or the stage file where it
fires — with the issue/PR number as evidence, and PR it. Never the orchestrator
`SKILL.md` (byte-capped by `tests/skill-file-payload.test.ts`; it changes only
when the stage list itself changes).

## Cleanup is non-negotiable (gate-enforced)

Forgetting to delete bug-hunt stacks is the one unacceptable outcome, so it is
enforced structurally rather than by discipline:

- `bughunt-track.sh add <stacks...>` writes the deployed stack names to the
  gitignored sentinel `.markgate-bughunt-pending`.
- The `bughunt-clean-gate` PreToolUse hook (`.claude/hooks/bughunt-clean-gate.sh`)
  **blocks `git commit`, `gh pr create`, and `gh pr merge` while that sentinel is
  non-empty** — so you physically cannot land the fix PR (or any commit) until the
  bug-hunt stacks are deleted and verified gone.
- `bughunt-track.sh verify` asserts each tracked stack is GONE from CloudFormation
  AND `sweep-orphans.sh` reports SWEEP CLEAN, and on success STAMPS the verified
  pending set; `bughunt-track.sh clear` empties the sentinel (releasing the gate)
  and REFUSES without a stamp matching the current pending set — "verify passed
  first" is enforced structurally, not by shell plumbing (a piped
  `verify | tail && clear` once chained a clear onto a FAILED verify because the
  pipeline's exit was tail's). Run `verify` and `clear` as separate, un-piped
  commands from the SAME directory (the owner key is cwd-derived — a cwd that
  drifted back to the main checkout arms/clears the WRONG owner).
- **Owner scoping — set `CDKRD_BUGHUNT_OWNER="session-$CLAUDE_CODE_SESSION_ID"`.**
  When `CDKRD_BUGHUNT_OWNER` is UNSET, the tracker derives the owner from the
  main-tree root (`--git-common-dir`), so two sessions both running `add` from the
  main checkout write into ONE shared owner file (go-to-k/cdk-real-drift#1409). Then a `clear` — which
  empties the WHOLE owner file — would drop a PEER's still-pending stacks, releasing
  the gate while their live AWS resources remain. Setting a per-session owner gives
  each session its own `.d/session-<id>` file, so your `clear` can never touch a
  peer's. **If you DID share the default owner with a peer: NEVER `clear` it while it
  lists another session's stacks** — release only your own session's token
  (`CDKRD_BUGHUNT_OWNER="autoarm-$CLAUDE_CODE_SESSION_ID" ... clear`, or
  `CDKRD_BUGHUNT_FORCE_CLEAR=1` if the only remaining sweep orphan is provably a
  peer's), and merge from a worktree cwd (the gate scopes commit/merge blocks by the
  committing command's worktree-toplevel owner + your `autoarm-<session>` token, not
  the shared main-root owner).

`delstack` only deletes stack MEMBERS. `sweep-orphans.sh` catches the
stack-EXTERNAL orphans teardown leaves behind — auto-created `/aws/lambda/*` log
groups (notably from S3 `autoDeleteObjects` custom-resource Lambdas), RETAIN
stateful resources, Secrets in recovery, KMS keys pending deletion. Do NOT delete
the sentinel by hand to bypass the gate.
