#!/usr/bin/env bash
# open.sh — Open the worklist selection list pane
#
# Opens the Worklog work item selection pane in a new tab in the current
# workspace, providing full-screen access to the worklist.
# Uses Herdr's built-in plugin pane open for simplicity.

set -uo pipefail

herdr_bin="${HERDR_BIN_PATH:-herdr}"

# Query the focused pane's actual working directory via Herdr's API.
# The action script runs from the plugin installation directory, so
# $PWD would be the plugin path (wrong).  We get the real CWD from
# the focused pane metadata instead.
pane_cwd=$( "$herdr_bin" pane current 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    pane = data.get('result', {}).get('pane', {})
    cwd = pane.get('cwd') or pane.get('foreground_cwd', '')
    if cwd:
        print(cwd)
except:
    pass
" 2>/dev/null || echo "" )

# Fall back to $PWD if the query failed (e.g., not in a Herdr pane)
cwd="${pane_cwd:-$PWD}"

# Pass the captured CWD to the plugin pane so the plugin uses the
# correct working directory (not the plugin directory) to find the
# nearest .worklog/.
exec "$herdr_bin" plugin pane open \
  --plugin worklog-selection-list \
  --entrypoint worklist \
  --placement tab \
  --cwd "$cwd" \
  --focus
