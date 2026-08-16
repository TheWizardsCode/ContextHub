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
#   --resize             Split right AND rebalance the right side into an even
#                        grid (anchor keeps 50% width x 100% height) (default)
#   --no-resize          Plain herdr split-right, no layout changes (default is resize)
#   --check-cli          Check herdr CLI availability before proceeding
#   --cwd <path>         Working directory for the new pane (default: $HERDR_RESOLVED_CWD, then $PWD).
#                        Honored in both --resize (forwarded to grid.py) and --no-resize
#                        (herdr pane split --cwd) modes.
#   --model <pattern>    Forward `--model <pattern>` to the pi CLI invocation
#                        (pi model pattern or id, e.g. `code` or `provider/id`)
#   --pane-id-file <path> Write the new pane ID as JSON ({"pane_id": "<id>"}) to
#                        <path> immediately after the split succeeds. Backward
#                        compatible: absent flag = current behavior (no file).
#   -h, --help           Show this help message
#
# Environment variables:
#   HERDR_BIN_PATH       Path to the herdr CLI binary (default: herdr on PATH)
#   HERDR_GRID_BIN       Path to the grid helper (default: grid.py next to this script)
#   HERDR_RESOLVED_CWD   Resolved project root for the new pane (set by the
#                        worklist plugin; overrides $PWD when --cwd is absent)
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
cwd_arg=""
model_arg=""
pane_id_file=""
resize=true
herdr_bin="${HERDR_BIN_PATH:-herdr}"
grid_bin="${HERDR_GRID_BIN:-$(cd "$(dirname "$0")" && pwd)/grid.py}"

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
    --resize)
      resize=true
      shift
      ;;
    --no-resize)
      resize=false
      shift
      ;;
    --check-cli)
      check_cli=true
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
    --model)
      model_arg="$2"
      shift 2
      ;;
    --model=*)
      model_arg="${1#*=}"
      shift
      ;;
    --pane-id-file)
      pane_id_file="$2"
      shift 2
      ;;
    --pane-id-file=*)
      pane_id_file="${1#*=}"
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

# ── Resolve the target CWD for the new pane ─────────────────────────
# Priority: --cwd arg > HERDR_RESOLVED_CWD > $PWD.  The new pane must
# start in the correct project root; herdr's "follow" policy would
# otherwise inherit the source pane's CWD (e.g. the plugin directory).
target_cwd="${cwd_arg:-${HERDR_RESOLVED_CWD:-$PWD}}"

# ── Split the current pane to the right ──────────────────────────────
if [ "$resize" = true ]; then
  # Resize mode: resolve the anchor pane and let the grid helper perform the
  # split and rebalance (safe ops only: pane.split + layout.set_split_ratio).
  # `pane current` emits JSON by default; it does NOT accept --json
  # (herdr 0.7.5: "unknown option: --json", exit 2).
  # The sed tolerates optional whitespace after the colon (json.dumps in
  # grid.py emits `"pane_id": "..."` while the herdr CLI emits `"pane_id":"..."`).
  anchor="$("$herdr_bin" pane current 2>/dev/null | sed -n 's/.*"pane_id": *"\([^"]*\)".*/\1/p' | head -n1)"
  if [ -z "$anchor" ]; then
    echo "Error: Could not resolve the current pane. Ensure you are inside a herdr session." >&2
    exit 1
  fi
  # Forward the resolved target CWD so the new pane starts in the correct
  # project root (herdr's pane.split RPC accepts cwd, herdr 0.7.5).
  grid_out="$(python3 "$grid_bin" --cwd "$target_cwd" "$anchor" 2>&1)" || true
  if [ -z "$grid_out" ] || ! echo "$grid_out" | grep -q '"pane_id"'; then
    echo "Error: Grid rebalance failed: $grid_out" >&2
    echo "Hint: retry with --no-resize for a plain split." >&2
    exit 1
  fi
  np="$(printf '%s' "$grid_out" | sed -n 's/.*"pane_id": *"\([^"]*\)".*/\1/p' | head -n1)"
else
  # Plain split-right (herdr default), no layout changes.
  split_out="$("$herdr_bin" pane split --current --direction right --no-focus --cwd "$target_cwd" 2>/dev/null || true)"
  if [ -z "$split_out" ]; then
    echo "Error: Failed to split pane. Ensure you are inside a herdr session." >&2
    exit 1
  fi
  np="$(printf '%s' "$split_out" | sed -n 's/.*"pane_id": *"\([^"]*\)".*/\1/p' | head -n1)"
fi

if [ -z "$np" ]; then
  echo "Error: Could not determine new pane ID" >&2
  exit 1
fi

# ── Publish the new pane ID (optional) ──────────────────────────────
# When --pane-id-file is given, write the pane ID immediately after the split
# succeeds so the calling plugin can record the pane association without
# parsing herdr output itself. Best effort: a failed write must not abort the
# (already successful) pane spawn.
if [ -n "$pane_id_file" ]; then
  printf '{"pane_id":"%s"}\n' "$np" > "$pane_id_file" 2>/dev/null || true
fi

# ── Run pi with the command in the new pane ──────────────────────────
# The pi session is launched via run-pi-agent.sh so the pane's pi session
# id is deterministic (--session-id) and the Local Proxy model lease is
# released when the session ends (normal exit or pane close).
# (WL-0MSGI7UIH008USVB)
wrapper_script="$(cd "$(dirname "$0")" && pwd)/run-pi-agent.sh"
# Session id must match pi's session-id rules (alphanumeric, '-', '_', '.').
# Unique per launch: timestamp + launcher pid + random suffix.
lease_session_id="herdr-$(date +%s)-$$-$RANDOM"
quoted_wrapper="$(printf '%q' "$wrapper_script")"
quoted_lease_id="$(printf '%q' "$lease_session_id")"
quoted_cmd="$(printf '%q' "$COMMAND")"
if [ -n "$model_arg" ]; then
  quoted_model="$(printf '%q' "$model_arg")"
  "$herdr_bin" pane run "$np" exec bash "$quoted_wrapper" "$quoted_lease_id" --model "$quoted_model" "$quoted_cmd"
else
  "$herdr_bin" pane run "$np" exec bash "$quoted_wrapper" "$quoted_lease_id" "$quoted_cmd"
fi

# ── Rename the pane ────────────────────────────────────────────────
"$herdr_bin" pane rename "$np" "$pane_name" >/dev/null 2>&1 || true

# ── Focus the new pane (unless --no-focus) ────────────────────────────
if [ "$focus" = true ]; then
  "$herdr_bin" pane zoom "$np" --on >/dev/null 2>&1 || true
  "$herdr_bin" pane zoom "$np" --off >/dev/null 2>&1 || true
fi
