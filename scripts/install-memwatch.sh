#!/usr/bin/env bash
# install-memwatch.sh — deploy memwatch memory monitoring as a cron job
#
# Installs the monitoring script to a root-owned location (default
# /usr/local/sbin/memwatch) and writes /etc/cron.d/memwatch to invoke it
# every minute as root.
#
# Copying the script to a root-owned path is deliberate: the cron job runs as
# root, so the executed script must not be modifiable by a non-root user. A
# cron job pointing at a script inside a user-writable checkout would be a
# privilege-escalation vector.
#
# Usage:
#   sudo scripts/install-memwatch.sh                       # defaults
#   sudo scripts/install-memwatch.sh --warning 8192 --critical 4096
#   scripts/install-memwatch.sh --dry-run                  # preview only
#   sudo scripts/install-memwatch.sh --uninstall
#
# Environment overrides:
#   MEMWATCH_SCRIPT_PATH   Source script (default: <installer dir>/memwatch.sh)
#   MEMWATCH_INSTALL_PATH  Root-owned target (default: /usr/local/sbin/memwatch)
#   MEMWATCH_STATE_FILE    State file for dedup (default: /run/memwatch-state)
#
# Work Item: WL-0MT1KJNGA006EEHU
# Date: 2026-09-25

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MEMWATCH_SCRIPT="${MEMWATCH_SCRIPT_PATH:-$SCRIPT_DIR/memwatch.sh}"
INSTALL_PATH="${MEMWATCH_INSTALL_PATH:-/usr/local/sbin/memwatch}"
CRON_FILE="/etc/cron.d/memwatch"
DRY_RUN=0
UNINSTALL=0
WARNING_MB=""
CRITICAL_MB=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)   DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --warning)   WARNING_MB="$2"; shift 2 ;;
    --critical)  CRITICAL_MB="$2"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
Usage: install-memwatch.sh [--dry-run] [--uninstall] [--warning MB] [--critical MB]

Install (or remove) memwatch memory monitoring as a root cron job.

Options:
  --dry-run     Show what would be installed without making changes
  --uninstall   Remove the cron job and installed script
  --warning MB  Warning threshold in MB (default: script default, 4096)
  --critical MB Critical threshold in MB (default: script default, 2048)
  -h, --help    Show this help
EOF
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if (( DRY_RUN == 0 )) && (( EUID != 0 )); then
  echo "Error: this script must be run as root (or via sudo)" >&2
  exit 1
fi

MEMWATCH_SCRIPT_ABS="$(cd "$(dirname "$MEMWATCH_SCRIPT")" && pwd)/$(basename "$MEMWATCH_SCRIPT")"

if (( UNINSTALL )); then
  echo "Removing memwatch..."
  rm -f "$CRON_FILE"
  rm -f "$INSTALL_PATH"
  echo "✓ Removed $CRON_FILE and $INSTALL_PATH"
  exit 0
fi

if [[ ! -f "$MEMWATCH_SCRIPT" ]]; then
  echo "Error: memwatch.sh not found at $MEMWATCH_SCRIPT" >&2
  exit 1
fi

# Build the optional threshold overrides for the cron line. When unset, the
# script's own defaults (documented at the top of memwatch.sh) apply.
THRESHOLD_ENV=""
if [[ -n "$WARNING_MB" ]]; then
  THRESHOLD_ENV+="MEMWATCH_WARNING_MB=$WARNING_MB "
fi
if [[ -n "$CRITICAL_MB" ]]; then
  THRESHOLD_ENV+="MEMWATCH_CRITICAL_MB=$CRITICAL_MB "
fi

CRON_CONTENT="# memwatch - memory pressure monitoring and alerting
# Installed by scripts/install-memwatch.sh (Work Item: WL-0MT1KJNGA006EEHU)
#
# Checks /proc/meminfo MemAvailable every minute and logs a MEMWATCH: line to
# journald when the pressure level changes. See docs/dev/memory-monitoring.md.

SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

* * * * * root ${THRESHOLD_ENV}${INSTALL_PATH}
"

echo "=== memwatch installer ==="
echo "Source:   $MEMWATCH_SCRIPT_ABS"
echo "Install:  $INSTALL_PATH (root:root 0755)"
echo "Cron:     $CRON_FILE"
echo "Warning:  ${WARNING_MB:-<script default>} MB"
echo "Critical: ${CRITICAL_MB:-<script default>} MB"
echo ""

if (( DRY_RUN )); then
  echo "--- Dry run: would copy script and write $CRON_FILE: ---"
  echo ""
  printf '%s' "$CRON_CONTENT"
  echo ""
  echo "--- No changes made. ---"
  exit 0
fi

# Install the script owned by root so a non-root user cannot alter what root
# cron executes.
install -o root -g root -m 0755 "$MEMWATCH_SCRIPT" "$INSTALL_PATH"
echo "✓ Installed $INSTALL_PATH"

# Install the cron file.
printf '%s' "$CRON_CONTENT" > "$CRON_FILE"
chown root:root "$CRON_FILE"
chmod 0644 "$CRON_FILE"
echo "✓ Installed $CRON_FILE"

if systemctl is-active --quiet cron 2>/dev/null || systemctl is-active --quiet anacron 2>/dev/null; then
  echo "✓ cron/anacron is active"
else
  echo "⚠ Warning: cron/anacron does not appear to be running"
  echo "  Start it with: sudo systemctl start cron"
fi

echo ""
echo "Verify (no journald write):"
echo "  $INSTALL_PATH --dry-run"
echo ""
echo "Verify end-to-end (writes one journald line):"
echo "  logger -p user.warning \"MEMWATCH: \$(date '+%F %T') available=0MB level=SELFTEST\""
echo "  journalctl -t MEMWATCH --since '1 minute ago' | tail -1"
echo ""
echo "Historical memory trends (sysstat):"
echo "  sar -r"
