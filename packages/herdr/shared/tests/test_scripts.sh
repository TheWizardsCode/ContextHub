#!/usr/bin/env bash
# test_scripts.sh — bash tests for the shared launch scripts' resize mode
#
# Covers --resize (default) / --no-resize handling and --cwd forwarding to
# the grid helper in resize mode for:
#   packages/herdr/shared/send-to-pi.sh
#   packages/herdr/shared/open-pi-agent.sh
#
# Uses a mock herdr CLI (HERDR_BIN_PATH) and a mock grid helper
# (HERDR_GRID_BIN) — no live herdr session required.
#
# Run from the repo root (or anywhere):
#   bash packages/herdr/shared/tests/test_scripts.sh
set -uo pipefail

SHARED_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SEND_TO_PI="$SHARED_DIR/send-to-pi.sh"
OPEN_PI_AGENT="$SHARED_DIR/open-pi-agent.sh"
PASS=0
FAIL=0

# ── Test helpers ──────────────────────────────────────────────────────

pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# Temporary sandbox for mocks and logs
SANDBOX="$(mktemp -d)"
HERDR_LOG="$SANDBOX/herdr-log.txt"
GRID_LOG="$SANDBOX/grid-log.txt"

trap 'rm -rf "$SANDBOX"' EXIT

# ── Mocks ─────────────────────────────────────────────────────────────

# Mock herdr CLI — records every invocation, dispatches pane subcommands.
MOCK_HERDR="$SANDBOX/mock-herdr"
cat > "$MOCK_HERDR" <<MOCK
#!/usr/bin/env bash
echo "herdr:\$*" >> "$HERDR_LOG"
case "\$1" in
  pane)
    case "\$2" in
      current)
        echo '{"pane_id":"anchor-pane-9","success":true}'
        ;;
      split)
        # --no-resize path: split --current --direction right ...
        echo '{"pane_id":"plain-pane-1","success":true}'
        ;;
      run)
        echo "mock: ran \$4 in pane \$3"
        ;;
      rename)
        echo "mock: renamed \$3 to \$4"
        ;;
      zoom)
        echo "mock: zoom \$3 \$4"
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

# Mock grid helper — records the invocation, prints a fake new pane id.
# Emits JSON with a space after the colon (like grid.py's json.dumps) so the
# scripts' sed parsing is exercised against the real output format.
MOCK_GRID="$SANDBOX/mock-grid.py"
cat > "$MOCK_GRID" <<MOCK
#!/usr/bin/env python3
import sys
with open("$GRID_LOG", "a") as f:
    f.write("grid:" + " ".join(sys.argv[1:]) + "\n")
print('{"pane_id": "grid-pane-5"}')
MOCK
chmod +x "$MOCK_GRID"

# ── Helper: run a script with mocks and capture output ────────────────

run_send() {
  rm -f "$HERDR_LOG" "$GRID_LOG"
  HERDR_BIN_PATH="$MOCK_HERDR" HERDR_GRID_BIN="$MOCK_GRID" \
    "$SEND_TO_PI" "$@" 2>&1
}

run_open() {
  rm -f "$HERDR_LOG" "$GRID_LOG"
  HERDR_BIN_PATH="$MOCK_HERDR" HERDR_GRID_BIN="$MOCK_GRID" \
    "$OPEN_PI_AGENT" "$@" 2>&1
}

# ── Tests ─────────────────────────────────────────────────────────────

echo "=== Test: Scripts exist and are executable ==="
[ -f "$SEND_TO_PI" ] && pass "send-to-pi.sh exists" || fail "send-to-pi.sh missing"
[ -x "$SEND_TO_PI" ] && pass "send-to-pi.sh executable" || fail "send-to-pi.sh not executable"
[ -f "$OPEN_PI_AGENT" ] && pass "open-pi-agent.sh exists" || fail "open-pi-agent.sh missing"
[ -x "$OPEN_PI_AGENT" ] && pass "open-pi-agent.sh executable" || fail "open-pi-agent.sh not executable"

echo ""
echo "=== Test: Default mode (no flag) uses resize — grid helper invoked with anchor pane ==="
out="$(run_send "do the thing")" || true
if grep -q "grid:--cwd .* anchor-pane-9" "$GRID_LOG" 2>/dev/null; then
  pass "send-to-pi default mode invokes grid helper with anchor pane id"
else
  fail "send-to-pi default mode should invoke grid helper with anchor pane id"
  echo "  grid log: $(cat "$GRID_LOG" 2>/dev/null)"
fi
if echo "$out" | grep -q "grid-pane-5"; then
  pass "send-to-pi uses the pane id returned by the grid helper"
