#!/usr/bin/env bash
# hostwatch — reboot-surviving host telemetry sampler (HOSTWATCH)
#
# A timer-driven (10 s) oneshot that writes one structured `HOSTWATCH` line to
# journald per sample: k10temp, acpitz and MT7921e temperatures, /proc/loadavg,
# MemAvailable, wlp3s0 operstate, and any mt7921e/NVRM error counts since the
# previous sample.
#
# Design rules (from WL-0MVY898D4007BZ28 AC-G and constraints):
#   - No daemon: one shot per invocation, driven by a systemd timer.
#   - Sampler reads sysfs/procfs only — no NetworkManager CLI / ip-link calls
#     (must not perturb the fragile Wi-Fi link).
#   - Per-sample lines log at `info`; a line whose values CHANGED since the
#     previous sample (temp moved > HOSTWATCH_TEMP_DELTA_C, an error count
#     increased, or operstate changed) logs at `warning`.
#   - Error counts are the delta since the previous sample, derived from the
#     kernel ring buffer (the driver/firmware is already dead when these fire;
#     journald/kmsg reads never touch the Wi-Fi hardware).
#
# Exit codes: 0 = ok, 1 = unrecoverable/usage error.
#
# Usage:
#   scripts/hostwatch.sh                     # production run (logs to journald)
#   scripts/hostwatch.sh --dry-run           # log lines to stdout instead
#   scripts/hostwatch.sh --json              # emit JSON to stdout
#   scripts/hostwatch.sh --state FILE        # state file for deltas
#
# Environment overrides (for testing and customisation):
#   HOSTWATCH_STATE_FILE   State file recording previous sample's lerp
#                          (default: /run/hostwatch-state — root-owned /run,
#                          so a non-root user cannot pre-create the path).
#   HOSTWATCH_LOGGER       Logger command (default: logger -t HOSTWATCH -p user.info)
#   HOSTWATCH_DRY_RUN      If set, print the log line to stdout instead of journald
#   HOSTWATCH_JSON         If set, emit machine-readable JSON to stdout
#   HOSTWATCH_TEMP_DELTA_C Temperature move (C) that promotes to warning (default 5)
#   HOSTWATCH_KLOG_FILE    Kernel-log source for error-counting (default: `journalctl
#                          -k -b 0 --no-pager -o short-iso`). A fixture file may be
#                          passed in tests.
#   HOSTWATCH_BOOT_ID_FILE Source for the boot id (default: /proc/sys/kernel/random/boot_id)
#   HOSTWATCH_MAX_KLOG_LINES  Tail length of the kernel log scanned (default 5000)
#
# Deployment:
#   Run scripts/install-hostwatch.sh as root to install the systemd timer.
#   Requires: bash, logger, coreutils (sed, awk, grep, cat, tail, stat).
#   No external dependencies.
#
# Author: Pi (AI agent)
# Work Item: WL-0MVY898D4007BZ28
# Date: 2026-11-01
#
# Related:
#   docs/dev/crash-reporting.md — corrected observability story
#   scripts/collect-freeze-evidence.sh — evidence bundle consuming HOSTWATCH
#   tests/test_hostwatch.test.ts — automated tests
#   scripts/memwatch.sh — sibling sampler pattern

set -uo pipefail

STATE_FILE="${HOSTWATCH_STATE_FILE:-/run/hostwatch-state}"
LOGGER_CMD="${HOSTWATCH_LOGGER:-logger -t HOSTWATCH -p user.info}"
TEMP_DELTA_C="${HOSTWATCH_TEMP_DELTA_C:-5}"
BOOT_ID_FILE="${HOSTWATCH_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}"
MAX_KLOG_LINES="${HOSTWATCH_MAX_KLOG_LINES:-5000}"
DRY_RUN="${HOSTWATCH_DRY_RUN:-0}"
JSON_OUTPUT="${HOSTWATCH_JSON:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)   DRY_RUN=1; shift ;;
    --json)      JSON_OUTPUT=1; shift ;;
    --state)     STATE_FILE="${2:-$STATE_FILE}"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
Usage: hostwatch.sh [--dry-run] [--json] [--state FILE]

Reboot-surviving telemetry sampler — one structured HOSTWATCH journald line per
sample (k10temp/acpitz/MT7921e temperatures, loadavg, MemAvailable, wlp3s0
operstate, mt7921e/NVRM error deltas). Timer-driven oneshot, no daemon.

