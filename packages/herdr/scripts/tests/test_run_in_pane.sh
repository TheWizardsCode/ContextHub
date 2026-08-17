#!/usr/bin/env bash
# test_run_inPane.sh — tests for run-in-pane.sh
#
# Covers the --exec wrapper mode:
#   - non-TTY + HERDR_PANE_ID: stays alive with ~0% CPU (not busy-looping)
#   - non-TTY + no HERDR_PANE_ID: exits immediately with command status
# Covers the --no-focus main-mode flag (WL-0MSHIA53D009DJOT):
#   - --no-focus skips the final pane zoom (selection list keeps focus)
#   - omitting --no-focus preserves the current focus/zoom behavior
#   - --no-focus does not affect pane creation / command execution
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

# ── Main-mode tests: zoom/focus behavior (WL-0MSHIA53D009DJOT) ─────┐
# └── Uses a mock herdr CLI so no live herdr session is required ─────┘
echo ""
echo "=== Test: no-focus flag (main mode, mock herdr CLI) ==="

SANDBOX="$(mktemp -d)"
HERDR_LOG="$SANDBOX/herdr-log.txt"

MOCK_HERDR="$SANDBOX/mock-herdr"
cat > "$MOCK_HERDR" <<MOCK
#!/usr/bin/env bash
echo "herdr:\$*" >> "$HERDR_LOG"
case "\$1" in
  pane)
    case "\$2" in
      split)
        echo '{"pane_id":"test-pane-main","success":true}'
        ;;
      run)
        echo "mock: ran"
        ;;
      rename|zoom)
        ;;
      *)
        echo "mock: unknown pane subcommand \$2" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "mock: unknown command \$1" >&2
    exit 1
    ;;
esac
MOCK
chmod +x "$MOCK_HERDR"

# --no-focus skips the final zoom entirely
rm -f "$HERDR_LOG"
HERDR_BIN_PATH="$MOCK_HERDR" bash "$RUN_IN_PANE" --no-focus --cwd /tmp "echo hi" < /dev/null >/dev/null 2>&1
if [ -f "$HERDR_LOG" ] && ! grep -q "zoom" "$HERDR_LOG"; then
  pass "--no-focus skips the final pane zoom"
else
  fail "--no-focus should skip the final pane zoom (log: $(cat "$HERDR_LOG" 2>/dev/null))"
fi

# Without the flag the zoom still happens (backward compatible)
rm -f "$HERDR_LOG"
HERDR_BIN_PATH="$MOCK_HERDR" bash "$RUN_IN_PANE" --cwd /tmp "echo hi" < /dev/null >/dev/null 2>&1
if grep -q "zoom" "$HERDR_LOG" 2>/dev/null; then
  pass "omitting --no-focus keeps the focus/zoom behavior"
else
  fail "without --no-focus the zoom must still run (log: $(cat "$HERDR_LOG" 2>/dev/null))"
fi

# --cwd is still honoured alongside --no-focus (the command still runs)
rm -f "$HERDR_LOG"
HERDR_BIN_PATH="$MOCK_HERDR" bash "$RUN_IN_PANE" --no-focus --cwd /tmp "echo hi" < /dev/null >/dev/null 2>&1
if grep -q "pane run" "$HERDR_LOG" 2>/dev/null; then
  pass "--no-focus does not affect pane creation / command execution"
else
  fail "--no-focus must not skip pane run (log: $(cat "$HERDR_LOG" 2>/dev/null))"
fi

rm -rf "$SANDBOX"

echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed"
echo "========================================"
[ "$FAIL" -eq 0 ]
