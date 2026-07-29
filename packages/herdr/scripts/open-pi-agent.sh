#!/usr/bin/env bash
# open-pi-agent.sh — Open a Pi AI coding agent pane docked on the right
#
# Opens an interactive pi session in a new pane split to the right of the
# current pane. The pi agent starts in interactive mode, ready for prompts.

set -uo pipefail

herdr_bin="${HERDR_BIN_PATH:-herdr}"

# Split the current pane to the right
split_out="$("$herdr_bin" pane split --current --direction right --no-focus 2>/dev/null || true)"

if [ -z "$split_out" ]; then
  echo "Error: Failed to split pane. Ensure you are inside a herdr session." >&2
  exit 1
fi

# Parse the pane_id from JSON output
np="$(printf '%s' "$split_out" | sed -n 's/.*"pane_id":"\([^"]*\)".*/\1/p' | head -n1)"

if [ -z "$np" ]; then
  echo "Error: Could not determine new pane ID from split output" >&2
  exit 1
fi

# Start pi interactively in the new pane
"$herdr_bin" pane run "$np" exec pi

# Rename the pane
"$herdr_bin" pane rename "$np" "Pi Agent" >/dev/null 2>&1 || true

# Focus the new pane
"$herdr_bin" pane zoom "$np" --on >/dev/null 2>&1 || true
exec "$herdr_bin" pane zoom "$np" --off
