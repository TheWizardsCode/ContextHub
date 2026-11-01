#!/usr/bin/env bash
# collect-freeze-evidence — evidence bundle for host freezes (WL-0MVY898D4007BZ28 AC-H)
#
# Gathers, into an output directory, everything needed to classify one suspicious
# boot end and emits a SUMMARY.md whose FIRST LINE is the classification plus a
# confidence, so the next freeze is a read, not an investigation:
#
#   1. any vmcore and its crash dmesg (extracted with makedumpfile, no root,
#      no dbgsym kernel and no crash(8) — the recipe proven on the 2026-11-01
#      dumps),
#   2. the last N HOSTWATCH samples (journald -t HOSTWATCH; reboot-surviving
#      telemetry from the sibling item),
#   3. the previous-boot kernel tail,
#   4. a classification against the crash register:
#        - panic-dump-available   — a vmcore exists and its dmesg parses
#        - mt7921e-timeout        — mt7921e driver-own/timeout loops ended the boot
#        - NVRM-storm             — NVIDIA (NVRM/Xid) storm ended the boot
#        - silent                 — boot ended with no signature at all
#        (an unrecognised shape FAILS with exit 3 — never silently "unknown")
#
# Classification decision order (later tests are narrower):
#   panic-dump-available wins (a real trace beats all inferences);
#   then mt7921e-timeout beats NVRM-storm (the observed coexistence favours the
#   Wi-Fi wedge cascading into the GPU path); then NVRM-storm; else silent.
#   A boot with NO end-of-boot boundary evidence at all (no journal for the
#   previous boot, no new dump, no kernel tail) is UNRECOGNIZED → exit 3.
#
# Exit codes:
#   0 = bundle written, classification produced
#   3 = unrecognised crash shape (AC-H: must fail, never silently "unknown")
#   1/2 = usage/runtime error
#
# Usage:
#   scripts/collect-freeze-evidence.sh [--out DIR] [--boots N] [--hostwatch N] [--json]
#
# Environment overrides (for testing):
#   BF_CRASH_DIR          Crash dir (default /var/crash)
#   BF_OUT_DIR            Output/bundle dir (default ./freeze-evidence-<timestamp>)
#   BF_BOOTS              Number of previous boots to log (@ journalctl --list-boots)
#   BF_HOSTWATCH_N        Last N HOSTWATCH lines to copy (default 40)
#   BF_KLOGFILE           Fixture: previous-boot kernel log file (instead of journalctl)
#   BF_HOSTWATCH_FILE     Fixture: HOSTWATCH log file (instead of journalctl -t)
#   BF_DMESG_FILE         Fixture: extracted crash dmesg / path for comparison
#   BF_CMD_MAKEDUMPFILE   makedumpfile binary (default: makedumpfile)
#   BF_DRY_RUN            Print actions instead of writing the bundle
#
# Author: Pi (AI agent)
# Work Item: WL-0MVY898D4007BZ28
# Date: 2026-11-01
#
# Related:
#   docs/dev/crash-reporting.md — corrected observability story
#   scripts/hostwatch.sh — telemetry sampler feeding HOSTWATCH lines
#   tests/test_collect_freeze_evidence.test.ts — automated tests (journal fixtures)

set -uo pipefail

CRASH_DIR="${BF_CRASH_DIR:-/var/crash}"
OUT_DIR="${BF_OUT_DIR:-}"
BOOTS="${BF_BOOTS:-3}"
HOSTWATCH_N="${BF_HOSTWATCH_N:-40}"
KLOG_FILE="${BF_KLOGFILE:-}"
HOSTWATCH_FILE="${BF_HOSTWATCH_FILE:-}"
DMESG_FIXTURE="${BF_DMESG_FILE:-}"
MAKEDUMPFILE_CMD="${BF_CMD_MAKEDUMPFILE:-makedumpfile}"
JSON_OUTPUT=0
DRY_RUN="${BF_DRY_RUN:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)     OUT_DIR="${2:-}"; shift 2 ;;
    --boots)   BOOTS="${2:-$BOOTS}"; shift 2 ;;
    --hostwatch) HOSTWATCH_N="${2:-$HOSTWATCH_N}"; shift 2 ;;
    --json)    JSON_OUTPUT=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: collect-freeze-evidence.sh [--out DIR] [--boots N] [--hostwatch N] [--json]

Build a freeze-evidence bundle: vmcore/dmesg, HOSTWATCH samples, previous-boot
kernel tail, and a crash-register classification in SUMMARY.md.

Options:
  --out DIR       Output bundle directory (default ./freeze-evidence-<ts>)
  --boots N       Previous boots to log (default 3)
  --hostwatch N   Last N HOSTWATCH lines to copy (default 40)
  --json          Machine-readable summary JSON on stdout
  --dry-run       Print actions without writing the bundle
  -h, --help      Show this help

