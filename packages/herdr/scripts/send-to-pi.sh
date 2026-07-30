#!/usr/bin/env bash
# send-to-pi.sh — Open a Pi agent pane and send a command
#
# Thin wrapper around the shared send-to-pi.sh for backward compatibility.
# The canonical implementation lives at ../shared/send-to-pi.sh.
#
# Usage:
#   bash packages/herdr/scripts/send-to-pi.sh <command>

set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
shared_script="$script_dir/../shared/send-to-pi.sh"

if [ ! -f "$shared_script" ]; then
  echo "Error: Shared script not found at $shared_script" >&2
  exit 1
fi

# Forward all arguments to the shared implementation.
# ContextHub uses the default pane name "Pi Agent" and focuses the new pane.
exec "$shared_script" "$@"