else
  fail "send-to-pi should use the grid helper's returned pane id"
fi
if grep -q "pane current" "$HERDR_LOG" 2>/dev/null; then
  pass "send-to-pi resolves the anchor pane via 'herdr pane current'"
else
  fail "send-to-pi should resolve anchor via 'herdr pane current'"
fi
if grep -q "pane current --json" "$HERDR_LOG" 2>/dev/null; then
  fail "send-to-pi must not pass --json to 'herdr pane current' (herdr 0.7.5 rejects it)"
else
  pass "send-to-pi calls 'herdr pane current' without --json"
fi

echo ""
echo "=== Test: resize mode forwards --cwd to the grid helper ==="
# HERDR_RESOLVED_CWD takes priority over \$PWD when --cwd is absent
HERDR_RESOLVED_CWD="/resolved/proj" run_send "do the thing" >/dev/null 2>&1 || true
if grep -q "grid:--cwd /resolved/proj anchor-pane-9" "$GRID_LOG" 2>/dev/null; then
  pass "send-to-pi resize mode forwards HERDR_RESOLVED_CWD to the grid helper"
else
  fail "send-to-pi resize mode should forward HERDR_RESOLVED_CWD to the grid helper"
  echo "  grid log: $(cat "$GRID_LOG" 2>/dev/null)"
fi

run_send --cwd /tmp/proj "do the thing" >/dev/null 2>&1 || true
if grep -q "grid:--cwd /tmp/proj anchor-pane-9" "$GRID_LOG" 2>/dev/null; then
  pass "send-to-pi resize mode forwards explicit --cwd to the grid helper"
else
  fail "send-to-pi resize mode should forward explicit --cwd to the grid helper"
  echo "  grid log: $(cat "$GRID_LOG" 2>/dev/null)"
fi

run_send "do the thing" >/dev/null 2>&1 || true
if grep -q "grid:--cwd" "$GRID_LOG" 2>/dev/null; then
  pass "send-to-pi resize mode always passes --cwd (defaults to \$PWD)"
else
  fail "send-to-pi resize mode should always pass --cwd to the grid helper"
  echo "  grid log: $(cat "$GRID_LOG" 2>/dev/null)"
fi

HERDR_RESOLVED_CWD="/resolved/proj" run_open >/dev/null 2>&1 || true
if grep -q "grid:--cwd /resolved/proj anchor-pane-9" "$GRID_LOG" 2>/dev/null; then
  pass "open-pi-agent resize mode forwards HERDR_RESOLVED_CWD to the grid helper"
else
  fail "open-pi-agent resize mode should forward HERDR_RESOLVED_CWD to the grid helper"
  echo "  grid log: $(cat "$GRID_LOG" 2>/dev/null)"
fi

run_open --cwd /tmp/proj >/dev/null 2>&1 || true
if grep -q "grid:--cwd /tmp/proj anchor-pane-9" "$GRID_LOG" 2>/dev/null; then
  pass "open-pi-agent resize mode forwards explicit --cwd to the grid helper"
else
  fail "open-pi-agent resize mode should forward explicit --cwd to the grid helper"
  echo "  grid log: $(cat "$GRID_LOG" 2>/dev/null)"
fi

unset HERDR_RESOLVED_CWD

# Regression: --no-resize keeps the plain-split path (grid helper not invoked)
run_send --no-resize "do the thing" >/dev/null 2>&1 || true
if [ ! -s "$GRID_LOG" ]; then
  pass "send-to-pi --no-resize still avoids the grid helper (regression)"
else
  fail "send-to-pi --no-resize should still avoid the grid helper"
  echo "  grid log: $(cat "$GRID_LOG" 2>/dev/null)"
fi

echo ""
echo "=== Test: open-pi-agent default mode uses resize ==="
run_open >/dev/null 2>&1 || true
if grep -q "grid:--cwd .* anchor-pane-9" "$GRID_LOG" 2>/dev/null; then
  pass "open-pi-agent default mode invokes grid helper with anchor pane id"
else
  fail "open-pi-agent default mode should invoke grid helper"
  echo "  grid log: $(cat "$GRID_LOG" 2>/dev/null)"
fi

echo ""
echo "=== Test: --no-resize performs a plain split, no grid helper ==="
out="$(run_send --no-resize "do the thing")" || true
if [ ! -s "$GRID_LOG" ]; then
  pass "send-to-pi --no-resize does not invoke the grid helper"
else
  fail "send-to-pi --no-resize should not invoke the grid helper"
  echo "  grid log: $(cat "$GRID_LOG")"
