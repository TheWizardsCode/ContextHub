#!/usr/bin/env bash
# send-to-pi.sh — Open a pi agent pane to the right and send a command
#
# Usage:
#   bash packages/herdr/scripts/send-to-pi.sh <command>
#
# Opens a new pane to the right of the current herdr pane, launches pi
# (the AI coding agent) with the given command as the initial prompt,
# and renames the pane to "Pi Agent".
#
# Uses the herdr CLI to:
#   1. Split the current pane to the right
#   2. Parse the new pane_id from the JSON output
#   3. Run pi with the command in the new pane
#   4. Rename the pane to "Pi Agent" for identification

set -uo pipefail

# ── Config ────────────────────────────────────────────────────────────
herdr_bin="${HERDR_BIN_PATH:-herdr}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# ── Validate arguments ───────────────────────────────────────────────
if [ $# -eq 0 ]; then
  echo "Usage: $(basename "$0") <command>"
  echo ""
  echo "Opens a pi agent pane and sends the given command as the initial prompt."
  exit 1
fi

COMMAND="$*"

# ── Split the current pane to the right ──────────────────────────────
# `herdr pane split --current` splits the currently focused pane.
# The output is JSON containing the new pane's info including pane_id.
split_out="$("$herdr_bin" pane split --current --direction right --no-focus 2>/dev/null || true)"

if [ -z "$split_out" ]; then
  echo "Error: Failed to split pane. Ensure you are inside a herdr session." >&2
  exit 1
fi

# Parse the pane_id from JSON output
np="$(printf '%s' "$split_out" | sed -n 's/.*"pane_id":"\([^"]*\)".*/\1/p' | head -n1)"

if [ -z "$np" ]; then
  echo "Error: Could not determine new pane ID from split output" >&2
  echo "Output: $split_out" >&2
  exit 1
fi

# ── Run pi with the command in the new pane ──────────────────────────
# The command is passed as the initial prompt to pi's interactive mode.
# Use printf '%q' to safely quote the command for the inner shell.
quoted_cmd="$(printf '%q' "$COMMAND")"
"$herdr_bin" pane run "$np" exec pi "$quoted_cmd"

# ── Rename the pane for identification ────────────────────────────────
"$herdr_bin" pane rename "$np" "Pi Agent" >/dev/null 2>&1 || true

# ── Focus the new pane ────────────────────────────────────────────────
# Use zoom on/off to focus the pane
"$herdr_bin" pane zoom "$np" --on >/dev/null 2>&1 || true
"$herdr_bin" pane zoom "$np" --off >/dev/null 2>&1 || true
