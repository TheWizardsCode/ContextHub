#!/usr/bin/env bash
# open.sh — Open the worklist selection list pane
#
# Opens the Worklog work item selection pane in a new tab in the current
# workspace, providing full-screen access to the worklist.
# Uses Herdr's built-in plugin pane open for simplicity.
#
# Passes --cwd from the currently focused pane so the plugin pane inherits
# the tab's working directory rather than the workspace default.

set -uo pipefail

herdr_bin="${HERDR_BIN_PATH:-herdr}"

# Get the current focused pane's working directory so the new pane inherits
# the correct CWD (the tab's directory, not the workspace default).
focused_cwd="$("$herdr_bin" pane current 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    pane = data.get('result', {}).get('pane', {}) if isinstance(data, dict) else {}
    cwd = pane.get('foreground_cwd', pane.get('cwd', ''))
    if cwd:
        print(cwd)
except:
    pass
" 2>/dev/null || true)"

exec "$herdr_bin" plugin pane open \
  --plugin worklog-selection-list \
  --entrypoint worklist \
  --placement tab \
  ${focused_cwd:+--cwd "$focused_cwd"} \
  --focus
