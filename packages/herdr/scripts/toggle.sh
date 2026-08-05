#!/usr/bin/env bash
# toggle.sh — Toggle the worklist selection list pane
#
# Opens the Worklog work item selection pane if not open, or focuses it
# if already open, or closes it if focused.

set -uo pipefail

herdr_bin="${HERDR_BIN_PATH:-herdr}"

# ── Debug logging ──────────────────────────────────────────────────
# All [toggle-worklist] stderr output is captured in Herdr plugin logs
# so we can trace exactly what CWD the pane is opened with.
log_debug() { echo "[toggle-worklist] $*" >&2; }

log_debug "=== toggle.sh start ==="
log_debug "HERDR_PANE_ID='${HERDR_PANE_ID:-unset}'"
log_debug "PWD='$PWD'"
log_debug "herdr_bin='$herdr_bin'"

# ── Resolve the logical CWD of a Worklog plugin pane ───────────────
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

# ── Resolve the pane CWD ───────────────────────────────────────────
# The action script runs from the plugin directory so $PWD is the
# plugin path, not the user's working directory.  We query pane
# metadata in priority order:
#   1) $HERDR_PANE_ID (set by Herdr to the pane that triggered the action)
#   2) `herdr pane current` (current focused pane)
#   3) $PWD (last resort fallback, handled by open.sh)
pane_cwd=""
pane_id_for_plugin_check=""

if [ -n "${HERDR_PANE_ID:-}" ]; then
  log_debug "Attempt 1: pane get HERDR_PANE_ID='$HERDR_PANE_ID'"
  raw_pane_get=$( "$herdr_bin" pane get "$HERDR_PANE_ID" 2>&1 )
  log_debug "pane get raw: $raw_pane_get"
  pane_cwd=$( echo "$raw_pane_get" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    result = data.get('result', {})
    pane = result.get('pane', {}) if isinstance(result, dict) else {}
    if isinstance(pane, dict):
        cwd = pane.get('cwd') or pane.get('foreground_cwd', '')
        log_debug('pane get parsed -> cwd=' + repr(cwd))
        if cwd:
            print(cwd)
except Exception as e:
    log_debug('pane get parse error: ' + str(e))
" 2>/dev/null || echo "" )
  pane_id_for_plugin_check="$HERDR_PANE_ID"
fi

if [ -z "$pane_cwd" ]; then
  log_debug "Attempt 2: herdr pane current"
  raw_pane_current=$( "$herdr_bin" pane current 2>&1 )
  log_debug "pane current raw: $raw_pane_current"
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
  pane_id_for_plugin_check=$( echo "$raw_pane_current" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    result = data.get('result', {}) if isinstance(data, dict) else {}
    pane = result.get('pane', {}) if isinstance(result, dict) else {}
    if isinstance(pane, dict):
        print(pane.get('pane_id', ''))
except:
    pass
" 2>/dev/null || echo "" )
fi

# If the invoking pane is a Worklog plugin pane, its logical CWD
# (HERDR_RESOLVED_CWD in the pane's env) is more accurate than the
# filesystem cwd reported by `pane get` (the plugin directory).
if [ -n "$pane_id_for_plugin_check" ]; then
  plugin_cwd=$( _resolve_plugin_cwd "$pane_id_for_plugin_check" )
  if [ -n "$plugin_cwd" ]; then
    log_debug "Plugin pane detected — HERDR_RESOLVED_CWD='$plugin_cwd'"
    pane_cwd="$plugin_cwd"
  fi
fi

log_debug "Resolved pane_cwd='$pane_cwd'"

# Check if the worklist pane already exists
panes="$("$herdr_bin" pane list 2>/dev/null || true)"

# Find our pane by looking for one with the entrypoint command pattern.
# Note: `pane list` does not expose a `command` field for plugin panes,
# so we identify Worklog plugin panes by their label ("Work Items").
worklist_pane_id=$(printf '%s' "$panes" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    panes = data.get('result', data) if isinstance(data, dict) else data
    if isinstance(panes, dict) and 'panes' in panes:
        panes = panes['panes']
    for p in (panes if isinstance(panes, list) else []):
        label = p.get('label', '')
        cmd = ' '.join(p.get('command', []) or [])
        if label == 'Work Items' or 'worklog-selection-list' in cmd or 'packages/herdr/src/index.ts' in cmd:
            print(p.get('pane_id', ''))
            break
except:
    pass
" 2>/dev/null || true)

if [ -n "$worklist_pane_id" ]; then
  # Pane exists — check if it's focused
  focused_pane_id="$("$herdr_bin" pane current 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    result = data.get('result', {}) if isinstance(data, dict) else {}
    pane = result.get('pane', {}) if isinstance(result, dict) else {}
    if isinstance(pane, dict):
        print(pane.get('pane_id', ''))
except:
    pass
" 2>/dev/null || true)"

  if [ "$worklist_pane_id" = "$focused_pane_id" ]; then
    # Focused — close it
    exec "$herdr_bin" pane close "$worklist_pane_id"
  fi
  # Pane exists but is NOT focused: the pane process's CWD was set when it
  # was first created via --cwd in open.sh.  If the user has since switched
  # to a different project tab, the old CWD is stale and we'd show the wrong
  # work items.  Close the stale pane and re-open with the current tab's CWD.
  "$herdr_bin" pane close "$worklist_pane_id" 2>/dev/null || true
fi

log_debug "Calling open.sh with pane_cwd='$pane_cwd'"
exec bash "$(dirname "${BASH_SOURCE[0]:-$0}")/open.sh" "$pane_cwd"
