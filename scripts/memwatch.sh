#!/usr/bin/env bash
# memwatch — memory pressure monitoring and alerting
#
# Checks /proc/meminfo MemAvailable every minute via cron. Writes a single
# structured log line to journald whenever the memory-pressure level changes
# from the previous interval, preventing log flooding during sustained
# pressure.
#
# Thresholds (absolute MB values, configurable):
#   WARNING_THRESHOLD_MB    4096    (~17% of 24 GB)  → user.warning
#   CRITICAL_THRESHOLD_MB   2048    (~8% of 24 GB)   → user.warning (higher urgency)
#
# Exit codes:
#   0 = OK    (above warning threshold)
#   1 = WARN  (below warning, above critical)
#   2 = CRIT  (below critical)
#
# Usage:
#   scripts/memwatch.sh                     # production run
#   scripts/memwatch.sh --dry-run           # log to stdout instead of journald
#   scripts/memwatch.sh --json              # machine-readable output
#
# Environment overrides (for testing and customisation):
#   MEMWATCH_MEMINFO          Path to MemAvailable source (default: /proc/meminfo)
#   MEMWATCH_STATE_FILE       Path for dedup state (default: /run/memwatch-state)
#                             /run is root-owned, so a non-root user cannot
#                             pre-create the path (avoids /tmp symlink attacks).
#   MEMWATCH_WARNING_MB       Warning threshold in MB (default: 4096)
#   MEMWATCH_CRITICAL_MB      Critical threshold in MB (default: 2048)
#   MEMWATCH_LOG_PREFIX       Log prefix (default: MEMWATCH)
#   MEMWATCH_LOGGER           Logger command (default: logger -t MEMWATCH -p user.warning)
#   MEMWATCH_DRY_RUN          If set, log to stdout instead of journald
#   MEMWATCH_JSON             If set, emit JSON to stdout
#
# Deployment:
#   Run scripts/install-memwatch.sh as root to install /etc/cron.d/memwatch.
#   Requires: bash, cron (or anacron), logger, coreutils (grep, awk, date)
#   No external dependencies.
#
# Author: Map (AI agent)
# Work Item: WL-0MT1KJNGA006EEHU
# Date: 2026-09-25
#
# Related:
#   docs/dev/memory-monitoring.md — full documentation and runbook
#   tests/memwatch.test.ts — automated tests

set -uo pipefail

# ---------------------------------------------------------------------------
# Configurable thresholds
# ---------------------------------------------------------------------------
MEMINFO_FILE="${MEMWATCH_MEMINFO:-/proc/meminfo}"
STATE_FILE="${MEMWATCH_STATE_FILE:-/run/memwatch-state}"
WARNING_THRESHOLD_MB="${MEMWATCH_WARNING_MB:-4096}"
CRITICAL_THRESHOLD_MB="${MEMWATCH_CRITICAL_MB:-2048}"
LOG_PREFIX="${MEMWATCH_LOG_PREFIX:-MEMWATCH}"
# -t sets the syslog tag so `journalctl -t MEMWATCH` finds these lines.
LOGGER_CMD="${MEMWATCH_LOGGER:-logger -t \"$LOG_PREFIX\" -p user.warning}"

# ---------------------------------------------------------------------------
# Parse command-line flags
# ---------------------------------------------------------------------------
DRY_RUN=0
JSON_OUTPUT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)   DRY_RUN=1; shift ;;
    --json)      JSON_OUTPUT=1; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: memwatch.sh [options]

Memory pressure monitoring — checks MemAvailable and logs alerts when
thresholds are breached. One log line per interval (deduplicates).

Options:
  --dry-run    Write to stdout instead of journald
  --json       Emit machine-readable JSON to stdout
  -h, --help   Show this help and exit

Exit codes: 0 = OK, 1 = WARN, 2 = CRIT
EOF
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
now() { date '+%Y-%m-%d %H:%M:%S'; }

# Read MemAvailable in kB from the source file.
read_mem_available_kb() {
  grep -E '^MemAvailable:' "$MEMINFO_FILE" 2>/dev/null | awk '{print $2}' || true
}

