#!/usr/bin/env bash
# herdr-bin.sh — resolve the herdr CLI binary path (WL-0MVXRZL9H001GQ7A)
#
# WHY: herdr derives HERDR_BIN_PATH from its own `/proc/self/exe` and injects
# it into every pane and plugin action. After an in-place upgrade
# (`herdr update`) the running server still holds the OLD binary inode, so the
# injected value is the stale path with a ` (deleted)` suffix — e.g.
# `/home/me/.local/bin/herdr (deleted)`. Running that literal string can never
# work, which broke every plugin action (prefix+l, open, toggle, run-in-pane,
# send-to-pi, open-pi-agent) while the server was stale.
#
# Sourced by the plugin's shell entry points; the TypeScript counterpart is
# `../src/herdr-bin.ts` (keep the two in step).

# resolve_herdr_bin — print the herdr CLI path to use.
#
# Resolution order:
#   1. $HERDR_BIN_PATH with a stale ` (deleted)` suffix stripped, when it
#      names an existing executable file;
#   2. `herdr` found on PATH;
#   3. the stripped $HERDR_BIN_PATH (or `herdr` when it is unset), so the
#      caller's "not found" diagnostic names what was actually attempted.
#
# Returns 0 when a usable binary was found, 1 otherwise.
resolve_herdr_bin() {
  local configured="${HERDR_BIN_PATH:-}"
  if [ -z "$configured" ]; then
    printf '%s\n' "herdr"
    return 0
  fi

  # Strip the Linux /proc/self/exe artifact left behind by an in-place
  # upgrade ("/path/to/herdr (deleted)"). Only the trailing marker is removed.
  local candidate="$configured"
  case "$candidate" in
    *" (deleted)") candidate="${candidate% (deleted)}" ;;
  esac

  if [ -f "$candidate" ] && [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  local on_path
  on_path="$(command -v herdr 2>/dev/null || true)"
  if [ -n "$on_path" ]; then
    printf '%s\n' "$on_path"
    return 0
  fi

  printf '%s\n' "$candidate"
  return 1
}