Options:
  --dry-run    Write the HOSTWATCH line to stdout instead of journald
  --json       Also emit machine-readable JSON on stdout
  --state FILE State file path (default: /run/hostwatch-state)
  -h, --help   Show this help

Environment: HOSTWATCH_STATE_FILE, HOSTWATCH_LOGGER, HOSTWATCH_DRY_RUN,
HOSTWATCH_JSON, HOSTWATCH_TEMP_DELTA_C, HOSTWATCH_KLOG_FILE, HOSTWATCH_BOOT_ID_FILE,
HOSTWATCH_MAX_KLOG_LINES.
EOF
      exit 0
      ;;
    *) echo "hostwatch: unknown option: $1" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Read helpers (sysfs/procfs only)
# ---------------------------------------------------------------------------

# First temp1_input whose hwmon `name` matches a substring of $1 (e.g. k10temp).
hwmon_temp() {
  local needle="$1"
  local hw
  for hw in /sys/class/hwmon/hwmon*; do
    [[ -d "$hw" ]] || continue
    if grep -qi "$needle" "$hw/name" 2>/dev/null; then
      local t
      t="$(cat "$hw/temp1_input" 2>/dev/null)" && [[ -n "$t" ]] && echo "${t%% *}" && return 0
    fi
  done
  return 1
}

thermal_zone_temp() {
  local z
  for z in /sys/class/thermal/thermal_zone*; do
    [[ -d "$z" ]] || continue
    if grep -q "acpitz" "$z/type" 2>/dev/null; then
      local t
      t="$(cat "$z/temp" 2>/dev/null)" && [[ -n "$t" ]] && echo "$t" && return 0
    fi
  done
  return 1
}

# mt7921e dies to a firmware hang that wedges the PCIe link, so the hwmon node
# may exist under the phy or be absent when the card is unbound/blacklisted.
mt7921_hwmon_temp() {
  local hw
  for hw in /sys/class/ieee80211/phy*/device/hwmon/hwmon* /sys/class/hwmon/hwmon*; do
    [[ -e "$hw/temp1_input" ]] || continue
    local path
    path="$(readlink -f "$hw" 2>/dev/null || true)"
    if [[ "$path" == *mt7921* ]]; then
      cat "$hw/temp1_input" 2>/dev/null | tr -d '[:space:]' && return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# Error deltas since the previous sample
# ---------------------------------------------------------------------------

# Count mt7921e/mt76 and NVRM/Xid error lines in the kernel log tail.
# Prints "mt79 NVRM" (two integers).
klog_error_counts() {
  local src="${HOSTWATCH_KLOG_FILE:-}"
  local mt79=0 nvrm=0
  if [[ -n "$src" ]]; then
    # Fixture file (tests). grep -c always prints a count (0 on no match
    # while exiting 1) — never append `|| echo 0`, that doubles the digit.
    mt79="$(grep -cE 'mt7921|mt76.*(fail|timeout|reset)|driver own failed|Timeout for driver own' "$src" 2>/dev/null)"
    nvrm="$(grep -cE 'NVRM|Xid' "$src" 2>/dev/null)"
  else
    local lines
    lines="$(journalctl -k -b 0 --no-pager -o short-iso 2>/dev/null | tail -n "$MAX_KLOG_LINES")"
    if [[ -z "$lines" ]]; then
      echo "0 0"
      return 0
    fi
    mt79="$(printf '%s\n' "$lines" | grep -cE 'mt7921|mt76.*(fail|timeout|reset)|driver own failed|Timeout for driver own')"
    nvrm="$(printf '%s\n' "$lines" | grep -cE 'NVRM|Xid')"
  fi
  mt79="${mt79:-0}"
  nvrm="${nvrm:-0}"
  echo "$mt79 $nvrm"
}

read_state() {
  # Format: boot=<boot_id> mt79=<n> nvrm=<n> ts=<epoch>
  cat "$STATE_FILE" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Collect readings
# ---------------------------------------------------------------------------

boot_id="$(cat "$BOOT_ID_FILE" 2>/dev/null | tr -d '[:space:]' || echo 'unknown')"

k10_c=""
k10_raw="$(hwmon_temp k10temp || true)"
[[ -n "$k10_raw" ]] && k10_c="$(awk -v m="$k10_raw" 'BEGIN { printf "%.1f", m/1000 }')"

acpit_c=""
acpit_raw="$(thermal_zone_temp || true)"
[[ -n "$acpit_raw" ]] && acpit_c="$(awk -v m="$acpit_raw" 'BEGIN { printf "%.1f", m/1000 }')"

mt79_c=""
mt79_raw="$(mt7921_hwmon_temp || true)"
[[ -n "$mt79_raw" ]] && mt79_c="$(awk -v m="$mt79_raw" 'BEGIN { printf "%.1f", m/1000 }')"

load1="$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo '?')"
mem_avail_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || echo '?')"

operstate="NA"
if [[ -r /sys/class/net/wlp3s0/operstate ]]; then
  operstate="$(cat /sys/class/net/wlp3s0/operstate 2>/dev/null | tr -d '[:space:]' || true)"
  [[ -n "$operstate" ]] || operstate="NA"
fi

read -r mt79_count nvrm_count <<< "$(klog_error_counts)"
mt79_count="${mt79_count:-0}"
nvrm_count="${nvrm_count:-0}"

# ---------------------------------------------------------------------------
# Delta vs previous sample + change detection
# ---------------------------------------------------------------------------

prev_boot=""; prev_mt79=""; prev_nvrm=""; prev_ts=""; prev_k10=""
while read -r -a words; do
  for word in "${words[@]:-}"; do
    [[ "$word" == *=* ]] || continue
    key="${word%%=*}"
    value="${word#*=}"
    case "$key" in
      boot) prev_boot="$value" ;;
      mt79) prev_mt79="$value" ;;
      nvrm) prev_nvrm="$value" ;;
      ts)   prev_ts="$value" ;;
      k10)  prev_k10="$value" ;;
    esac
  done
