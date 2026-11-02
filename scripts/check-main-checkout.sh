#!/usr/bin/env bash
# check-main-checkout.sh — fail loudly on tracked-file deletions in the MAIN checkout
#
# WL-0MVWK20DK004TQZM AC2 (context: the 2026-10-26 wipe WL-0MVPADZ1Z000FOSG and
# the 2026-10-31 recurrence). A worktree-scoped agent run deleted every tracked
# file under packages/shared/ (plus the gitignored dist/) from the main
# checkout, breaking `wl` machine-wide for ~35 minutes. The finish main-checkout
# guard only verifies at pre-push / pre-worktree-removal points — the run that
# overlapped the wipe aborted at the test gate first, so its guard record shows
# `verifies: []` and nothing reported the 37 deletions.
#
# This check runs INDEPENDENTLY of implement.py finish (periodic, CI, or
# pre-hook), so deletions are reported even when the overlapping finish run
# aborts at the gate:
#
#   - exit 0  → the main checkout has no tracked-file deletions
#   - exit 1  → deletions found: every deleted path is named, plus
#               concurrent-actor evidence (worktree list, branch, HEAD)
#   - exit 2  → usage/infrastructure error (not a git repo, git unavailable)
#
# Non-destructive: read-only git inspection; never stash, reset or revert.
# Also reported through a `wl comment add` when --work-item is given, so the
# report survives an aborted finish run and the item's audit trail (wl is the
# single source of truth — although when the wipe has BROKEN wl itself, the
# comment step degrades to a warning and the non-zero exit still carries the
# report).

set -euo pipefail

# ── Options ────────────────────────────────────────────────────────────────
JSON=0
WORK_ITEM="${CHECK_MAIN_CHECKOUT_WORK_ITEM:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1; shift ;;
    --work-item)
      [ $# -ge 2 ] || { echo "check-main-checkout: --work-item needs a value" >&2; exit 2; }
      WORK_ITEM="$2"; shift 2
      ;;
    --work-item=*)
      WORK_ITEM="${1#--work-item=}"; shift
      ;;
    -h|--help)
      sed -n '1,32p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "check-main-checkout: unknown option: $1" >&2
      exit 2
      ;;
  esac
done

warn() { echo "check-main-checkout: WARNING: $*" >&2; }

# ── Main-checkout resolution (worktree-safe) ─────────────────────────────
# Mirror install-herdr.sh: within a linked git worktree, `git worktree list
# --porcelain` lists the main checkout first; outside git, fall back to the
# script's own repo root. The check always guards the MAIN checkout — the
# 2026-10-31 wipe destroyed the main checkout's packages/shared.
MAIN_CHECKOUT=""
if command -v git >/dev/null 2>&1 \
   && git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  MAIN_CHECKOUT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" worktree list --porcelain 2>/dev/null \
    | awk '/^worktree /{sub(/^worktree /, ""); print; exit}')"
fi
if [ -z "${MAIN_CHECKOUT}" ] || [ ! -d "${MAIN_CHECKOUT}" ]; then
  MAIN_CHECKOUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
if [ ! -d "${MAIN_CHECKOUT}/.git" ] && [ ! -f "${MAIN_CHECKOUT}/.git" ]; then
  warn "not inside a git repository (no .git at ${MAIN_CHECKOUT}) — cannot check"
  exit 2
fi

# ── Detect tracked-file deletions ─────────────────────────────────────────
# porcelain=v1 `XY path` lines: a tracked path deleted from the index (X=D) or
# from the working tree (Y=D) is a deletion. X=A (added-then-deleted) is not a
# deletion of a HEAD-tracked file and is excluded.
deletions=()
while IFS= read -r line; do
  case "$line" in
    '#'*) continue ;;
  esac
  [ "${#line}" -ge 3 ] || continue
  x="${line:0:1}"
  y="${line:1:1}"
  [ "$x" = "A" ] && continue
  if [ "$x" = "D" ] || [ "$y" = "D" ]; then
    deletions+=("$line")
  fi