fi
if grep -q "pane split --current --direction right" "$HERDR_LOG" 2>/dev/null; then
  pass "send-to-pi --no-resize performs a plain 'herdr pane split --direction right'"
else
  fail "send-to-pi --no-resize should perform plain pane split right"
  echo "  herdr log: $(cat "$HERDR_LOG" 2>/dev/null)"
fi
if grep -q "grid:--cwd .* anchor-pane-9" "$GRID_LOG" 2>/dev/null; then
  fail "send-to-pi --no-resize must not call grid helper"
else
  pass "send-to-pi --no-resize never calls grid helper"
fi

echo ""
echo "=== Test: open-pi-agent --no-resize plain split ==="
run_open --no-resize >/dev/null 2>&1 || true
if [ ! -s "$GRID_LOG" ] && grep -q "pane split --current --direction right" "$HERDR_LOG" 2>/dev/null; then
  pass "open-pi-agent --no-resize plain split, no grid helper"
else
  fail "open-pi-agent --no-resize should plain-split without grid helper"
fi

echo ""
echo "=== Test: explicit --resize flag behaves like default ==="
run_send --resize "do the thing" >/dev/null 2>&1 || true
if grep -q "grid:--cwd .* anchor-pane-9" "$GRID_LOG" 2>/dev/null; then
  pass "explicit --resize invokes grid helper"
else
  fail "explicit --resize should invoke grid helper"
fi

echo ""
echo "=== Test: existing options still work (--pane-name, --focus, --no-focus, --cwd, --model) ==="
out="$(run_send --pane-name "My Agent" --focus --cwd /tmp/proj --model code "hello")" || true
if grep -q "pane run grid-pane-5 exec pi --model code" "$HERDR_LOG" 2>/dev/null; then
  pass "--model forwarded to pi invocation"
else
  fail "--model should be forwarded to pi"
  echo "  herdr log: $(cat "$HERDR_LOG" 2>/dev/null)"
fi
if grep -q "pane rename grid-pane-5 My Agent" "$HERDR_LOG" 2>/dev/null; then
  pass "--pane-name applied to grid pane"
else
  fail "--pane-name should be applied"
fi
if grep -q "pane current" "$HERDR_LOG" 2>/dev/null && ! grep -q "pane split" "$HERDR_LOG" 2>/dev/null; then
  pass "resize mode: split is delegated to the grid helper (no herdr pane split)"
else
  fail "resize mode should delegate the split to grid.py (no herdr pane split)"
  echo "  herdr log: $(cat "$HERDR_LOG" 2>/dev/null)"
fi

echo ""
echo "=== Test: open-pi-agent --pane-name and --cwd ==="
run_open --pane-name "My Agent" --cwd /tmp/proj >/dev/null 2>&1 || true
if grep -q "pane rename grid-pane-5 My Agent" "$HERDR_LOG" 2>/dev/null; then
  pass "open-pi-agent --pane-name applied"
else
  fail "open-pi-agent --pane-name should be applied"
fi

echo ""
echo "=== Test: missing args show usage ==="
out="$(run_send 2>&1)" || true
if echo "$out" | grep -qi "usage"; then
  pass "send-to-pi shows usage with no arguments"
else
  fail "send-to-pi should show usage with no arguments"
fi

echo ""
echo "=== Test: unknown option errors ==="
out="$(run_send --bogus "x" 2>&1)" || true
if echo "$out" | grep -qi "unknown option"; then
  pass "send-to-pi rejects unknown options"
else
  fail "send-to-pi should reject unknown options"
fi

echo ""
echo "=== Test: grid helper failure exits non-zero with clear message ==="
MOCK_GRID_FAIL="$SANDBOX/mock-grid-fail.py"
cat > "$MOCK_GRID_FAIL" <<MOCK
#!/usr/bin/env python3
import sys
with open("$GRID_LOG", "a") as f:
    f.write("grid:" + " ".join(sys.argv[1:]) + "\n")
print("Error: herdr did not return a new pane id", file=sys.stderr)
sys.exit(1)
MOCK
chmod +x "$MOCK_GRID_FAIL"
rm -f "$GRID_LOG"
out="$(HERDR_BIN_PATH="$MOCK_HERDR" HERDR_GRID_BIN="$MOCK_GRID_FAIL" "$SEND_TO_PI" "x" 2>&1)"
rc=$?
if [ $rc -ne 0 ]; then
  pass "send-to-pi exits non-zero when grid helper fails"
else
  fail "send-to-pi should exit non-zero when grid helper fails"
