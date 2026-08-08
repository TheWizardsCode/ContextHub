#!/usr/bin/env bash
# test_open_podcast_editor_tab.sh — tests for open-podcast-editor-tab.sh
#
# Covers the parse-and-rename wiring with a mock herdr CLI:
#   - happy path: pane opened, tab_id parsed from the pane-open JSON,
#     tab renamed to "Podcast Editing"
#   - herdr CLI unavailable → clear error, non-zero exit
#   - unparseable tab_id → clear error, non-zero exit, rename never called
#   - `plugin pane open` failure → clear error, non-zero exit
#
# Run from the repo root (or anywhere):
#   bash packages/herdr/scripts/tests/test_open_podcast_editor_tab.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPEN_PODCAST_EDITOR="$SCRIPT_DIR/open-podcast-editor-tab.sh"
PASS=0
FAIL=0

pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# Temporary sandbox for mocks and logs
SANDBOX="$(mktemp -d)"
HERDR_LOG="$SANDBOX/herdr-log.txt"
trap 'rm -rf "$SANDBOX"' EXIT

# ── Mock herdr CLI ─────────────────────────────────────────────────────
# Records every invocation in $HERDR_LOG and answers the subcommands the
# script needs: pane current (CWD resolution), pane process-info (plugin
# CWD probe), plugin pane open (returns a created tab_id), tab rename.
MOCK_HERDR="$SANDBOX/mock-herdr"
cat > "$MOCK_HERDR" <<MOCK
#!/usr/bin/env bash
echo "herdr:\$*" >> "$HERDR_LOG"
case "\$1" in
  pane)
    case "\$2" in
      current)
        echo '{"id":"cli:pane:current","result":{"pane":{"pane_id":"anchor-pane-9","cwd":"/mock/project"}},"type":"pane_info"}'
        ;;
      process-info)
        # No shell_pid → script falls back to the pane cwd
        echo '{"id":"cli:pane:process-info","result":{"process_info":{"shell_pid":""}},"type":"process_info"}'
        ;;
      *)
        echo "mock: unknown pane subcommand \$2" >&2
        exit 1
        ;;
    esac
    ;;
  plugin)
    if [ "\$2" = "pane" ] && [ "\$3" = "open" ]; then
      echo '{"id":"cli:plugin","result":{"plugin_pane":{"pane":{"tab_id":"w9:tPE","pane_id":"w9:p1","label":"Work Items"},"plugin_id":"worklog-selection-list"},"type":"plugin_pane_opened"}}'
      exit 0
    fi
    echo "mock: unknown plugin command" >&2
    exit 1
    ;;
  tab)
    if [ "\$2" = "rename" ]; then
      echo "mock: renamed tab \$3 to \$4"
      exit 0
    fi
    echo "mock: unknown tab subcommand \$2" >&2
    exit 1
    ;;
  *)
    echo "mock: unknown command \$1" >&2
    exit 1
    ;;
esac
MOCK
chmod +x "$MOCK_HERDR"

# Mock variants for failure paths
MOCK_HERDR_BAD_JSON="$SANDBOX/mock-herdr-bad-json"
cat > "$MOCK_HERDR_BAD_JSON" <<MOCK
#!/usr/bin/env bash
echo "herdr:\$*" >> "$HERDR_LOG"
case "\$1" in
  pane)
    case "\$2" in
      current) echo '{"result":{"pane":{"pane_id":"p1","cwd":"/mock"}}}' ;;
      *) exit 1 ;;
    esac
    ;;
  plugin)
    echo "not json at all"
    exit 0
    ;;
  *) exit 1 ;;
esac
MOCK
chmod +x "$MOCK_HERDR_BAD_JSON"

MOCK_HERDR_OPEN_FAILS="$SANDBOX/mock-herdr-open-fails"
cat > "$MOCK_HERDR_OPEN_FAILS" <<MOCK
#!/usr/bin/env bash
echo "herdr:\$*" >> "$HERDR_LOG"
case "\$1" in
  pane)
    case "\$2" in
      current) echo '{"result":{"pane":{"pane_id":"p1","cwd":"/mock"}}}' ;;
      *) exit 1 ;;
    esac
    ;;
  plugin)
    echo "plugin pane open failed: server unreachable" >&2
    exit 1
    ;;
  *) exit 1 ;;
