#!/usr/bin/env bash
# toggle.sh — Toggle the worklist selection list pane
#
# Opens the Worklog work item selection pane if not open, or focuses it
# if already open, or closes it if focused.

set -uo pipefail

herdr_bin="${HERDR_BIN_PATH:-herdr}"

# Capture the current pane's CWD before any pane manipulation.
# The action script runs from the plugin directory, but we need the
# user's focused pane CWD (e.g., TCE directory) for --cwd below.
pane_cwd=$( "$herdr_bin" pane current 2>/dev/null | python3 -c "
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

# Check if the worklist pane already exists
panes="$("$herdr_bin" pane list 2>/dev/null || true)"

# Find our pane by looking for one with the entrypoint command pattern
worklist_pane_id=$(printf '%s' "$panes" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    panes = data.get('result', data) if isinstance(data, dict) else data
    if isinstance(panes, dict) and 'panes' in panes:
        panes = panes['panes']
    for p in (panes if isinstance(panes, list) else []):
        cmd = ' '.join(p.get('command', []) or [])
        if 'worklog-selection-list' in cmd or 'packages/herdr/src/index.ts' in cmd:
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
    pane = data.get('result', data) if isinstance(data, dict) else data
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

# Open (or re-open) the pane with the current pane's CWD.
# Pass the captured CWD explicitly — open.sh uses it instead of $PWD.
exec bash "$(dirname "${BASH_SOURCE[0]:-$0}")/open.sh" "$pane_cwd"
