#!/usr/bin/env bash
# run-in-pane.sh — Execute a command visibly in a new Herdr pane
#
# Splits the current pane to the right, runs the given command through a
# shell in the new pane so its command line and output are visible, renames
# the pane, and manages the pane lifecycle:
#   - any exit status → the pane stays open so the user can read the output;
#     the exit status is reported and a hint tells the user how to close the
#     pane manually (herdr `close_pane` binding, default `prefix+x`)
#
# Usage:
#   run-in-pane.sh <command>
#
# The command is executed via `bash -c`, so compound commands (`&&`),
# single-quoted arguments (e.g. `--summary 'Approved by manual review'`),
# and shell constructs all work.
#
# Environment variables:
#   HERDR_BIN_PATH       Path to the herdr CLI binary (default: herdr on PATH)
#   RUN_IN_PANE_NAME     Pane title (default: "Command Output")
#
# Returns:
#   0 on success (command executed in the new pane)
#   1 if herdr CLI is not found
#   1 if pane split fails
#   1 if new pane ID cannot be determined

set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
herdr_bin="${HERDR_BIN_PATH:-herdr}"

# ── In-pane wrapper mode ─────────────────────────────────────────────────
# Invoked by the new pane itself (via `herdr pane run ... exec bash
# <this-script> --exec <command> <pane_id>`). Runs the command, reports the
# exit status, and leaves the pane open so the user can read the output.
if [ "${1:-}" = "--exec" ]; then
  cmd="${2:-}"
  pane_id="${3:-}"

  if [ -z "$cmd" ]; then
    echo "Error: no command provided to run-in-pane.sh --exec" >&2
    exit 1
  fi

  bash -c "$cmd"
  status=$?

  echo ""
  echo "=== Command exited with status $status ==="
  echo "Pane left open — close it when done (herdr: prefix+x / close_pane)."

  exit "$status"
fi

# ── Main mode: split, run, rename ────────────────────────────────────────
pane_name="${RUN_IN_PANE_NAME:-Command Output}"
COMMAND="$*"

if [ -z "$COMMAND" ]; then
  echo "Usage: $(basename "$0") <command>" >&2
  exit 1
fi

if ! command -v "$herdr_bin" &>/dev/null; then
  echo "Error: herdr CLI not found at '$herdr_bin'. Set HERDR_BIN_PATH or ensure herdr is on PATH." >&2
  exit 1
fi

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
  echo "Output: $split_out" >&2
  exit 1
fi

# Run the command through a shell in the new pane. Each argument is
# bash-escaped so the pane's shell re-tokenizes it back to a single argv
# element (compound commands with && and quoted --summary values survive).
quoted_script="$(printf '%q' "$script_dir/run-in-pane.sh")"
quoted_cmd="$(printf '%q' "$COMMAND")"
quoted_pane="$(printf '%q' "$np")"

"$herdr_bin" pane run "$np" exec bash "$quoted_script" --exec "$quoted_cmd" "$quoted_pane"

# Rename the pane
"$herdr_bin" pane rename "$np" "$pane_name" >/dev/null 2>&1 || true

# Focus the new pane so the user sees the command run
"$herdr_bin" pane zoom "$np" --on >/dev/null 2>&1 || true
"$herdr_bin" pane zoom "$np" --off >/dev/null 2>&1 || true
