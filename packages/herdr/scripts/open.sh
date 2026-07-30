#!/usr/bin/env bash
# open.sh — Open the worklist selection list pane
#
# Opens the Worklog work item selection pane in a new tab in the current
# workspace, providing full-screen access to the worklist.
# Uses Herdr's built-in plugin pane open for simplicity.

set -uo pipefail

herdr_bin="${HERDR_BIN_PATH:-herdr}"

# Pass the current working directory to the plugin pane so the plugin
# uses the tab's working directory (not the plugin directory) to find
# the nearest .worklog/.
exec "$herdr_bin" plugin pane open \
  --plugin worklog-selection-list \
  --entrypoint worklist \
  --placement tab \
  --cwd "$PWD" \
  --focus
