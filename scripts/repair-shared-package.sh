#!/usr/bin/env bash
# repair-shared-package.sh — one-command recovery for a wiped packages/shared
#
# WL-0MVWK20DK004TQZM AC4 (producer decision option B, 2026-10-31). The
# 2026-10-31 recurrence deleted every tracked file under packages/shared/ from
# the MAIN checkout AND the gitignored packages/shared/dist/ build output,
# breaking `wl` machine-wide for ~35 minutes. Manual multi-step recovery
# (copying sources from a worktree, then rebuilding) is exactly what made that
# outage long; this script does both halves in one command:
#
#   1. restore every TRACKED file deleted under packages/shared/ from HEAD
#      (`git restore --source=HEAD --worktree -- <path>`, per deleted path —
#      never stash / reset / git clean, and never touching modified-but-present
#      files, so local work is never discarded),
#   2. rebuild the gitignored output (`npm run build:shared`),
#   3. verify the artifact the CLI resolves (`packages/shared/dist/worklog-paths.js`).
#
# Idempotent: a healthy checkout reports success without changes (restore step
# is skipped when nothing is deleted; the rebuild is the only recurring part).
# Exit codes: 0 = healthy/repaired · 1 = failure with a named cause.
# Reported through a `wl comment add` when --work-item is given (best-effort).

set -euo pipefail

# ── Options ────────────────────────────────────────────────────────────────
JSON=0
WORK_ITEM="${REPAIR_SHARED_WORK_ITEM:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1; shift ;;
    --work-item)
      [ $# -ge 2 ] || { echo "repair-shared-package: --work-item needs a value" >&2; exit 1; }
      WORK_ITEM="$2"; shift 2
      ;;
    --work-item=*)
      WORK_ITEM="${1#--work-item=}"; shift
      ;;
    -h|--help)
      sed -n '1,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "repair-shared-package: unknown option: $1" >&2
      exit 1
      ;;
  esac
done

warn() { echo "repair-shared-package: WARNING: $*" >&2; }
fail() { echo "repair-shared-package: FAIL — $*" >&2; }

# ── Main-checkout resolution (worktree-safe) ─────────────────────────────
# The wipe always hits the MAIN checkout (the tree whose build output `wl`
# resolves), so the repair targets it even when invoked from a linked worktree.
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
  fail "not inside a git repository (no .git at ${MAIN_CHECKOUT})"
  exit 1
fi

# ── 1. Restore deleted tracked files under packages/shared/ ──────────────
# Only DELETED paths are restored, one at a time — never the whole directory
# (that would clobber modified-but-present files) and never stash/reset/clean.
deleted_paths=()
while IFS= read -r line; do
  case "$line" in
    '#'*) continue ;;
  esac
  [ "${#line}" -ge 3 ] || continue
  x="${line:0:1}"
  y="${line:1:1}"
  [ "$x" = "A" ] && continue
  if [ "$x" = "D" ] || [ "$y" = "D" ]; then
    p="${line:3}"
    # Rename entries carry `old -> new`; restore the deleted source path.
    p="${p%% -> *}"
    case "$p" in
      packages/shared/*|packages/shared) deleted_paths+=("$p") ;;
    esac
  fi
done < <(git -C "${MAIN_CHECKOUT}" status --porcelain=v1 --untracked-files=no)

if [ "${#deleted_paths[@]}" -gt 0 ]; then
  echo "repair-shared-package: restoring ${#deleted_paths[@]} deleted tracked file(s) under packages/shared/ from HEAD…"
  for p in "${deleted_paths[@]}"; do
    git -C "${MAIN_CHECKOUT}" restore --source=HEAD --worktree -- "${p}" \
      || { fail "git restore failed for ${p}" ; exit 1; }
  done
else
  echo "repair-shared-package: no deleted tracked files under packages/shared/ — skipping restore (idempotent)"
fi

# ── 2. Rebuild the gitignored build output ───────────────────────────────
if ! command -v npm >/dev/null 2>&1; then
  fail "npm not on PATH — cannot rebuild packages/shared/dist (run \`npm run build:shared\` in ${MAIN_CHECKOUT})"
  exit 1
fi
echo "repair-shared-package: rebuilding packages/shared/dist via \`npm run build:shared\` in ${MAIN_CHECKOUT}…"
if ! (cd "${MAIN_CHECKOUT}" && npm run build:shared >/dev/null 2>&1); then
  fail "npm run build:shared failed in ${MAIN_CHECKOUT} (named cause) — inspect the output by running it manually"
  exit 1
fi

# ── 3. Verify the artifact the CLI resolves ──────────────────────────────
artifact="${MAIN_CHECKOUT}/packages/shared/dist/worklog-paths.js"
if [ ! -f "${artifact}" ]; then
  fail "build:shared completed but ${artifact} is still missing — packages/shared sources may need git restore first"
  exit 1
fi

if [ "$JSON" = "1" ]; then
  echo "{\"repair\": \"packages/shared\", \"checkout\": \"${MAIN_CHECKOUT}\", \"restored\": ${#deleted_paths[@]}, \"artifact\": \"${artifact}\", \"ok\": true}"
else
  echo "repair-shared-package: OK — packages/shared restored (${#deleted_paths[@]} file(s)) and \`${artifact}\` rebuilt"
fi

# ── Best-effort wl comment (survives status resets; fail-soft) ──────────
if [ -n "${WORK_ITEM}" ]; then
  if command -v wl >/dev/null 2>&1; then
    wl --worklog-dir "${MAIN_CHECKOUT}/.worklog" comment add "${WORK_ITEM}" \
      --comment "repair-shared-package: restored ${#deleted_paths[@]} deleted tracked file(s) under packages/shared/ and rebuilt \`${artifact}\`" \
      --author "repair-shared-package" --json >/dev/null 2>&1 \
      || warn "could not record the repair on work item ${WORK_ITEM} (wl may itself be broken)"
  else
    warn "wl not on PATH — skipping comment on ${WORK_ITEM}"
  fi
fi

exit 0
