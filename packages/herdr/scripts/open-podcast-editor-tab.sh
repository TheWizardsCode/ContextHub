#!/usr/bin/env bash
# open-podcast-editor-tab.sh — Open the Worklog tab
#
# Opens the Worklog work item selection pane in a NEW TAB and renames
# that tab to "Worklog" so it is instantly recognisable in the tab row
# among several open tabs.
#
# `herdr plugin pane open` (herdr 0.7.5) has no tab-title option — the
# created tab gets a generated numeric label. This script therefore opens
# the pane exactly like open.sh (same flags, same CWD resolution) and then
# renames the created tab via the socket API (`herdr tab rename`).
#
# Each invocation opens a new tab — there is deliberately no
# focus-if-open toggle; only the tab label changes.
#
# Usage: open-podcast-editor-tab.sh [cwd]
#   cwd - Optional working directory for the pane (default: resolved from
#         pane metadata / $PWD, same priority order as open.sh)
#
# Environment variables:
#   HERDR_BIN_PATH       Path to the herdr CLI binary (default: herdr on PATH)
#   TAB_LABEL            Tab label to apply (default: "Worklog")
#
# Returns:
#   0 on success (tab opened and renamed)
#   1 if the herdr CLI is not found
#   1 if `herdr plugin pane open` fails
#   1 if the created tab_id cannot be parsed from the open output
#   1 if `herdr tab rename` fails

set -uo pipefail

herdr_bin="${HERDR_BIN_PATH:-herdr}"
TAB_LABEL="${TAB_LABEL:-Worklog}"

fail() {
  echo "error: $*" >&2
  exit 1
}

# ── CLI availability check ─────────────────────────────────────────────
# Fail fast with a clear message instead of a confusing "command not found".
command -v "$herdr_bin" >/dev/null 2>&1 \
  || fail "herdr CLI not found ('${herdr_bin}'). Is herdr installed and on PATH? Set HERDR_BIN_PATH if it lives elsewhere."

# ── Resolve the logical CWD ────────────────────────────────────────────
# The action runs from the plugin directory so $PWD is wrong when invoked
# from a keybinding. Query in priority order (same as open.sh):
#   1) $1 (explicit argument)
#   2) $HERDR_PANE_ID → pane get
#   3) herdr pane current
#   4) $PWD (last resort)
#
# If the invoking pane is a Worklog plugin pane, its logical CWD
# (HERDR_RESOLVED_CWD in the pane's env) is more accurate than the
# filesystem cwd reported by `pane get`; read it from /proc via
# `herdr pane process-info`.
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

_pane_cwd_from_json() {
  python3 -c "
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
" 2>/dev/null || echo ""
}

_pane_id_from_json() {
  python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    pane = data.get('result', {}).get('pane', {})
    if isinstance(pane, dict):
        print(pane.get('pane_id', ''))
except:
    pass
" 2>/dev/null || echo ""
}

cwd="${1:-}"
pane_id_for_plugin_check=""

if [ -z "$cwd" ]; then
  pane_cwd=""
  if [ -n "${HERDR_PANE_ID:-}" ]; then
    raw_pane_get=$( "$herdr_bin" pane get "$HERDR_PANE_ID" 2>&1 )
    pane_cwd=$( echo "$raw_pane_get" | _pane_cwd_from_json )
    pane_id_for_plugin_check="$HERDR_PANE_ID"
  fi

  if [ -z "$pane_cwd" ]; then
    raw_pane_current=$( "$herdr_bin" pane current 2>&1 )
    pane_cwd=$( echo "$raw_pane_current" | _pane_cwd_from_json )
    pane_id_for_plugin_check=$( echo "$raw_pane_current" | _pane_id_from_json )
  fi

  # A Worklog plugin pane reports its logical CWD via HERDR_RESOLVED_CWD
  # in the pane process environment (see open.sh).
  if [ -n "$pane_id_for_plugin_check" ]; then
    plugin_cwd=$( _resolve_plugin_cwd "$pane_id_for_plugin_check" )
    [ -n "$plugin_cwd" ] && pane_cwd="$plugin_cwd"
  fi

  cwd="${pane_cwd:-$PWD}"
fi

# ── Open the worklist pane in a new tab ────────────────────────────────
# Pass the resolved CWD as an environment variable (not --cwd): the pane
# command uses a RELATIVE path, so --cwd would break script resolution.
# The plugin reads HERDR_RESOLVED_CWD to find the correct .worklog/.
open_output=$("$herdr_bin" plugin pane open \
  --plugin worklog-selection-list \
  --entrypoint worklist \
  --placement tab \
  --env "HERDR_RESOLVED_CWD=$cwd" \
  --focus 2>&1) \
  || fail "'herdr plugin pane open' failed. Is the herdr server running?
$open_output"

# ── Parse the created tab_id ───────────────────────────────────────────
# A missing rename is never silently skipped: if the tab_id cannot be
# parsed we fail with the raw output for diagnosis.
tab_id=$( printf '%s' "$open_output" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data['result']['plugin_pane']['pane']['tab_id'])
except Exception:
    pass
" 2>/dev/null || echo "" )

[ -n "$tab_id" ] \
  || fail "could not parse tab_id from 'herdr plugin pane open' output.
Raw output:
$open_output"

# ── Rename the tab ─────────────────────────────────────────────────────
"$herdr_bin" tab rename "$tab_id" "$TAB_LABEL" >/dev/null 2>&1 \
  || fail "'herdr tab rename $tab_id \"$TAB_LABEL\"' failed. Is the herdr server running?"

echo "Opened worklog tab '$TAB_LABEL' ($tab_id)." >&2
