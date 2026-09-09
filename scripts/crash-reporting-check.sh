#!/usr/bin/env bash
# crash-reporting-check — verify apport/whoopsie/kdump and retention
#
# Checks:
#  apport:     enabled=1 in /etc/default/apport, core_pattern piped to apport, apport service enabled
#  whoopsie:   whoopsie.path enabled (path-activated upload daemon)
#  kdump:      USE_KDUMP=1, kexec_cmd present, kdump-tools service active, crash kernel present
#  retention:  /etc/cron.daily/apport exists and is executable (prunes >7d)
#  disk:       /var/crash usage and largest file vs thresholds
#
# Env overrides for testing (all optional):
#   APPORT_DEFAULT_FILE, CORE_PATTERN_FILE, WHOOPSIE_CONF,
#   KDUMP_DEFAULT_FILE, KEXEC_CMD_FILE, KDUMP_VMLINUZ,
#   CRASH_DIR, CRON_APPORT_FILE
#
# Usage:
#   scripts/crash-reporting-check.sh [--json] [--warn-size-mb N] [--warn-file-mb N] [--crash-dir PATH]
# Exit: 0 = OK/WARN, 2 = ALERT (apport broken)

set -uo pipefail

WARN_SIZE_MB=1024
WARN_FILE_MB=500
JSON_OUTPUT=0
CRASH_DIR_OVERRIDE=""

APPORT_DEFAULT_FILE="${APPORT_DEFAULT_FILE:-/etc/default/apport}"
CORE_PATTERN_FILE="${CORE_PATTERN_FILE:-/proc/sys/kernel/core_pattern}"
WHOOPSIE_CONF="${WHOOPSIE_CONF:-/etc/whoopsie}"
KDUMP_DEFAULT_FILE="${KDUMP_DEFAULT_FILE:-/etc/default/kdump-tools}"
KEXEC_CMD_FILE="${KEXEC_CMD_FILE:-/var/crash/kexec_cmd}"
KDUMP_VMLINUZ="${KDUMP_VMLINUZ:-/var/lib/kdump/vmlinuz}"
CRON_APPORT_FILE="${CRON_APPORT_FILE:-/etc/cron.daily/apport}"

usage() {
  cat <<'EOF'
Usage: crash-reporting-check.sh [options]

Verify crash reporting setup (apport, whoopsie, kdump, retention, disk).

Options:
  --json                Machine-readable JSON output
  --warn-size-mb N      WARN if /var/crash total exceeds N MB (default 1024)
  --warn-file-mb N      WARN if largest file in /var/crash exceeds N MB (default 500)
  --crash-dir PATH      Override crash directory (default /var/crash, or $CRASH_DIR)
  -h, --help            Show this help and exit

Env overrides (for testing):
  APPORT_DEFAULT_FILE, CORE_PATTERN_FILE, WHOOPSIE_CONF,
  KDUMP_DEFAULT_FILE, KEXEC_CMD_FILE, KDUMP_VMLINUZ,
  CRASH_DIR, CRON_APPORT_FILE

Exit codes: 0 = OK/WARN, 2 = ALERT (apport disabled/broken)
EOF
}

next_arg() {
  if [[ $# -lt 2 ]]; then echo "Error: $1 requires a value" >&2; exit 1; fi
  printf '%s' "$2"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_OUTPUT=1; shift ;;
    --warn-size-mb) WARN_SIZE_MB="$(next_arg "$@")"; shift 2 ;;
    --warn-file-mb) WARN_FILE_MB="$(next_arg "$@")"; shift 2 ;;
    --crash-dir) CRASH_DIR_OVERRIDE="$(next_arg "$@")"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ -n "$CRASH_DIR_OVERRIDE" ]]; then
  CRASH_DIR="$CRASH_DIR_OVERRIDE"
else
  CRASH_DIR="${CRASH_DIR:-/var/crash}"
fi

level="OK"
details=()

add_detail() {
  details+=("$1")
}

# ---------- apport ----------
apport_status="OK"
apport_msg="apport enabled"
apport_enabled_val=""
if [[ -f "$APPORT_DEFAULT_FILE" ]]; then
  apport_enabled_val="$(grep -E '^\s*enabled\s*=' "$APPORT_DEFAULT_FILE" 2>/dev/null | tail -n1 | sed -E 's/.*enabled\s*=\s*//;s/#.*//' | tr -d '[:space:]' || true)"
fi
if [[ "$apport_enabled_val" != "1" ]]; then
  apport_status="ALERT"
  apport_msg="apport disabled (enabled != 1 in $APPORT_DEFAULT_FILE)"
  level="ALERT"
fi

core_pattern=""
if [[ -f "$CORE_PATTERN_FILE" ]]; then
  core_pattern="$(cat "$CORE_PATTERN_FILE" 2>/dev/null | tr -d '\n' || true)"