fi
if echo "$out" | grep -qi "error"; then
  pass "send-to-pi prints an error message on grid helper failure"
else
  fail "send-to-pi should print an error message on grid helper failure"
fi

echo ""
echo "=== Test: split failure (--no-resize) exits non-zero ==="
MOCK_HERDR_SPLIT_FAIL="$SANDBOX/mock-herdr-split-fail"
cat > "$MOCK_HERDR_SPLIT_FAIL" <<MOCK
#!/usr/bin/env bash
echo "herdr:\$*" >> "$HERDR_LOG"
case "\$1" in
  pane)
    case "\$2" in
      split)
        echo "Error: split failed" >&2
        exit 1
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
  *)
    exit 0
    ;;
esac
MOCK
chmod +x "$MOCK_HERDR_SPLIT_FAIL"
rm -f "$HERDR_LOG"
out="$(HERDR_BIN_PATH="$MOCK_HERDR_SPLIT_FAIL" "$SEND_TO_PI" --no-resize "x" 2>&1)"
rc=$?
if [ $rc -ne 0 ]; then
  pass "send-to-pi exits non-zero when plain split fails"
else
  fail "send-to-pi should exit non-zero when plain split fails"
fi

echo ""
echo "=== Test: usage/help flag ==="
out="$(run_send --help 2>&1)" || true
if echo "$out" | grep -qi "resize"; then
  pass "send-to-pi --help documents --resize/--no-resize"
else
  fail "send-to-pi --help should document --resize/--no-resize"
fi

echo ""
echo "=== Test: default focus zooms the new pane (--focus implied) ==="
run_send "hello" >/dev/null 2>&1 || true
if grep -q "pane zoom" "$HERDR_LOG" 2>/dev/null; then
  pass "send-to-pi default focuses the new pane (zoom invoked)"
else
  fail "send-to-pi default should focus the new pane (zoom)"
  echo "  herdr log: $(cat "$HERDR_LOG" 2>/dev/null)"
fi
run_open "hello" >/dev/null 2>&1 || true
if grep -q "pane zoom" "$HERDR_LOG" 2>/dev/null; then
  pass "open-pi-agent default focuses the new pane (zoom invoked)"
else
  fail "open-pi-agent default should focus the new pane (zoom)"
  echo "  herdr log: $(cat "$HERDR_LOG" 2>/dev/null)"
fi

echo ""
echo "=== Test: --no-focus skips the zoom calls ==="
run_send --no-focus "hello" >/dev/null 2>&1 || true
if grep -q "pane zoom" "$HERDR_LOG" 2>/dev/null; then
  fail "send-to-pi --no-focus should not zoom the pane"
  echo "  herdr log: $(cat "$HERDR_LOG" 2>/dev/null)"
else
  pass "send-to-pi --no-focus skips zoom"
fi
run_open --no-focus "hello" >/dev/null 2>&1 || true
if grep -q "pane zoom" "$HERDR_LOG" 2>/dev/null; then
  fail "open-pi-agent --no-focus should not zoom the pane"
  echo "  herdr log: $(cat "$HERDR_LOG" 2>/dev/null)"
else
  pass "open-pi-agent --no-focus skips zoom"
fi

echo ""
echo "=== Test: --check-cli fails fast when herdr CLI is missing ==="
# Use a non-existent binary path so --check-cli aborts before launching.
rm -f "$HERDR_LOG" "$GRID_LOG"
out="$(HERDR_BIN_PATH="$SANDBOX/no-such-herdr" HERDR_GRID_BIN="$MOCK_GRID" "$SEND_TO_PI" --check-cli "hello" 2>&1)"
rc=$?
if [ "$rc" -ne 0 ] && echo "$out" | grep -qi "not found\|missing\|unavailable"; then
  pass "send-to-pi --check-cli exits non-zero with a clear error when herdr is missing"
else
  fail "send-to-pi --check-cli should fail fast when herdr is missing (rc=$rc)"
  echo "  output: $out"
fi

# Without --check-cli the script still fails (herdr missing), but reaches
# the split path instead of the CLI availability check.
rm -f "$HERDR_LOG" "$GRID_LOG"
out="$(HERDR_BIN_PATH="$SANDBOX/no-such-herdr" HERDR_GRID_BIN="$MOCK_GRID" "$SEND_TO_PI" "hello" 2>&1)" || true
if [ -n "$out" ]; then
  pass "send-to-pi without --check-cli still reports an error when herdr is missing"
else
  fail "send-to-pi without --check-cli should report an error when herdr is missing"
fi

echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed"
echo "========================================"
[ "$FAIL" -eq 0 ]
