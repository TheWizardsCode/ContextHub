#!/usr/bin/env bash
# send-to-pi.sh — Open a Pi agent pane and send a command
#
# Generalized shared version usable by any Herdr plugin.
#
# Usage:
#   shared/send-to-pi.sh [options] <command>
#
# Opens a new pane to the right of the current herdr pane, launches pi
# (the AI coding agent) with the given command as the initial prompt,
# and renames the pane.
#
# Options:
#   --pane-name <name>   Name to assign to the new pane (default: "Pi Agent")
#   --focus              Zoom/focus the new pane (default: on)
#   --no-focus           Explicitly skip zoom/focus
#   --check-cli          Check herdr CLI availability before proceeding
#   -h, --help           Show this help message
#
# Environment variables:
#   HERDR_BIN_PATH       Path to the herdr CLI binary (default: herdr on PATH)
#
# Returns:
#   0 on success
#   1 if herdr CLI is not found (with --check-cli)
#   1 if pane split fails
#   1 if new pane ID cannot be determined

set -uo pipefail

# ── Help ────────────────────────────────────────────────────────────────
show_help() {
  sed -n '/^# Usage/,/^$/p' "$0" | sed 's/^# //; s/^#$//'
  exit 0
}

# ── Defaults ────────────────────────────────────────────────────────────
pane_name="Pi Agent"
focus=true
check_cli=false
herdr_bin="${HERDR_BIN_PATH:-herdr}"

# ── Parse arguments ─────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pane-name)
      pane_name="$2"
      shift 2
      ;;
    --pane-name=*)
      pane_name="${1#*=}"
      shift
      ;;
    --focus)
      focus=true
      shift
      ;;
    --no-focus)
      focus=false
      shift
      ;;
    --check-cli)
      check_cli=true
      shift
      ;;
    -h|--help)
      show_help
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Error: Unknown option: $1" >&2
      echo "Usage: $(basename "$0") [options] <command>" >&2
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

# ── Validate arguments ───────────────────────────────────────────────
if [ $# -eq 0 ]; then
  echo "Usage: $(basename "$0") [options] <command>" >&2
  echo "" >&2
  echo "Opens a Pi agent pane and sends the given command as the initial prompt." >&2
  exit 1
fi

COMMAND="$*"

# ── Check CLI availability ────────────────────────────────────────────
if [ "$check_cli" = true ] && ! command -v "$herdr_bin" &>/dev/null; then
  echo "Error: herdr CLI not found at '$herdr_bin'. Set HERDR_BIN_PATH or ensure herdr is on PATH." >&2
  exit 1
fi

# ── Split the current pane to the right ──────────────────────────────
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
quoted_cmd="$(printf '%q' "$COMMAND")"
"$herdr_bin" pane run "$np" exec pi "$quoted_cmd"

# ── Rename the pane ────────────────────────────────────────────────
"$herdr_bin" pane rename "$np" "$pane_name" >/dev/null 2>&1 || true

# ── Focus the new pane (unless --no-focus) ────────────────────────────
if [ "$focus" = true ]; then
  "$herdr_bin" pane zoom "$np" --on >/dev/null 2>&1 || true
  "$herdr_bin" pane zoom "$np" --off >/dev/null 2>&1 || true
fi