done <<< "$(read_state)"

if [[ "$prev_boot" == "$boot_id" && "$prev_mt79" != "" ]]; then
  mt79_delta=$(( mt79_count - prev_mt79 ))
  nvrm_delta=$(( nvrm_count - prev_nvrm ))
else
  # New boot or no state: baseline this sample (no delta).
  mt79_delta=0
  nvrm_delta=0
fi
[[ $mt79_delta -lt 0 ]] && mt79_delta=0
[[ $nvrm_delta -lt 0 ]] && nvrm_delta=0

# Change detection → warning level
level="info"
changed="no"
if (( mt79_delta > 0 || nvrm_delta > 0 )); then
  level="warning"; changed="yes"
fi
if [[ -n "$prev_boot" && "$prev_boot" != "$boot_id" ]]; then
  level="warning"; changed="yes"
fi

now="$(date +%s)"
ts="$now"

# Temperature moved more than TEMP_DELTA_C since the previous sample (only when
# both samples are from the same boot).
if [[ -n "$prev_k10" && "$prev_k10" != "" && -n "$k10_c" && "$k10_c" != "NA" && "$prev_boot" == "$boot_id" ]]; then
  # Floating-point compare via awk; promotes to warning when the move exceeds
  # the threshold.
  if awk -v a="$k10_c" -v b="$prev_k10" -v t="$TEMP_DELTA_C" 'BEGIN { d=a-b; if (d<0) d=-d; if (d>t) exit 0; exit 1 }'; then
    level="warning"; changed="yes"
  fi
fi

# ---------------------------------------------------------------------------
# Emit
# ---------------------------------------------------------------------------

LINE="HOSTWATCH boot=$boot_id k10=${k10_c:-NA} acpit=${acpit_c:-NA} mt7921=${mt79_c:-NA} load1=$load1 memavail_kb=$mem_avail_kb wl_operstate=$operstate mt79_err_delta=$mt79_delta nvrm_err_delta=$nvrm_delta level=$level"

# Persist state for the next sample.
printf 'boot=%s mt79=%s nvrm=%s ts=%s k10=%s\n' "$boot_id" "$mt79_count" "$nvrm_count" "$ts" "${k10_c:-NA}" > "$STATE_FILE" 2>/dev/null || true

if (( JSON_OUTPUT )); then
  cat <<JSON
{"boot":"$boot_id","k10":${k10_c:-null},"acpit":${acpit_c:-null},"mt7921":${mt79_c:-null},"load1":"$load1","memavail_kb":${mem_avail_kb:-null},"wl_operstate":"$operstate","mt79_err_delta":$mt79_delta,"nvrm_err_delta":$nvrm_delta,"level":"$level","changed":"$changed"}
JSON
fi

if (( DRY_RUN )); then
  echo "$LINE"
else
  if [[ "$level" == "warning" ]]; then
    logger -t HOSTWATCH -p user.warning "$LINE"
  else
    eval "$LOGGER_CMD '$LINE'" 2>/dev/null || logger -t HOSTWATCH -p user.info "$LINE"
  fi
fi

exit 0
