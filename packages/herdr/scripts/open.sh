#!/usr/bin/env bash
# open.sh — Open the worklist selection list pane
#
# Opens the Worklog work item selection pane in a new tab in the current
# workspace, providing full-screen access to the worklist.
# Uses Herdr's built-in plugin pane open for simplicity.
#
# Usage: open.sh [cwd]
#   cwd - Optional working directory for the pane (default: $PWD)

set -uo pipefail

herdr_bin="${HERDR_BIN_PATH:-herdr}"

# ── Debug logging ──────────────────────────────────────────────
echo "[open-worklist] === open.sh start ===" >&2
echo "[open-worklist] arg1='${1:-<unset>}'" >&2
echo "[open-worklist] PWD='$PWD'" >&2
echo "[open-worklist] HERDR_PANE_ID='${HERDR_PANE_ID:-unset}'" >&2

# ── Resolve the pane CWD ───────────────────────────────────────
# The action runs from the plugin directory so $PWD is wrong.
# If the user bound this action to a keybinding, the invoking
# pane's CWD is what we want.  Query in priority order:
#   1) $1 (passed explicitly by toggle.sh)
#   2) $HERDR_PANE_ID → pane get
#   3) herdr pane current
#   4) $PWD (last resort)
if [ -z "${1:-}" ]; then
  # No explicit argument from toggle.sh — resolve from pane metadata
  pane_cwd=""
  if [ -n "${HERDR_PANE_ID:-}" ]; then
    echo "[open-worklist] Attempt: pane get HERDR_PANE_ID='$HERDR_PANE_ID'" >&2
    raw_pane_get=$( "$herdr_bin" pane get "$HERDR_PANE_ID" 2>&1 )
    echo "[open-worklist] pane get raw: $raw_pane_get" >&2
    pane_cwd=$( echo "$raw_pane_get" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    result = data.get('result', {})
    pane = result.get('pane', {}) if isinstance(result, dict) else {}
    if isinstance(pane, dict):
        cwd = pane.get('cwd') or pane.get('foreground_cwd', '')
        if cwd:
            print(cwd)
except:
    pass
" 2>/dev/null || echo "" )
  fi

  if [ -z "$pane_cwd" ]; then
    echo "[open-worklist] Fallback: herdr pane current" >&2
    raw_pane_current=$( "$herdr_bin" pane current 2>&1 )
    echo "[open-worklist] pane current raw: $raw_pane_current" >&2
    pane_cwd=$( echo "$raw_pane_current" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    result = data.get('result', {})
    pane = result.get('pane', {}) if isinstance(result, dict) else {}
    if isinstance(pane, dict):
        cwd = pane.get('cwd') or pane.get('foreground_cwd', '')
        if cwd:
            print(cwd)
except:
    pass
" 2>/dev/null || echo "" )
  fi

  cwd="${pane_cwd:-$PWD}"
else
  cwd="$1"
fi

echo "[open-worklist] resolved cwd='$cwd'" >&2

# Pass the working directory to the plugin pane so the plugin
# uses the correct directory (not the plugin directory) to find the
# nearest .worklog/.
exec "$herdr_bin" plugin pane open \
  --plugin worklog-selection-list \
  --entrypoint worklist \
  --placement tab \
  --cwd "$cwd" \
  --focus
