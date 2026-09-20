<!-- Part of the /hunt-bugs skill. Stages 7–9 + the cleanup gate. READ IN FULL when your run enters this stage. -->

### 7. Cleanup — non-negotiable (see below), then ship

Run **`/sweep-resources`** — the shared cleanup phase: it deletes every tracked stack
with `delstack`, sweeps the stack-external orphans (IAM roles, log groups, RETAIN
resources, tagged-any-type), verifies `SWEEP CLEAN`, and releases the gate
(`bughunt-track.sh verify` → `clear`, including this session's `autoarm-<session>`
owner). Then run `/check` and `/check-docs` → commit → push → `/verify-pr` →
`gh pr create`.

### 8. Merge + remove the worktree

Take it all the way to merged — do not leave a green PR hanging:

1. `gh pr merge <#> --squash --delete-branch` (squash only; the repo allows nothing
   else). CI must be green first — the `main` ruleset refuses the merge while a
   required check is red or pending.
2. **Remove the worktree YOU created** — a left-behind worktree is the silent residue
   of this flow. From the MAIN checkout: `git worktree remove .worktrees/<name>`
   (`--force` if it refuses on leftover build artifacts), then `git branch -D
wt-<name>` if the branch lingers, and `git worktree prune`; confirm with
   `git worktree list`.
   **A hunt launched IN-PLACE (§1) added none, so it removes none**: it must not
   `git worktree remove` the tree it is running in — that deletes its own cwd — nor
   `git branch -D` the branch it is standing on. Cleanup of that tree belongs to
   whoever created it, so say so in the wrap instead; `--delete-branch` on the merge
   still removes the REMOTE branch, which is fine.

### 9. Record what you learned

For any recurring surprise (a whole _class_ of latent bug, a verification gotcha, a
methodology improvement), **encode the durable lesson into THIS skill's stage files**
— a committed principle/gotcha survives across machines and sessions, while
auto-memory is per-terminal and invisible to the next hunter. Fold it into the stage
file where it fires, with the issue/PR number as evidence, and PR it; never into the
orchestrator `SKILL.md`. A finding about the TOOLING rather than about cdkrd goes to
`docs/tooling-backlog.md`, not to an issue.

## Cleanup is non-negotiable (gate-enforced)

Forgetting to delete bug-hunt stacks is the one unacceptable outcome, so it is
enforced structurally:

- `bughunt-track.sh add <stacks...>` writes the deployed stack names to the gitignored
  sentinel `.markgate-bughunt-pending`.
- The `bughunt-clean-gate` PreToolUse hook (`.claude/hooks/bughunt-clean-gate.sh`)
  **blocks `git commit`, `gh pr create` and `gh pr merge` while that sentinel is
  non-empty**, so the fix PR cannot land until the stacks are verified gone.
- `bughunt-track.sh verify` asserts each tracked stack is GONE from CloudFormation AND
  that `sweep-orphans.sh` reports SWEEP CLEAN, then STAMPS the verified pending set;
  `clear` empties the sentinel and REFUSES without a stamp matching it. Run `verify`
  and `clear` as separate, UN-PIPED commands from the SAME directory: a piped
  `verify | tail && clear` once chained a clear onto a FAILED verify (the pipeline's
  exit was tail's), and the owner key is cwd-derived, so a cwd that drifted back to
  the main checkout arms/clears the WRONG owner.
- **Owner scoping — set `CDKRD_BUGHUNT_OWNER="session-$CLAUDE_CODE_SESSION_ID"`.**
  UNSET, the tracker derives the owner from the main-tree root (`--git-common-dir`),
  so two sessions running `add` from the main checkout share ONE owner file
  (go-to-k/cdk-real-drift#1409) — and a `clear`, which empties the WHOLE file, drops a
  PEER's still-pending stacks, releasing the gate while their live AWS resources
  remain. A per-session owner gives each session its own `.d/session-<id>` file.
  **If you DID share the default owner: NEVER `clear` it while it lists another
  session's stacks.** Release only your own token
  (`CDKRD_BUGHUNT_OWNER="autoarm-$CLAUDE_CODE_SESSION_ID" … clear`, or
  `CDKRD_BUGHUNT_FORCE_CLEAR=1` if the only remaining orphan is provably a peer's) and
  merge from a worktree cwd.

`delstack` only deletes stack MEMBERS. `sweep-orphans.sh` catches the stack-EXTERNAL
orphans — auto-created `/aws/lambda/*` log groups (notably from S3
`autoDeleteObjects` custom-resource Lambdas), RETAIN stateful resources, Secrets in
recovery, KMS keys pending deletion. Do NOT delete the sentinel by hand to bypass the
gate.