fi
if [[ "$core_pattern" != *"apport"* ]]; then
  apport_status="ALERT"
  apport_msg="core_pattern not piped to apport: ${core_pattern:-<empty>}"
  level="ALERT"
fi

# systemctl is-enabled apport (mockable via PATH)
if command -v systemctl >/dev/null 2>&1; then
  if ! systemctl is-enabled apport >/dev/null 2>&1; then
    # If already ALERT, keep; otherwise WARN because generation still works via core_pattern
    if [[ "$apport_status" != "ALERT" ]]; then
      apport_status="WARN"
      apport_msg="apport service not enabled (systemctl is-enabled apport failed)"
      if [[ "$level" != "ALERT" ]]; then level="WARN"; fi
    fi
  fi
fi

# ---------- whoopsie ----------
whoopsie_status="OK"
whoopsie_msg="whoopsie.path enabled"
whoopsie_enabled="disabled"
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-enabled whoopsie.path >/dev/null 2>&1; then
    whoopsie_enabled="enabled"
  else
    whoopsie_status="WARN"
    whoopsie_msg="whoopsie.path disabled — crash reports not uploaded (run: sudo systemctl enable --now whoopsie.path)"
    if [[ "$level" == "OK" ]]; then level="WARN"; fi
  fi
else
  whoopsie_status="WARN"
  whoopsie_msg="systemctl not available — cannot check whoopsie.path"
  if [[ "$level" == "OK" ]]; then level="WARN"; fi
fi

# whoopsie binary present?
if ! command -v whoopsie >/dev/null 2>&1; then
  if [[ "$whoopsie_status" == "OK" ]]; then
    whoopsie_status="WARN"
    whoopsie_msg="whoopsie binary not found"
    if [[ "$level" == "OK" ]]; then level="WARN"; fi
  fi
fi

# ---------- kdump ----------
kdump_status="OK"
kdump_msg="kdump crash kernel loaded"
kdump_use=""
if [[ -f "$KDUMP_DEFAULT_FILE" ]]; then
  kdump_use="$(grep -E '^\s*USE_KDUMP\s*=' "$KDUMP_DEFAULT_FILE" 2>/dev/null | tail -n1 | sed -E 's/.*USE_KDUMP\s*=\s*//;s/#.*//' | tr -d '[:space:]' || true)"
fi
if [[ "$kdump_use" == "1" ]]; then
  # USE_KDUMP=1 — expect kexec_cmd and kdump-tools active
  if [[ ! -f "$KEXEC_CMD_FILE" ]]; then
    kdump_status="WARN"
    kdump_msg="USE_KDUMP=1 but $KEXEC_CMD_FILE missing — crash kernel not loaded"
    if [[ "$level" == "OK" ]]; then level="WARN"; fi
  elif [[ ! -e "$KDUMP_VMLINUZ" ]]; then
    kdump_status="WARN"
    kdump_msg="USE_KDUMP=1 but $KDUMP_VMLINUZ missing"
    if [[ "$level" == "OK" ]]; then level="WARN"; fi
  elif command -v systemctl >/dev/null 2>&1; then
    # Check kdump-tools.service is active/enabled; treat inactive as WARN
    if ! systemctl is-active kdump-tools.service >/dev/null 2>&1 && ! systemctl is-active kdump-tools >/dev/null 2>&1; then
      # Some systems use kdump-tools.service, some kdump.service — try both
      if ! systemctl status kdump-tools.service >/dev/null 2>&1; then
        kdump_status="WARN"
        kdump_msg="kdump-tools service not active"
        if [[ "$level" == "OK" ]]; then level="WARN"; fi
      fi
    fi
  fi
elif [[ "$kdump_use" == "0" ]]; then
  kdump_status="WARN"
  kdump_msg="USE_KDUMP=0 — kernel crash dumps disabled (intentional if documented)"
  if [[ "$level" == "OK" ]]; then level="WARN"; fi
else
  kdump_status="WARN"
  kdump_msg="KDUMP_DEFAULT_FILE not found or USE_KDUMP unset"
  if [[ "$level" == "OK" ]]; then level="WARN"; fi
fi

# ---------- retention ----------
retention_status="OK"
retention_msg="retention cron /etc/cron.daily/apport present (prunes >7d)"
if [[ ! -x "$CRON_APPORT_FILE" ]]; then
  if [[ ! -f "$CRON_APPORT_FILE" ]]; then
    retention_status="WARN"
    retention_msg="retention cron $CRON_APPORT_FILE missing — crash files may accumulate"
    if [[ "$level" == "OK" ]]; then level="WARN"; fi
  else
    retention_status="WARN"
    retention_msg="retention cron $CRON_APPORT_FILE not executable"
    if [[ "$level" == "OK" ]]; then level="WARN"; fi
  fi