esac
MOCK
chmod +x "$MOCK_HERDR_OPEN_FAILS"

# ── Helper: run the script with a mock and capture output ──────────────

run_script() {
  rm -f "$HERDR_LOG"
  HERDR_BIN_PATH="$1" bash "$OPEN_PODCAST_EDITOR" 2>&1
}

echo "=== Test: script exists and is executable ==="
[ -f "$OPEN_PODCAST_EDITOR" ] && pass "open-podcast-editor-tab.sh exists" || fail "open-podcast-editor-tab.sh missing"
[ -x "$OPEN_PODCAST_EDITOR" ] && pass "open-podcast-editor-tab.sh executable" || fail "open-podcast-editor-tab.sh not executable"

echo ""
echo "=== Test: happy path — opens pane, parses tab_id, renames tab ==="
out="$(run_script "$MOCK_HERDR")"
RC=$?

if [ "$RC" -eq 0 ]; then
  pass "script exits 0"
else
  fail "script should exit 0, got $RC"
fi

if grep -q 'plugin pane open --plugin worklog-selection-list --entrypoint worklist --placement tab' "$HERDR_LOG" 2>/dev/null; then
  pass "worklist pane opened in a tab"
else
  fail "worklist pane open command missing from mock log"
  echo "  log: $(cat "$HERDR_LOG" 2>/dev/null)"
fi

if grep -q 'tab rename w9:tPE Podcast Editing' "$HERDR_LOG" 2>/dev/null; then
  pass "tab renamed to 'Podcast Editing' with the parsed tab_id"
else
  fail "tab rename command missing or wrong (expected 'tab rename w9:tPE Podcast Editing')"
  echo "  log: $(cat "$HERDR_LOG" 2>/dev/null)"
fi

if echo "$out" | grep -q 'Opened podcast editing tab'; then
  pass "success message printed"
else
  fail "success message missing"
fi

echo ""
echo "=== Test: herdr CLI unavailable → clear error, non-zero exit ==="
out="$(run_script "$SANDBOX/no-such-herdr")"
RC=$?

if [ "$RC" -ne 0 ]; then
  pass "exits non-zero when herdr CLI is unavailable"
else
  fail "should exit non-zero when herdr CLI is unavailable"
fi

if echo "$out" | grep -qi "herdr CLI not found"; then
  pass "clear 'herdr CLI not found' error printed"
else
  fail "missing clear error message"
  echo "  output: $out"
fi

echo ""
echo "=== Test: unparseable tab_id → clear error, non-zero exit, no rename ==="
rm -f "$HERDR_LOG"
out="$(HERDR_BIN_PATH="$MOCK_HERDR_BAD_JSON" bash "$OPEN_PODCAST_EDITOR" 2>&1)"
RC=$?

if [ "$RC" -ne 0 ]; then
  pass "exits non-zero when tab_id cannot be parsed"
else
  fail "should exit non-zero when tab_id cannot be parsed"
fi

if echo "$out" | grep -qi "could not parse tab_id"; then
  pass "clear 'could not parse tab_id' error printed"
else
  fail "missing parse error message"
  echo "  output: $out"
fi

if grep -q 'tab rename' "$HERDR_LOG" 2>/dev/null; then
  fail "rename must not be called when tab_id cannot be parsed"
else
  pass "rename never called when tab_id cannot be parsed"
fi

echo ""
echo "=== Test: plugin pane open failure → clear error, non-zero exit ==="
out="$(run_script "$MOCK_HERDR_OPEN_FAILS")"
RC=$?

if [ "$RC" -ne 0 ]; then
  pass "exits non-zero when plugin pane open fails"
else
  fail "should exit non-zero when plugin pane open fails"
fi

if echo "$out" | grep -qi "plugin pane open.*failed"; then
  pass "clear open-failure error printed"
else
  fail "missing open-failure error message"
  echo "  output: $out"
fi

echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed"
echo "========================================"
[ "$FAIL" -eq 0 ]
