#!/usr/bin/env bash
#
# bughunt-track.sh — arm / verify / release the bug-hunt cleanup gate.
#
# The /hunt-bugs skill deploys real AWS resources (CloudFormation stacks via the
# integ fixtures). To make "always delete them" a structural guarantee — not a
# matter of remembering — every deployed stack is tracked in a gitignored sentinel.
# The bughunt-clean-gate hook (.claude/hooks/bughunt-clean-gate.sh) blocks
# `git commit` / `gh pr create` / `gh pr merge` while ANY pending stack remains,
# so a bug-hunt session cannot land any commit until its stacks are deleted and
# verified gone.
#
# Subcommands:
#   add <Stack> [<Stack> ...]   Record stacks about to be deployed (arms gate).
#   verify [--region R]         Assert each tracked stack is GONE from
#                               CloudFormation AND sweep-orphans.sh is CLEAN.
#                               Non-zero exit if anything remains. Does NOT clear.
#   clear                       Empty THIS owner's pending list (releases the gate
#                               for this owner). Run ONLY after verify passes.
#   list [--all]                Print this owner's tracked stacks (--all: every
#                               owner's, plus any legacy flat file).
#
# PARALLEL-SAFE design (per-owner files). The old single shared file
# `.markgate-bughunt-pending` was a SPOF: `clear` did `rm -f` on the WHOLE file, so
# one agent's clear wiped a CONCURRENT agent's still-pending stacks — releasing the
# gate while live AWS resources remained (the exact accident the gate prevents).
# Instead each owner writes ONLY its own file under
# `.markgate-bughunt-pending.d/<owner-key>`, so a clear can never release another
# owner's pending resources. The gate AGGREGATES across all owner files (+ the
# legacy flat file for back-compat): it blocks while ANY owner is pending — the safe
# direction (cross-owner contention over-blocks; it never premature-releases).
# Destructive ops (clear) are per-owner; the block decision is repo-wide. No file
# locking is needed (each owner appends only to its own file; append is atomic),
# which also dodges macOS's missing `flock`.
#
# Everything is resolved at the SHARED main-tree root (via --git-common-dir) so the
# deploy-time tracker and the gate hook — which may run from different worktrees —
# agree on one location. The OWNER KEY is $CDKRD_BUGHUNT_OWNER if set, else the
# per-worktree toplevel path (so parallel agents in their own worktrees get distinct
# owners automatically), sanitized to a safe filename.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIT_COMMON_DIR="$(git -C "${SCRIPT_DIR}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -n "${GIT_COMMON_DIR}" ]; then
  REPO_ROOT="$(dirname "${GIT_COMMON_DIR}")"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
PENDING_DIR="${REPO_ROOT}/.markgate-bughunt-pending.d"
LEGACY_SENTINEL="${REPO_ROOT}/.markgate-bughunt-pending" # honored by gate; cleared by this owner
SWEEP="${REPO_ROOT}/tests/integration/sweep-orphans.sh"

owner_raw="${CDKRD_BUGHUNT_OWNER:-}"
if [ -z "${owner_raw}" ]; then
  owner_raw="$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
OWNER_KEY="$(printf '%s' "${owner_raw}" | sed 's#[^A-Za-z0-9._-]#_#g')"
OWNER_FILE="${PENDING_DIR}/${OWNER_KEY}"

cmd="${1:-}"
shift || true

