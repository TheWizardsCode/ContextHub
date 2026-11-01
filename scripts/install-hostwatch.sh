#!/usr/bin/env bash
# install-hostwatch.sh — deploy hostwatch telemetry sampler as a systemd timer
#
# Installs the sampler script to a root-owned location (default
# /usr/local/sbin/hostwatch) and writes a systemd timer pair that invokes it
# every 10 seconds as root.
#
# Copying the script to a root-owned path is deliberate: the timer runs as
# root, so the executed script must not be modifiable by a non-root user. A
# timer pointing at a script inside a user-writable checkout would be a
# privilege-escalation vector (same rationale as scripts/install-memwatch.sh).
#
# Timer cadence: 10 s (OnActiveSec=10s) — AC-G requires a timer-driven (≤10 s)
# oneshot. The sampler is read-only sysfs/procfs access plus one kernel-log
# tail scan; at 10 s it costs negligible CPU but guarantees a fresh HOSTWATCH
# line within 10 s of any fault (the journald `info`/`warning` per-sample log
# is the only output).
#
# Usage:
#   sudo scripts/install-hostwatch.sh                  # install + start
#   scripts/install-hostwatch.sh --dry-run             # preview only
#   sudo scripts/install-hostwatch.sh --uninstall
#
# Environment overrides:
#   HOSTWATCH_SCRIPT_PATH  Source script (default: <installer dir>/hostwatch.sh)
#   HOSTWATCH_INSTALL_PATH Root-owned target (default: /usr/local/sbin/hostwatch)
#
# Work Item: WL-0MVY898D4007BZ28
# Date: 2026-11-01

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOSTWATCH_SCRIPT="${HOSTWATCH_SCRIPT_PATH:-$SCRIPT_DIR/hostwatch.sh}"
INSTALL_PATH="${HOSTWATCH_INSTALL_PATH:-/usr/local/sbin/hostwatch}"
SERVICE_FILE="/etc/systemd/system/hostwatch.service"
TIMER_FILE="/etc/systemd/system/hostwatch.timer"
DRY_RUN=0
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)   DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: install-hostwatch.sh [--dry-run] [--uninstall]

Install (or remove) the hostwatch telemetry sampler as a root systemd timer.

Options:
  --dry-run     Show what would be installed without making changes
  --uninstall   Remove the timer, service and installed script
  -h, --help    Show this help

Environment: HOSTWATCH_SCRIPT_PATH, HOSTWATCH_INSTALL_PATH.
EOF
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -f "$HOSTWATCH_SCRIPT" ]]; then
  echo "Error: source script not found: $HOSTWATCH_SCRIPT" >&2
  exit 1
fi

if (( DRY_RUN )); then
  echo "Would install:"
  echo "  $HOSTWATCH_SCRIPT -> $INSTALL_PATH"
  echo "  $SERVICE_FILE"
  echo "  $TIMER_FILE  (OnActiveSec=10s)"
  echo "  systemctl daemon-reload && systemctl enable --now hostwatch.timer"
  exit 0
fi

if (( UNINSTALL )); then
  rm -f "$SERVICE_FILE" "$TIMER_FILE"
  systemctl daemon-reload 2>/dev/null || true
  rm -f "$INSTALL_PATH"
  echo "Removed hostwatch timer + service + $INSTALL_PATH"
  exit 0
fi

# Root-owned copy (privilege-escalation guard, same as install-memwatch.sh).
install -m 0755 "$HOSTWATCH_SCRIPT" "$INSTALL_PATH"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Host telemetry sampler (HOSTWATCH journald lines)
After=systemd-journald.service

[Service]
Type=oneshot
ExecStart=$INSTALL_PATH
EOF

cat > "$TIMER_FILE" <<EOF
[Unit]
Description=Run hostwatch telemetry sampler every 10 seconds

[Timer]
OnActiveSec=10s
OnUnitActiveSec=10s
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now hostwatch.timer

echo "Installed. Verify:"
echo "  journalctl -t HOSTWATCH -n 5 --no-pager"
echo "  systemctl status hostwatch.timer"