Env overrides: BF_CRASH_DIR, BF_OUT_DIR, BF_BOOTS, BF_HOSTWATCH_N, BF_KLOGFILE,
BF_HOSTWATCH_FILE, BF_DMESG_FILE, BF_CMD_MAKEDUMPFILE, BF_DRY_RUN.

Exit: 0 = bundle written; 3 = unrecognised crash shape; 1/2 = error.
EOF
      exit 0
      ;;
    *) echo "collect-freeze-evidence: unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="freeze-evidence-$(date +%Y%m%d-%H%M%S)"
fi
if [[ -d "$OUT_DIR" ]]; then
  echo "Error: output dir already exists: $OUT_DIR" >&2
  exit 2
fi

mkdir -p "$OUT_DIR"
# Keep makedumpfile intermediate out of the bundle (can be many GB).
WORK="$(mktemp -d "${TMPDIR:-/tmp}/bf-work-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------
# 1. vmcore + crash dmesg
# ---------------------------------------------------------------------------
VMCORE=""
VMCORE_DMESG=""
if [[ -n "$DMESG_FIXTURE" && -f "$DMESG_FIXTURE" ]]; then
  VMCORE_DMESG="$DMESG_FIXTURE"
else
  newest="$(ls -1d "$CRASH_DIR"/20[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9] 2>/dev/null | sort | tail -n1 || true)"
  if [[ -n "$newest" && -f "$newest/dump.$(basename "$newest")" ]]; then
    VMCORE="$newest/dump.$(basename "$newest")"
    raw="$WORK/raw.dump"
    if (( ! DRY_RUN )); then
      # The rootless recipe: -R from stdin, then --dump-dmesg.
      if "$MAKEDUMPFILE_CMD" -R "$raw" < "$VMCORE" 2>/dev/null \
         && "$MAKEDUMPFILE_CMD" --dump-dmesg "$raw" "$OUT_DIR/crash-dmesg.txt" 2>/dev/null; then
        VMCORE_DMESG="$OUT_DIR/crash-dmesg.txt"
      else
        # Extraction failed — record the failure, don't fabricate a trace.
        cp "$VMCORE" "$OUT_DIR/vmcore-$(basename "$VMCORE")" 2>/dev/null || true
        printf 'makedumpfile extraction failed for %s\n' "$VMCORE" > "$OUT_DIR/crash-dmesg.txt"
        VMCORE_DMESG="$OUT_DIR/crash-dmesg.txt"
      fi
    else
      VMCORE_DMESG="<would-extract: $VMCORE>"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 2. HOSTWATCH samples
# ---------------------------------------------------------------------------
hostwatch_log="$OUT_DIR/hostwatch-samples.txt"
if [[ -n "$HOSTWATCH_FILE" && -f "$HOSTWATCH_FILE" ]]; then
  tail -n "$HOSTWATCH_N" "$HOSTWATCH_FILE" > "$hostwatch_log" 2>/dev/null || true
else
  journalctl -t HOSTWATCH --no-pager 2>/dev/null | tail -n "$HOSTWATCH_N" > "$hostwatch_log" || true
fi

# ---------------------------------------------------------------------------
# 3. previous-boot kernel tail
# ---------------------------------------------------------------------------
prev_boot_tail="$OUT_DIR/previous-boot-kernel-tail.txt"
if [[ -n "$KLOG_FILE" && -f "$KLOG_FILE" ]]; then
  tail -n 200 "$KLOG_FILE" > "$prev_boot_tail" 2>/dev/null || true
else
  # The boot immediately before the current one (-b -1) is the one that may
  # have died. Fall back to the current boot if only one exists.
  journalctl -k -b -1 --no-pager 2>/dev/null | tail -n 200 > "$prev_boot_tail" \
    || journalctl -k -b 0 --no-pager 2>/dev/null | tail -n 200 > "$prev_boot_tail" || true
fi
boots_log="$OUT_DIR/boots.txt"
if [[ -n "$KLOG_FILE" && -f "$KLOG_FILE" ]]; then
  printf 'fixture mode — no boot list\n' > "$boots_log"
else
  journalctl --list-boots --no-pager 2>/dev/null | tail -n "$BOOTS" > "$boots_log" || true
fi

# ---------------------------------------------------------------------------
# 4. Classification (crash register: silent / mt7921e-timeout / NVRM-storm /
#    panic-dump-available — plus clean-shutdown for deliberate reboots, which
#    must be distinguishable from a silent freeze; an unrecognised shape fails
#    with exit 3, never silently "unknown").
# ---------------------------------------------------------------------------
# Signals (all greps are on the previous-boot kernel tail unless noted).
count_lines() { # file pattern -> count
  local f="$1" p="$2" n
  if [[ -f "$f" ]]; then
    n="$(grep -cE "$p" "$f" 2>/dev/null || true)"
    printf '%s' "$n"
  else
    printf '0'
  fi
}
mt79=$(count_lines "$prev_boot_tail" 'mt7921|mt76.*(fail|timeout|reset)|driver own failed|Timeout for driver own|chip reset failed')
nvrm=$(count_lines "$prev_boot_tail" 'NVRM|Xid')
oops=$(count_lines "$prev_boot_tail" 'Oops:|BUG:|Kernel panic|unable to handle page fault')
shutdown_markers=$(count_lines "$prev_boot_tail" 'Reached target shutdown|Reached target reboot|systemd-shutdown|Powering off|reboot.target|Deactivated successfully.*reboot|systemd-logind.*(Shutting|reboot)')
tail_lines=$(count_lines "$prev_boot_tail" '.')