fi

# ---------- disk ----------
disk_status="OK"
disk_msg="/var/crash within thresholds"
crash_total_kb=0
crash_total_mb=0
largest_file=""
largest_kb=0
largest_mb=0
if [[ -d "$CRASH_DIR" ]]; then
  crash_total_kb="$(du -sk "$CRASH_DIR" 2>/dev/null | awk '{print $1; exit}' 2>/dev/null || true)"
  crash_total_kb="$(printf '%s' "$crash_total_kb" | tr -d '[:space:]')"
  crash_total_kb="${crash_total_kb:-0}"
  if ! [[ "$crash_total_kb" =~ ^[0-9]+$ ]]; then crash_total_kb=0; fi
  crash_total_mb=$(( (crash_total_kb + 1023) / 1024 ))
  # largest file
  largest_info="$(find "$CRASH_DIR" -type f -printf '%s %p\n' 2>/dev/null | sort -n | tail -n1 || true)"
  if [[ -n "$largest_info" ]]; then
    largest_bytes="$(printf '%s' "$largest_info" | awk '{print $1}')"
    largest_bytes="$(printf '%s' "$largest_bytes" | tr -d '[:space:]')"
    if [[ "$largest_bytes" =~ ^[0-9]+$ ]]; then
      largest_kb=$(( (largest_bytes + 1023) / 1024 ))
    else
      largest_kb=0
    fi
    largest_file="$(printf '%s' "$largest_info" | awk '{ $1=""; sub(/^ /,""); print }')"
    largest_mb=$(( (largest_kb + 1023) / 1024 ))
  fi
  if (( crash_total_mb > WARN_SIZE_MB )); then
    disk_status="WARN"
    disk_msg="/var/crash ${crash_total_mb} MB exceeds warn threshold ${WARN_SIZE_MB} MB"
    if [[ "$level" == "OK" ]]; then level="WARN"; fi
  elif (( largest_mb > WARN_FILE_MB )); then
    disk_status="WARN"
    disk_msg="largest file ${largest_mb} MB ($largest_file) exceeds ${WARN_FILE_MB} MB"
    if [[ "$level" == "OK" ]]; then level="WARN"; fi
  fi
else
  disk_status="WARN"
  disk_msg="$CRASH_DIR does not exist"
  if [[ "$level" == "OK" ]]; then level="WARN"; fi
fi

# ---------- output ----------
if (( JSON_OUTPUT )); then
  # Escape for JSON
  json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g'
  }
  apport_e="$(json_escape "$apport_msg")"
  whoopsie_e="$(json_escape "$whoopsie_msg")"
  kdump_e="$(json_escape "$kdump_msg")"
  retention_e="$(json_escape "$retention_msg")"
  disk_e="$(json_escape "$disk_msg")"
  core_e="$(json_escape "$core_pattern")"
  cat <<JSON
{"level":"$level","apport":{"status":"$apport_status","message":"$apport_e","enabled":"$apport_enabled_val","core_pattern":"$core_e"},"whoopsie":{"status":"$whoopsie_status","message":"$whoopsie_e","path_enabled":"$whoopsie_enabled"},"kdump":{"status":"$kdump_status","message":"$kdump_e","use_kdump":"$kdump_use","kexec_cmd":"$KEXEC_CMD_FILE"},"retention":{"status":"$retention_status","message":"$retention_e","cron":"$CRON_APPORT_FILE"},"disk":{"status":"$disk_status","message":"$disk_e","crash_dir":"$CRASH_DIR","total_mb":$crash_total_mb,"largest_mb":$largest_mb,"largest_file":"$(json_escape "$largest_file")","warn_size_mb":$WARN_SIZE_MB,"warn_file_mb":$WARN_FILE_MB}}
JSON
else
  echo "crash-reporting-check: $level"
  echo "  apport:    $apport_status — $apport_msg"
  echo "  whoopsie:  $whoopsie_status — $whoopsie_msg"
  echo "  kdump:     $kdump_status — $kdump_msg"
  echo "  retention: $retention_status — $retention_msg"
  echo "  disk:      $disk_status — $disk_msg ($CRASH_DIR: ${crash_total_mb} MB total, largest ${largest_mb} MB)"
  if [[ "$level" == "WARN" ]]; then
    echo "Hint: sudo systemctl enable --now whoopsie.path  # to enable upload daemon"
    echo "      rm $CRASH_DIR/_usr_bin_node.*.crash         # to purge large old dump (or wait for cron >7d)"
  fi
fi

if [[ "$level" == "ALERT" ]]; then
  exit 2
else
  exit 0
fi