# Read total RAM in kB from the source file.
read_total_ram_kb() {
  grep -E '^MemTotal:' "$MEMINFO_FILE" 2>/dev/null | awk '{print $2}' || true
}

# Convert kB to MB (integer, rounded down).
kb_to_mb() {
  echo $(( $1 / 1024 ))
}

# Determine the current pressure level.
# Returns: OK, WARN, or CRIT.
get_level() {
  local avail_kb="$1"
  local avail_mb
  avail_mb=$(kb_to_mb "$avail_kb")

  if (( avail_mb < CRITICAL_THRESHOLD_MB )); then
    echo "CRIT"
  elif (( avail_mb < WARNING_THRESHOLD_MB )); then
    echo "WARN"
  else
    echo "OK"
  fi
}

# Read the previous pressure level from the state file (if it exists).
# A symlink is refused: the cron job runs as root, and following an
# attacker-planted symlink could redirect the read to an unintended file.
read_prev_level() {
  if [[ -L "$STATE_FILE" ]]; then
    return 0
  fi
  if [[ -f "$STATE_FILE" ]]; then
    tr -d '[:space:]' < "$STATE_FILE" 2>/dev/null || true
  fi
}

# Write a log line. Handles journald, dry-run, and JSON output.
emit_log() {
  local level="$1" avail_mb="$2" total_mb="$3" pct="$4"
  local msg

  msg="${LOG_PREFIX}: $(now) available=${avail_mb}MB / total=${total_mb}MB (${pct}%) level=${level}"

  if (( JSON_OUTPUT )); then
    printf '{"level":"%s","available_mb":%d,"total_mb":%d,"percent":%d,"message":"%s"}\n' \
      "$level" "$avail_mb" "$total_mb" "$pct" "$msg"
  elif (( DRY_RUN )); then
    echo "$msg"
  else
    echo "$msg" | eval "$LOGGER_CMD"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

# Read MemAvailable
avail_kb=$(read_mem_available_kb)

# Validate we got a number
if [[ -z "$avail_kb" ]] || ! [[ "$avail_kb" =~ ^[0-9]+$ ]]; then
  emit_log "ERR" 0 0 0
  echo "MEMWATCH: $(now) ERROR: could not read MemAvailable from $MEMINFO_FILE" >&2
  exit 2
fi

# Read total RAM
total_kb=$(read_total_ram_kb)
if [[ -z "$total_kb" ]] || ! [[ "$total_kb" =~ ^[0-9]+$ ]]; then
  total_kb="$avail_kb"  # fallback: use available as total (100%)
fi

total_mb=$(kb_to_mb "$total_kb")
avail_mb=$(kb_to_mb "$avail_kb")
pct=$(( avail_mb * 100 / (total_mb > 0 ? total_mb : 1) ))

# Determine current level
level=$(get_level "$avail_kb")

# Previous level from the state file (empty on first run or if unreadable).
prev_level=$(read_prev_level)

# Only emit a log line if the level has changed from the previous interval.
# This prevents alert fatigue from sustained pressure — one alert per
# level change, not one per minute.
if [[ "$level" != "$prev_level" ]]; then
  emit_log "$level" "$avail_mb" "$total_mb" "$pct"
fi

# Update state file atomically. mktemp uses O_CREAT|O_EXCL with a random
# name, so a predictable-path symlink attack cannot redirect the write; mv
# then replaces any existing state file (including a stale symlink) safely.
state_dir=$(dirname "$STATE_FILE")
if [[ ! -d "$state_dir" ]]; then
  mkdir -p "$state_dir" 2>/dev/null || true
fi
tmp_file=$(mktemp "${STATE_FILE}.tmp.XXXXXX" 2>/dev/null) || tmp_file=""
if [[ -n "$tmp_file" ]]; then
  printf '%s\n' "$level" > "$tmp_file"
  mv -f "$tmp_file" "$STATE_FILE" 2>/dev/null || rm -f "$tmp_file"
fi

# Exit with the appropriate code.
case "$level" in
  OK)   exit 0 ;;
  WARN) exit 1 ;;
  CRIT) exit 2 ;;
  ERR)  exit 2 ;;
  *)    exit 1 ;;
esac
