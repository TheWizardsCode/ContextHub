#!/usr/bin/env bash
# wl-process-healthcheck — detect wl process accumulation
#
# Lightweight, dependency-free watchdog that counts concurrent node
# `wl`/`worklog` CLI processes and alerts when the count exceeds a threshold
# for a sustained number of consecutive checks. Designed to run from cron /
# systemd timer every 5 minutes.
#
# Levels (see docs/dev/wl-process-spawning-investigation.md §6.2):
#   OK     count < watch-threshold (default 20)             → exit 0
#   WATCH  watch <= count <= alert-threshold, or count      → exit 0
#          above the alert threshold but not yet sustained
#   ALERT  count > alert-threshold (default 50) for N       → exit 2
#          consecutive checks (N defaults to 3)
#
# The current count is written to --count-file (default
# /tmp/wl-healthcheck-count) on OK and WATCH levels. On ALERT the process
# tree is emitted to stderr and the exit code is 2.
#
# Usage:
#   wl-process-healthcheck.sh [options]
#
# Options:
#   --alert-threshold N   Alert above N concurrent wl processes (default 50)
#   --watch-threshold N   Watch at N concurrent wl processes (default 20)
#   --sustained N         Require N consecutive high readings (default 3)
#   --count-file PATH     File receiving the current count (default /tmp/wl-healthcheck-count)
#   --ticks-file PATH     File tracking consecutive high readings (default /tmp/wl-healthcheck-ticks)
#   --json                Emit machine-readable JSON to stdout
#   -h, --help            Show this help and exit
#
# Exit codes: 0 = OK/WATCH, 2 = ALERT (sustained high count).

set -uo pipefail

ALERT_THRESHOLD=50
WATCH_THRESHOLD=20
SUSTAINED_TICKS=3
COUNT_FILE=/tmp/wl-healthcheck-count
TICKS_FILE=/tmp/wl-healthcheck-ticks
JSON_OUTPUT=0
SELF_SCRIPT="$(basename "$0")"

usage() {
  cat <<'EOF'
Usage: wl-process-healthcheck.sh [options]

Detect wl process accumulation. Counts concurrent node `wl`/`worklog` CLI
processes and alerts when the count exceeds a threshold for a sustained
number of consecutive checks.

Options:
  --alert-threshold N   Alert above N concurrent wl processes (default 50)
  --watch-threshold N   Watch at N concurrent wl processes (default 20)
  --sustained N         Require N consecutive high readings (default 3)
  --count-file PATH     File receiving the current count (default /tmp/wl-healthcheck-count)
  --ticks-file PATH     File tracking consecutive high readings (default /tmp/wl-healthcheck-ticks)
  --json                Emit machine-readable JSON to stdout
  -h, --help            Show this help and exit

Exit codes: 0 = OK/WATCH, 2 = ALERT (sustained high count)
EOF
}

# Print the next positional arg after a flag, validating presence.
next_arg() {
  if [[ $# -lt 2 ]]; then
    echo "Error: $1 requires a value" >&2
    exit 1
  fi
  printf '%s' "$2"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --alert-threshold) ALERT_THRESHOLD="$(next_arg "$@")"; shift 2 ;;
    --watch-threshold) WATCH_THRESHOLD="$(next_arg "$@")"; shift 2 ;;
    --sustained) SUSTAINED_TICKS="$(next_arg "$@")"; shift 2 ;;
    --count-file) COUNT_FILE="$(next_arg "$@")"; shift 2 ;;
    --ticks-file) TICKS_FILE="$(next_arg "$@")"; shift 2 ;;
    --json) JSON_OUTPUT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Atomically write a small file (avoids torn reads when cron runs overlap).
write_atomic() {
  local file="$1" value="$2"
  local tmp="${file}.tmp.$$"
  printf '%s\n' "$value" > "$tmp"
  mv "$tmp" "$file"
}

# Count concurrent node wl/worklog CLI processes (ps-based, no external deps).
# Pattern matches:
#   node /usr/local/bin/wl list --json          (bin symlink)
#   node /usr/local/bin/worklog sync            (bin)
#   node .../node_modules/worklog/dist/cli.js   (direct node invocation)
count=$(
  ps -eo args \
    | grep -E '^node .*/(wl|worklog)([ /]|$)' \
    | grep -v grep \
    | grep -v "$SELF_SCRIPT" \
    | wc -l
) || true
count=$(printf '%s' "$count" | tr -d ' ')
count=${count:-0}

level=OK
ticks=0

if (( count > ALERT_THRESHOLD )); then
  ticks=$(cat "$TICKS_FILE" 2>/dev/null || echo 0)
  ticks=$((ticks + 1))
  write_atomic "$TICKS_FILE" "$ticks"
  if (( ticks >= SUSTAINED_TICKS )); then
    level=ALERT
  else
    level=WATCH
  fi
elif (( count >= WATCH_THRESHOLD )); then
  level=WATCH
  rm -f "$TICKS_FILE"
else
  level=OK
  rm -f "$TICKS_FILE"
fi

if [[ "$level" == "ALERT" ]]; then
  {
    echo "[ALERT] $count wl processes sustained for $SUSTAINED_TICKS checks (threshold: $ALERT_THRESHOLD)"
    echo "PID PPID ELAPSED COMMAND"
    ps -eo pid,ppid,etime,args | grep -E 'node .*/(wl|worklog)([ /]|$)' | grep -v grep || true
  } >&2
  rm -f "$TICKS_FILE"
  if (( JSON_OUTPUT )); then
    printf '{"level":"ALERT","count":%d,"watch_threshold":%d,"alert_threshold":%d,"sustained":%d,"ticks":%d,"count_file":"%s","ticks_file":"%s","message":"[ALERT] %d wl processes sustained for %d checks"}\n' \
      "$count" "$WATCH_THRESHOLD" "$ALERT_THRESHOLD" "$SUSTAINED_TICKS" "$ticks" "$COUNT_FILE" "$TICKS_FILE" "$count" "$SUSTAINED_TICKS"
  fi
  exit 2
fi

write_atomic "$COUNT_FILE" "$count"

if (( count > ALERT_THRESHOLD )); then
  remaining=$((SUSTAINED_TICKS - ticks))
  msg="WATCH: $count wl processes (alert after $remaining more check(s), threshold: $ALERT_THRESHOLD)"
elif (( count >= WATCH_THRESHOLD )); then
  msg="WATCH: $count wl processes (watch threshold: $WATCH_THRESHOLD, alert above $ALERT_THRESHOLD)"
else
  msg="OK: $count wl processes"
fi

if (( JSON_OUTPUT )); then
  printf '{"level":"%s","count":%d,"watch_threshold":%d,"alert_threshold":%d,"sustained":%d,"ticks":%d,"count_file":"%s","ticks_file":"%s","message":"%s"}\n' \
    "$level" "$count" "$WATCH_THRESHOLD" "$ALERT_THRESHOLD" "$SUSTAINED_TICKS" "$ticks" "$COUNT_FILE" "$TICKS_FILE" "$msg"
else
  echo "wl-process-healthcheck: $msg"
fi
exit 0
