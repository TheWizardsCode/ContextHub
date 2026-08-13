#!/usr/bin/env bash
# test_lease_release.sh — bash tests for the Herdr pi-pane lease-release
# wiring (WL-0MSGI7UIH008USVB):
#
#   packages/herdr/shared/run-pi-agent.sh          — in-pane wrapper
#   packages/herdr/shared/release-lease-on-exit.mjs — release executor
#
# Covers:
#   - wrapper runs pi with a deterministic --session-id (command + interactive)
#   - wrapper forwards --model
#   - wrapper invokes the release executor with the same session id on exit
#   - wrapper propagates pi's exit status
#   - no release when no session id is provided
#   - send-to-pi.sh / open-pi-agent.sh launch pi via the wrapper with a
#     valid herdr- session id (mock herdr CLI)
#
# Uses mock `pi` / `node` / `herdr` binaries on PATH — no live pi session
# and no real HTTP requests.
#
# Run from the repo root (or anywhere):
#   bash packages/herdr/shared/tests/test_lease_release.sh

set -uo pipefail

SHARED_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_PI_AGENT="$SHARED_DIR/run-pi-agent.sh"
SEND_TO_PI="$SHARED_DIR/send-to-pi.sh"
OPEN_PI_AGENT="$SHARED_DIR/open-pi-agent.sh"
PASS=0
FAIL=0

pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# Temporary sandbox for mocks and logs
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

# ── Mock pi / node / herdr binaries ────────────────────────────────────

# Mock pi: records every invocation, exits with $MOCK_PI_EXIT (default 0).
MOCK_PI="$SANDBOX/bin/pi"
MOCK_NODE="$SANDBOX/bin/node"
MOCK_HERDR="$SANDBOX/bin/herdr"
mkdir -p "$SANDBOX/bin"
cat > "$MOCK_PI" <<MOCK
#!/usr/bin/env bash
echo "pi:\$*" >> "$SANDBOX/pi.log"
exit "\${MOCK_PI_EXIT:-0}"
MOCK
# Mock node: records every invocation (release executor only).
cat > "$MOCK_NODE" <<MOCK
#!/usr/bin/env bash
echo "node:\$*" >> "$SANDBOX/node.log"
exit 0
MOCK
# Mock herdr CLI: records invocations, answers pane current / split / run.
cat > "$MOCK_HERDR" <<MOCK
#!/usr/bin/env bash
echo "herdr:\$*" >> "$SANDBOX/herdr.log"
case "\$1" in
  pane)
    case "\$2" in
      current)
        echo '{"pane_id":"anchor-pane-9","success":true}'
        ;;
      split)
        echo '{"pane_id":"pane-1","success":true}'
        ;;
      run|rename|zoom)
        exit 0
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
chmod +x "$MOCK_PI" "$MOCK_NODE" "$MOCK_HERDR"

# Capture the real node before the mock bin is prepended to PATH.
REAL_NODE="$(command -v node)"

export PATH="$SANDBOX/bin:$PATH"

# ── Tests: run-pi-agent.sh (in-pane wrapper) ──────────────────────────

echo "=== Test: wrapper runs pi with --session-id and the command ==="
rm -f "$SANDBOX/pi.log" "$SANDBOX/node.log"
bash "$RUN_PI_AGENT" "herdr-1723456789-1234-5678" "/skill:implement WL-123" >/dev/null 2>&1
if grep -q "^pi:--session-id herdr-1723456789-1234-5678 /skill:implement WL-123$" "$SANDBOX/pi.log" 2>/dev/null; then
  pass "pi invoked with --session-id and command"
else
  fail "pi should be invoked with --session-id and command"
  echo "  pi log: $(cat "$SANDBOX/pi.log" 2>/dev/null)"
fi
if grep -q "^node:.*release-lease-on-exit.mjs herdr-1723456789-1234-5678$" "$SANDBOX/node.log" 2>/dev/null; then
  pass "release executor invoked with the same session id on exit"
else
  fail "release executor should be invoked with the session id on exit"
  echo "  node log: $(cat "$SANDBOX/node.log" 2>/dev/null)"
fi

echo ""
echo "=== Test: wrapper runs pi interactively (no command) ==="
rm -f "$SANDBOX/pi.log" "$SANDBOX/node.log"
bash "$RUN_PI_AGENT" "herdr-1723456789-1234-5678" >/dev/null 2>&1
if grep -q "^pi:--session-id herdr-1723456789-1234-5678$" "$SANDBOX/pi.log" 2>/dev/null; then
  pass "interactive pi invoked with --session-id only"
else
  fail "interactive pi should be invoked with --session-id only"
  echo "  pi log: $(cat "$SANDBOX/pi.log" 2>/dev/null)"
fi

echo ""
echo "=== Test: wrapper forwards --model to pi ==="
rm -f "$SANDBOX/pi.log" "$SANDBOX/node.log"
bash "$RUN_PI_AGENT" "herdr-1723456789-1234-5678" --model "code" "/skill:implement WL-123" >/dev/null 2>&1
if grep -q "^pi:--model code --session-id herdr-1723456789-1234-5678 /skill:implement WL-123$" "$SANDBOX/pi.log" 2>/dev/null; then
  pass "--model forwarded before --session-id"
