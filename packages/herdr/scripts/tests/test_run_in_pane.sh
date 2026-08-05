#!/usr/bin/env bash
# test_run_inPane.sh — tests for run-in-pane.sh
#
# Covers the --exec wrapper mode:
#   - non-TTY + HERDR_PANE_ID: stays alive with ~0% CPU (not busy-looping)
#   - non-TTY + no HERDR_PANE_ID: exits immediately with command status
#
# Run from the repo root (or anywhere):
#   bash packages/herdr/scripts/tests/test_run_in_pane.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_IN_PANE="$SCRIPT_DIR/run-in-pane.sh"
PASS=0
FAIL=0

pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

cleanup() {
  # Kill any remaining background test processes
  for pid in "${TEST_PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT
TEST_PIDS=()

# ── Test: non-TTY + HERDR_PANE_ID stays alive with ~0% CPU ──────────────
echo "=== Test: --exec with HERDR_PANE_ID blocks (0% CPU, stays alive) ==="

HERDR_PANE_ID="test-pane-1" bash "$RUN_IN_PANE" --exec "echo test_output" "test-pane-1" < /dev/null &
PID=$!
TEST_PIDS+=($PID)

sleep 2

# Check process is still alive
if kill -0 "$PID" 2>/dev/null; then
  pass "--exec + HERDR_PANE_ID keeps process alive"
else
  fail "--exec + HERDR_PANE_ID should keep process alive"
fi

# Check CPU usage is near zero (should be 0.0 or very low for a sleeping process)
CPU=$(ps -p "$PID" -o %cpu --no-headers 2>/dev/null | tr -d ' ' || echo "unknown")
if [[ "$CPU" == "0.0" ]] || [[ "$CPU" == "0."* ]]; then
  pass "CPU usage is near zero ($CPU%)"
else
  fail "CPU usage too high ($CPU%) — likely busy-looping"
fi

# Kill the background process
kill "$PID" 2>/dev/null
wait "$PID" 2>/dev/null || true
TEST_PIDS=()

# ── Test: non-TTY + no HERDR_PANE_ID exits immediately ──────────────────
echo ""
echo "=== Test: --exec without HERDR_PANE_ID exits immediately ==="

HERDR_PANE_ID="" bash "$RUN_IN_PANE" --exec "echo exit_test" "test-pane-2" < /dev/null
RC=$?

if [ "$RC" -eq 0 ]; then
  pass "exits immediately with command status 0"
else
  fail "should exit with status 0, got $RC"
fi

# ── Test: --exec without command fails with error ───────────────────────
echo ""
echo "=== Test: --exec with no command prints error and exits non-zero ==="

HERDR_PANE_ID="test" bash "$RUN_IN_PANE" --exec "" "test-pane-3" < /dev/null
RC=$?

if [ "$RC" -ne 0 ]; then
  pass "exits non-zero when no command provided"
else
  fail "should exit non-zero with no command"
fi

echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed"
echo "========================================"
[ "$FAIL" -eq 0 ]
