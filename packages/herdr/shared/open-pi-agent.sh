#!/usr/bin/env bash
# open-pi-agent.sh — Open a Pi AI coding agent pane docked on the right
#
# Generalized shared version usable by any Herdr plugin.
#
# Usage:
#   shared/open-pi-agent.sh [options]
#
# Opens an interactive pi session in a new pane split to the right of the
# current pane. The pi agent starts in interactive mode, ready for prompts.
#
# Options:
#   --pane-name <name>   Name to assign to the new pane (default: "Pi Agent")
#   --focus              Zoom/focus the new pane (default: on)
#   --no-focus           Explicitly skip zoom/focus
#   --cwd <path>         Working directory for the new pane (default: $HERDR_RESOLVED_CWD, then $PWD)
#   -h, --help           Show this help message
#
# Environment variables:
#   HERDR_BIN_PATH       Path to the herdr CLI binary (default: herdr on PATH)
#   HERDR_RESOLVED_CWD   Resolved project root for the new pane (set by the
#                        worklist plugin; overrides $PWD when --cwd is absent)
#
# Returns:
#   0 on success
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
cwd_arg=""
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
    --cwd)
      cwd_arg="$2"
      shift 2
      ;;
    --cwd=*)
      cwd_arg="${1#*=}"
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
      echo "Usage: $(basename "$0") [options]" >&2
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

# ── Resolve the target CWD for the new pane ─────────────────────────
# Priority: --cwd arg > HERDR_RESOLVED_CWD > $PWD.  The new pane must
# start in the correct project root; herdr's "follow" policy would
# otherwise inherit the source pane's CWD (e.g. the plugin directory).
target_cwd="${cwd_arg:-${HERDR_RESOLVED_CWD:-$PWD}}"

# ── Split the current pane to the right ──────────────────────────────
split_out="$("$herdr_bin" pane split --current --direction right --no-focus --cwd "$target_cwd" 2>/dev/null || true)"

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

# ── Start pi interactively in the new pane ──────────────────────────
"$herdr_bin" pane run "$np" exec pi

# ── Rename the pane ────────────────────────────────────────────────
"$herdr_bin" pane rename "$np" "$pane_name" >/dev/null 2>&1 || true

# ── Focus the new pane (unless --no-focus) ────────────────────────────
if [ "$focus" = true ]; then
  "$herdr_bin" pane zoom "$np" --on >/dev/null 2>&1 || true
  exec "$herdr_bin" pane zoom "$np" --off
fi
