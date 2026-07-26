#!/usr/bin/env bash
# open.sh — Open the worklist selection list pane
#
# Opens the Worklog work item selection pane docked on the right.
# Uses Herdr's built-in plugin pane open for simplicity.

set -uo pipefail

herdr_bin="${HERDR_BIN_PATH:-herdr}"
exec "$herdr_bin" plugin pane open \
  --plugin worklog-selection-list \
  --entrypoint worklist \
  --placement split \
  --direction right \
  --focus
