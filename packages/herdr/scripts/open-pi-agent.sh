#!/usr/bin/env bash
# open-pi-agent.sh — Open a Pi AI coding agent pane docked on the right
#
# Thin wrapper around the shared open-pi-agent.sh for backward compatibility.
# The canonical implementation lives at ../shared/open-pi-agent.sh.
#
# Opens an interactive pi session in a new pane split to the right of the
# current pane.

set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
shared_script="$script_dir/../shared/open-pi-agent.sh"

if [ ! -f "$shared_script" ]; then
  echo "Error: Shared script not found at $shared_script" >&2
  exit 1
fi

# Forward all arguments to the shared implementation.
exec "$shared_script" "$@"