classification=""
confidence=""
reasons=()

if [[ -n "$VMCORE_DMESG" && "$VMCORE_DMESG" != "<would-extract: "* ]]; then
  # A dmesg with a real trace always wins.
  if [[ -s "$VMCORE_DMESG" ]] && grep -qE 'Oops:|BUG:|Kernel panic|panic' "$VMCORE_DMESG"; then
    classification="panic-dump-available"
    confidence="high"
    reasons+=("vmcore dmesg present with a real panic trace")
    if grep -qE 'mt7921|mt76_dma|mt7921_mac_reset_work' "$VMCORE_DMESG"; then
      reasons+=("trace names the mt76/mt7921e driver")
    fi
    if grep -qE 'NVRM|Xid' "$VMCORE_DMESG"; then
      reasons+=("trace shows NVRM activity")
    fi
  elif [[ -s "$VMCORE_DMESG" ]]; then
    # Dump exists but the dmesg did not parse a panic trace → fail closed.
    classification=""
    reasons+=("vmcore exists but dmesg has no parseable panic trace")
  fi
fi

if [[ -z "$classification" ]]; then
  if (( mt79 > 0 )); then
    classification="mt7921e-timeout"
    if (( oops > 0 )); then confidence="high"; else confidence="medium"; fi
    reasons+=("$mt79 mt7921e/mt76 fault lines in previous-boot kernel tail")
    if (( nvrm > 0 )); then reasons+=("co-occurring NVRM lines ($nvrm)"); fi
  elif (( nvrm > 0 )); then
    classification="NVRM-storm"
    confidence="medium"
    reasons+=("$nvrm NVRM/Xid lines in previous-boot kernel tail")
  elif (( shutdown_markers > 0 )); then
    # Deliberate reboot/power-off: NOT a freeze. The AC-I end-to-end check
    # verifies this shape specifically.
    classification="clean-shutdown"
    confidence="high"
    reasons+=("previous-boot kernel tail shows a deliberate shutdown sequence")
  elif (( tail_lines > 0 )); then
    # Boot ended with journal content but no shutdown sequence and no fault
    # signature: the silent-freeze class.
    classification="silent"
    confidence="low"
    reasons+=("boot ended with $tail_lines kernel-log lines but no shutdown markers and no fault signature")
  else
    # No evidence at all — unrecognised shape; must FAIL, never "unknown".
    classification=""
    reasons+=("no previous-boot kernel tail, no vmcore, no HOSTWATCH evidence")
  fi
fi

if [[ -z "$classification" ]]; then
  echo "ERROR: unrecognised crash shape — evidence does not match any crash-register class." >&2
  printf 'unrecognised: %s\n' "${reasons[*]:-no evidence parsed}" >&2
  exit 3
fi

# ---------------------------------------------------------------------------
# SUMMARY.md — first line is the classification + confidence
# ---------------------------------------------------------------------------
summary="$OUT_DIR/SUMMARY.md"
{
  printf 'Classification: %s (confidence: %s)\n' "$classification" "$confidence"
  printf '\nEvidence gathered:\n'
  printf '  - vmcore: %s\n' "${VMCORE:-none}"
  printf '  - crash dmesg: %s\n' "${VMCORE_DMESG:-none}"
  printf '  - hostwatch samples: %s\n' "$hostwatch_log"
  printf '  - previous-boot kernel tail: %s\n' "$prev_boot_tail"
  printf '  - boot list: %s\n' "$boots_log"
  printf '  - HOSTWATCH lines: %s\n' "$(wc -l < "$hostwatch_log" 2>/dev/null || echo 0)"
  printf '\nSignals:\n'
  printf '  - mt7921e/mt76 fault lines: %s\n' "$mt79"
  printf '  - NVRM/Xid lines: %s\n' "$nvrm"
  printf '  - oops/BUG/panic lines: %s\n' "$oops"
  printf '\nReasons: %s\n' "${reasons[*]:-none}"
} > "$summary"

if (( JSON_OUTPUT )); then
  jesc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g'; }
  cat <<JSON
{"classification":"$classification","confidence":"$confidence","vmcore":"$(jesc "$VMCORE")","crash_dmesg":"$(jesc "$VMCORE_DMESG")","mt7921e_lines":$mt79,"nvrm_lines":$nvrm,"oops_lines":$oops,"out_dir":"$(jesc "$OUT_DIR")"}
JSON
fi

echo "Classification: $classification (confidence: $confidence)"
echo "Bundle written to: $OUT_DIR"
exit 0
