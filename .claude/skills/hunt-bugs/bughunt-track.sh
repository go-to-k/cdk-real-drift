#!/usr/bin/env bash
#
# bughunt-track.sh — arm / verify / release the bug-hunt cleanup gate.
#
# The /hunt-bugs skill deploys real AWS resources (CloudFormation stacks via the
# integ fixtures). To make "always delete them" a structural guarantee — not a
# matter of remembering — every deployed stack is tracked in a gitignored sentinel
# file. The bughunt-clean-gate hook (.claude/hooks/bughunt-clean-gate.sh) blocks
# `git commit` / `gh pr create` / `gh pr merge` while that sentinel is non-empty,
# so a bug-hunt session cannot land any commit until its stacks are deleted and
# verified gone.
#
# Subcommands:
#   add <Stack> [<Stack> ...]   Record stacks about to be deployed (arms gate).
#   verify [--region R]         Assert each tracked stack is GONE from
#                               CloudFormation AND sweep-orphans.sh is CLEAN.
#                               Non-zero exit if anything remains. Does NOT clear.
#   clear                       Empty the sentinel (releases the gate). Run ONLY
#                               after verify passes (delete + orphan-zero).
#   list                        Print the currently-tracked stacks.
#
# The sentinel lives at the SHARED main-tree root (via --git-common-dir) so the
# deploy-time tracker and the gate hook — which may run from different worktrees —
# agree on one path.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIT_COMMON_DIR="$(git -C "${SCRIPT_DIR}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -n "${GIT_COMMON_DIR}" ]; then
  REPO_ROOT="$(dirname "${GIT_COMMON_DIR}")"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
SENTINEL="${REPO_ROOT}/.markgate-bughunt-pending"
SWEEP="${REPO_ROOT}/tests/integration/sweep-orphans.sh"

cmd="${1:-}"
shift || true

case "${cmd}" in
  add)
    if [ "$#" -eq 0 ]; then
      echo "usage: bughunt-track.sh add <Stack> [<Stack> ...]" >&2
      exit 2
    fi
    touch "${SENTINEL}"
    for stack in "$@"; do
      if ! grep -qxF "${stack}" "${SENTINEL}" 2>/dev/null; then
        echo "${stack}" >>"${SENTINEL}"
      fi
    done
    echo "tracked $# stack(s); bughunt-clean gate is now ARMED"
    ;;

  list)
    if [ -s "${SENTINEL}" ]; then
      cat "${SENTINEL}"
    else
      echo "(no tracked stacks)"
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
    if [ ! -s "${SENTINEL}" ]; then
      echo "no tracked stacks — nothing to verify"
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
    done <"${SENTINEL}"
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
    rm -f "${SENTINEL}"
    echo "sentinel cleared; bughunt-clean gate is now RELEASED"
    ;;

  *)
    echo "usage: bughunt-track.sh {add|verify|clear|list} ..." >&2
    exit 2
    ;;
esac