done < <(git -C "${MAIN_CHECKOUT}" status --porcelain=v1 --untracked-files=no)

# Concurrent-actor evidence: the worktree list shows every live worktree and
# its branch — a foreign worktree-scoped run is the known deletion mechanism.
worktree_evidence="$(git -C "${MAIN_CHECKOUT}" worktree list --porcelain 2>/dev/null || true)"
branch="$(git -C "${MAIN_CHECKOUT}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(detached HEAD)')"
head_sha="$(git -C "${MAIN_CHECKOUT}" rev-parse --short HEAD 2>/dev/null || echo '?')"

if [ "${#deletions[@]}" -eq 0 ]; then
  if [ "$JSON" = "1" ]; then
    echo "{\"check\": \"main-checkout-deletions\", \"checkout\": \"${MAIN_CHECKOUT}\", \"clean\": true, \"deletions\": [], \"branch\": \"${branch}\", \"head\": \"${head_sha}\"}"
  else
    echo "check-main-checkout: OK — no tracked-file deletions in ${MAIN_CHECKOUT} (${branch} @ ${head_sha})"
  fi
  exit 0
fi

# ── Report (human) ────────────────────────────────────────────────────────
if [ "$JSON" != "1" ]; then
  echo "check-main-checkout: FAIL — tracked-file deletion(s) in the MAIN checkout" >&2
  echo "  Checkout: ${MAIN_CHECKOUT} (${branch} @ ${head_sha})" >&2
  echo "  These tracked files were deleted (recover with \`git -C ${MAIN_CHECKOUT} restore -- <path>\`):" >&2
  for d in "${deletions[@]}"; do
    echo "    ${d}" >&2
  done
  echo "  Concurrent-actor evidence (live worktrees; a worktree-scoped agent run" >&2
  echo "  is the known deletion mechanism):" >&2
  echo "${worktree_evidence}" | sed 's/^/    /' >&2
  echo "  One-step recovery: bash ${MAIN_CHECKOUT}/scripts/repair-shared-package.sh" >&2
else
  # JSON: single escaped line
  paths=()
  for d in "${deletions[@]}"; do
    paths+=("$(printf '%s' "${d:3}")")
  done
  json_list="["
  first=1
  for p in "${paths[@]}"; do
    if [ "$first" = "1" ]; then first=0; else json_list="${json_list},"; fi
    json_list="${json_list}\"${p}\""
  done
  json_list="${json_list}]"
  worktree_escaped="$(printf '%s' "${worktree_evidence}" | tr '\n' '|')"
  echo "{\"check\": \"main-checkout-deletions\", \"checkout\": \"${MAIN_CHECKOUT}\", \"clean\": false, \"deletions\": ${json_list}, \"branch\": \"${branch}\", \"head\": \"${head_sha}\", \"worktrees\": \"${worktree_escaped}\"}"
fi

# ── Report through wl (survives an aborted finish run) ───────────────────
if [ -n "${WORK_ITEM}" ]; then
  if command -v wl >/dev/null 2>&1; then
    report="check-main-checkout: FAIL — $((${#deletions[@]})) tracked-file deletion(s) in the main checkout (${MAIN_CHECKOUT}):
$(for d in "${deletions[@]}"; do echo "  ${d}"; done)
Concurrent-actor evidence: $(printf '%s' "${worktree_evidence}" | tr '\n' ' ')"
    if ! wl --worklog-dir "${MAIN_CHECKOUT}/.worklog" comment add "${WORK_ITEM}" \
         --comment "Main-checkout integrity check failed: ${report}" \
         --author "check-main-checkout" --json >/dev/null 2>&1; then
      warn "could not record the report on work item ${WORK_ITEM} (wl may itself be broken) — the non-zero exit still carries it"
    fi
  else
    warn "wl not on PATH — skipping comment on ${WORK_ITEM}"
  fi
fi

exit 1
