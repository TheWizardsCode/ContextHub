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

# Accept an optional CWD argument.  When called from toggle.sh, the
# current pane's actual CWD is passed explicitly.  When called directly
# (open-worklist action), $PWD is used as default.
cwd="${1:-$PWD}"

# Pass the working directory to the plugin pane so the plugin
# uses the correct directory (not the plugin directory) to find the
# nearest .worklog/.
exec "$herdr_bin" plugin pane open \
  --plugin worklog-selection-list \
  --entrypoint worklist \
  --placement tab \
  --cwd "$cwd" \
  --focus