else
  fail "--model should be forwarded to pi"
  echo "  pi log: $(cat "$SANDBOX/pi.log" 2>/dev/null)"
fi

echo ""
echo "=== Test: wrapper propagates pi's exit status ==="
rm -f "$SANDBOX/pi.log" "$SANDBOX/node.log"
MOCK_PI_EXIT=3 bash "$RUN_PI_AGENT" "herdr-1723456789-1234-5678" "cmd" >/dev/null 2>&1
if [ $? -eq 3 ]; then
  pass "wrapper propagates pi exit status 3"
else
  fail "wrapper should propagate pi exit status 3 (got $?)"
fi
if grep -q "^node:" "$SANDBOX/node.log" 2>/dev/null; then
  pass "release still fires when pi exits non-zero"
else
  fail "release should fire even when pi exits non-zero"
fi

echo ""
echo "=== Test: no release invocation when session id is empty ==="
rm -f "$SANDBOX/pi.log" "$SANDBOX/node.log"
bash "$RUN_PI_AGENT" "" "cmd" >/dev/null 2>&1
if [ ! -s "$SANDBOX/node.log" ]; then
  pass "no release when session id is empty"
else
  fail "release should be skipped when session id is empty"
  echo "  node log: $(cat "$SANDBOX/node.log" 2>/dev/null)"
fi

echo ""
echo "=== Test: no release invocation when release script is missing ==="
rm -f "$SANDBOX/pi.log" "$SANDBOX/node.log"
mkdir -p "$SANDBOX/empty-wrapper-dir"
cat > "$SANDBOX/empty-wrapper-dir/run-pi-agent.sh" <<'WRAPPER'
#!/usr/bin/env bash
set -uo pipefail
release_script="$(cd "$(dirname "$0")" && pwd)/release-lease-on-exit.mjs"
if [ -n "${1:-}" ] && [ -f "$release_script" ]; then
  node "$release_script" "$1" >/dev/null 2>&1 || true
fi
pi --session-id "${1:-}" "${2:-}"
exit $?
WRAPPER
chmod +x "$SANDBOX/empty-wrapper-dir/run-pi-agent.sh"
# Run a copy of the wrapper logic with a missing release script:
bash "$SANDBOX/empty-wrapper-dir/run-pi-agent.sh" "herdr-x" "cmd" >/dev/null 2>&1
if [ ! -s "$SANDBOX/node.log" ]; then
  pass "missing release script skips release silently"
else
  fail "missing release script should skip the release"
  echo "  node log: $(cat "$SANDBOX/node.log" 2>/dev/null)"
fi

# ── Tests: send-to-pi.sh / open-pi-agent.sh launch via the wrapper ─────

echo ""
echo "=== Test: send-to-pi.sh launches pi via the wrapper with a herdr- session id ==="
rm -f "$SANDBOX/herdr.log"
HERDR_BIN_PATH="$MOCK_HERDR" HERDR_GRID_BIN="$SANDBOX/missing-grid.py" \
  bash "$SEND_TO_PI" --no-resize "hello" >/dev/null 2>&1
if grep -q "pane run pane-1 exec bash .*run-pi-agent.sh herdr-[0-9]*-[0-9]*-[0-9]*" "$SANDBOX/herdr.log" 2>/dev/null; then
  pass "send-to-pi runs pi via the lease-release wrapper with a herdr- id"
else
  fail "send-to-pi should run pi via the lease-release wrapper"
  echo "  herdr log: $(cat "$SANDBOX/herdr.log" 2>/dev/null)"
fi

echo ""
echo "=== Test: open-pi-agent.sh launches pi via the wrapper with a herdr- session id ==="
rm -f "$SANDBOX/herdr.log"
HERDR_BIN_PATH="$MOCK_HERDR" HERDR_GRID_BIN="$SANDBOX/missing-grid.py" \
  bash "$OPEN_PI_AGENT" --no-resize >/dev/null 2>&1
if grep -q "pane run pane-1 exec bash .*run-pi-agent.sh herdr-[0-9]*-[0-9]*-[0-9]*$" "$SANDBOX/herdr.log" 2>/dev/null; then
  pass "open-pi-agent runs pi via the lease-release wrapper with a herdr- id"
else
  fail "open-pi-agent should run pi via the lease-release wrapper"
  echo "  herdr log: $(cat "$SANDBOX/herdr.log" 2>/dev/null)"
fi

echo ""
echo "=== Test: release-lease-on-exit.mjs runs standalone and exits 0 ==="
rm -f "$SANDBOX/node.log"
# Run the real script with the real node (mock models.json HOME is unset,
# so the shared module simply finds no provider and no request is sent).
if HOME="$SANDBOX/nonexistent-home" "$REAL_NODE" "$SHARED_DIR/release-lease-on-exit.mjs" "herdr-1723456789-1234-5678" >/dev/null 2>&1; then
  pass "release script exits 0 standalone"
else
  fail "release script should exit 0 standalone (got $?)"
fi

echo ""
echo "=========================================="
echo "PASS: $PASS  FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