case "${cmd}" in
  add)
    if [ "$#" -eq 0 ]; then
      echo "usage: bughunt-track.sh add <Stack> [<Stack> ...]" >&2
      exit 2
    fi
    mkdir -p "${PENDING_DIR}"
    touch "${OWNER_FILE}"
    for stack in "$@"; do
      if ! grep -qxF "${stack}" "${OWNER_FILE}" 2>/dev/null; then
        echo "${stack}" >>"${OWNER_FILE}"
      fi
    done
    echo "tracked $# stack(s) for owner ${OWNER_KEY}; bughunt-clean gate is now ARMED"
    ;;

  list)
    if [ "${1:-}" = "--all" ]; then
      shown=0
      if [ -d "${PENDING_DIR}" ]; then
        for f in "${PENDING_DIR}"/*; do
          [ -s "${f}" ] || continue
          while IFS= read -r stack; do
            [ -z "${stack}" ] && continue
            echo "$(basename "${f}"): ${stack}"
            shown=1
          done <"${f}"
        done
      fi
      if [ -s "${LEGACY_SENTINEL}" ]; then
        while IFS= read -r stack; do
          [ -z "${stack}" ] && continue
          echo "(legacy): ${stack}"
          shown=1
        done <"${LEGACY_SENTINEL}"
      fi
      [ "${shown}" -eq 1 ] || echo "(no tracked stacks)"
    elif [ -s "${OWNER_FILE}" ]; then
      cat "${OWNER_FILE}"
    else
      echo "(no tracked stacks for owner ${OWNER_KEY})"
    fi
    ;;

  verify)
    region="${AWS_REGION:-us-east-1}"
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --region) region="$2"; shift 2 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
      esac
    done
    if [ ! -s "${OWNER_FILE}" ]; then
      echo "no tracked stacks for owner ${OWNER_KEY} — nothing to verify"
      exit 0
    fi
    fail=0
    # 1) every tracked stack must be GONE from CloudFormation (delete succeeded).
    while IFS= read -r stack; do
      [ -z "${stack}" ] && continue
      status="$(aws cloudformation describe-stacks --stack-name "${stack}" --region "${region}" \
        --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "GONE")"
      if [ "${status}" = "GONE" ] || [ "${status}" = "DELETE_COMPLETE" ] || [ -z "${status}" ]; then
        echo "ok: ${stack} is gone (${status})"
      else
        echo "STILL PRESENT: stack ${stack} is ${status} — delete it (delstack cdk -a cdk.out -r ${region} -f -y)" >&2
        fail=1
      fi
    done <"${OWNER_FILE}"
    # 2) no stack-EXTERNAL orphans may remain (log groups, RETAIN resources, etc.).
    if [ -x "${SWEEP}" ]; then
      sweep_out="$(AWS_REGION="${region}" bash "${SWEEP}" 2>&1 || true)"
      if printf '%s\n' "${sweep_out}" | grep -q "SWEEP CLEAN"; then
        echo "ok: sweep-orphans.sh reports SWEEP CLEAN"
      else
        echo "ORPHANS REMAIN — sweep-orphans.sh did not report SWEEP CLEAN:" >&2
        printf '%s\n' "${sweep_out}" | tail -8 >&2
        echo "run: AWS_REGION=${region} bash ${SWEEP} --delete" >&2
        fail=1
      fi
    else
      echo "WARN: ${SWEEP} not found/executable — skipping orphan sweep" >&2
    fi
    if [ "${fail}" -ne 0 ]; then
      echo "verify FAILED — delete the remaining stacks/orphans before clearing the gate" >&2
      exit 1
    fi
    echo "verify OK — every tracked stack is gone and no orphans remain"
    ;;

  clear)
    # Remove ONLY this owner's file (+ the legacy flat file this owner may have
    # armed). NEVER `rm -rf` the whole dir — that would release a CONCURRENT owner's
    # still-pending stacks (the SPOF this design fixes).
    rm -f "${OWNER_FILE}" "${LEGACY_SENTINEL}"
    # Tidy the dir if this was the last owner (cosmetic; harmless if it is not empty).
    rmdir "${PENDING_DIR}" 2>/dev/null || true
    echo "cleared owner ${OWNER_KEY}; bughunt-clean gate is now RELEASED for this owner"
    ;;

  *)
    echo "usage: bughunt-track.sh {add|verify|clear|list} ..." >&2
    exit 2
    ;;
esac
