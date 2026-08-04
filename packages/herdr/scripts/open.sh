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

# ── Resolve the logical CWD of a Worklog plugin pane ───────────
# When the invoking pane is a Worklog plugin (label == "Work Items"),
# herdr pane get reports cwd as the plugin extension directory
# (/path/to/herdr/packages/herdr) rather than the project root the
# pane is actually browsing.  The pane process has HERDR_RESOLVED_CWD
# in its environment with the correct project root.  We read it from
# /proc/<shell_pid>/environ via `herdr pane process-info`.
#
# Returns the logical CWD on stdout, or empty string on failure.
_resolve_plugin_cwd() {
  local pane_id="$1"
  local shell_pid
  shell_pid=$( "$herdr_bin" pane process-info --pane "$pane_id" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['process_info']['shell_pid'])" 2>/dev/null )
  if [ -z "$shell_pid" ] || [ ! -f "/proc/$shell_pid/environ" ]; then
    return
  fi
  tr '\0' '\n' < "/proc/$shell_pid/environ" | grep '^HERDR_RESOLVED_CWD=' | cut -d= -f2- || true
}

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
  pane_id_for_plugin_check=""
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
    pane_id_for_plugin_check="$HERDR_PANE_ID"
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
    # Extract pane_id from the current pane for plugin check
    pane_id_for_plugin_check=$( echo "$raw_pane_current" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    pane = data.get('result', {}).get('pane', {})
    if isinstance(pane, dict):
        print(pane.get('pane_id', ''))
except:
    pass
" 2>/dev/null || echo "" )
  fi

  # If the invoking pane is a Worklog plugin pane, its logical CWD
  # (HERDR_RESOLVED_CWD in the pane's env) is more accurate than
  # the filesystem cwd reported by `pane get` (which is the plugin
  # directory).  Read the env var from /proc/<shell_pid>/environ.
  if [ -n "$pane_id_for_plugin_check" ] && [ -z "${1:-}" ]; then
    plugin_cwd=$( _resolve_plugin_cwd "$pane_id_for_plugin_check" )
    if [ -n "$plugin_cwd" ]; then
      echo "[open-worklist] Plugin pane detected — HERDR_RESOLVED_CWD=$plugin_cwd" >&2
      cwd="$plugin_cwd"
    else
      cwd="${pane_cwd:-$PWD}"
    fi
  else
    cwd="${pane_cwd:-$PWD}"
  fi
else
  cwd="$1"
fi

echo "[open-worklist] resolved cwd='$cwd'" >&2

# Pass the resolved CWD as an environment variable instead of using
# --cwd.  The pane command ("npx tsx src/index.ts") uses a RELATIVE
# path, so changing CWD via --cwd would break script resolution.
# The plugin reads HERDR_RESOLVED_CWD to find the correct .worklog/.
exec "$herdr_bin" plugin pane open \
  --plugin worklog-selection-list \
  --entrypoint worklist \
  --placement tab \
  --env "HERDR_RESOLVED_CWD=$cwd" \
  --focus
