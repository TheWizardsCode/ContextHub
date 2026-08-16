#!/usr/bin/env bash
# run-pi-agent.sh — Run pi in a Herdr pane and release the Local Proxy
# model lease when the session ends (WL-0MSGI7UIH008USVB).
#
# Invoked by send-to-pi.sh / open-pi-agent.sh via:
#   herdr pane run <pane-id> exec bash <this-script> \
#     <lease-session-id> [--model <pattern>] [<command>...]
#
# The first positional argument is the pi session id used for BOTH the pi
# session (forwarded as `pi --session-id <id>`) and the lease release
# (`node release-lease-on-exit.mjs <id>`). Because the proxy keys dispatch
# leases by the session id pi sends in its session-affinity headers, a
# deterministic id per launch lets the release match the lease exactly.
#
# Release trigger (best-effort, never blocks the pane):
#   - pi exits normally          → EXIT trap
#   - pane closed via prefix+x   → TERM/HUP/INT trap (herdr tears the pane
#                                  down when the primary process exits)
#   Failures are silent: stdout/stderr of the release are discarded and a
#   missing release script or node simply skips the release.
#
# The wrapper propagates pi's exit status so pane teardown behaves exactly
# as it did when pi was the pane's direct command.

set -uo pipefail

lease_session_id="${1:-}"
shift || true

model_arg=""
if [ "${1:-}" = "--model" ]; then
  model_arg="$2"
  shift 2 || true
fi

# Everything remaining is the initial prompt for pi (empty for interactive).
command_args="$*"

wrapper_dir="$(cd "$(dirname "$0")" && pwd)"
release_script="$wrapper_dir/release-lease-on-exit.mjs"

# ── Lease release on session end ────────────────────────────────────────
release_lease() {
  if [ -n "$lease_session_id" ] && [ -f "$release_script" ]; then
    node "$release_script" "$lease_session_id" >/dev/null 2>&1 || true
  fi
}

# EXIT covers normal pi exit; TERM/HUP/INT cover pane close (prefix+x).
trap release_lease EXIT TERM HUP INT

# ── Run pi in the pane ───────────────────────────────────────────────────
# An empty lease_session_id (manual invocation without one) means no
# deterministic session id: run pi exactly as before (no --session-id flag).
if [ -z "$lease_session_id" ]; then
  if [ -n "$model_arg" ]; then
    pi --model "$model_arg" ${command_args:+"$command_args"}
  else
    pi ${command_args:+"$command_args"}
  fi
  status=$?
  exit "$status"
fi

if [ -n "$model_arg" ]; then
  pi --model "$model_arg" --session-id "$lease_session_id" ${command_args:+"$command_args"}
else
  pi --session-id "$lease_session_id" ${command_args:+"$command_args"}
fi
status=$?

exit "$status"
