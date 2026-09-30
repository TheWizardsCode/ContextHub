#!/usr/bin/env bash
# install-audit-log-hygiene.sh — idempotent cron installer for the audit-debug
# retention sweep (WL-0MUJRQOIT000N34K, parent WL-0MUJL0PTS009MC8F).
#
# Installs exactly one managed crontab entry that runs
# scripts/prune_audit_debug_logs.py --apply daily and keeps its own log bounded.
#
# Actions
#   (default)      install the managed entry (idempotent)
#   --remove       remove the managed entry, preserving unrelated entries
#   --rotate-log   rotate ~/.audit_debug/hygiene-cron.log when over the cap
#   --dry-run      print the intended change and write nothing
#   -h, --help     show this help
#
# Environment overrides (primarily a test seam for the crontab command)
#   CRONTAB                 crontab command to use (default: crontab)
#   HOME                    user home (log location; crontab subject)
#   HYGIENE_CRON_SCHEDULE   cron schedule (default: "17 3 * * *")
#   HYGIENE_LOG_FILE        hygiene log path (default: $HOME/.audit_debug/hygiene-cron.log)
#   HYGIENE_LOG_MAX_BYTES   log cap in bytes before rotation (default: 5242880)
#   PYTHON                  python interpreter for the sweep (default: python3)
#
# The managed entry is tagged with a stable marker comment so install/remove
# are idempotent and never touch unrelated crontab lines.
#
# Policy and runbook: docs/dev/audit-debug-log-retention.md
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$SCRIPT_DIR/install-audit-log-hygiene.sh"
SWEEP_SCRIPT="$SCRIPT_DIR/prune_audit_debug_logs.py"

CRONTAB_CMD="${CRONTAB:-crontab}"
PYTHON_BIN="${PYTHON:-python3}"
SCHEDULE="${HYGIENE_CRON_SCHEDULE:-17 3 * * *}"
LOG_FILE="${HYGIENE_LOG_FILE:-$HOME/.audit_debug/hygiene-cron.log}"
LOG_MAX_BYTES="${HYGIENE_LOG_MAX_BYTES:-5242880}"

MARKER="# managed by install-audit-log-hygiene.sh (worklog audit debug retention)"

# Daily sweep + rotate the hygiene log once it exceeds the cap. The rotation
# runs even if the sweep fails (`;`), so the log cannot run away.
CRON_CMD="cd '$SCRIPT_DIR/..' && '$PYTHON_BIN' '$SWEEP_SCRIPT' --apply --log-file '$LOG_FILE' ; '$SELF' --rotate-log >/dev/null 2>&1"
CRON_LINE="$SCHEDULE $CRON_CMD"

ACTION="install"
DRY_RUN=0

usage() {
    cat <<'EOF'
install-audit-log-hygiene.sh — idempotent cron installer for the audit-debug
retention sweep.

Usage: install-audit-log-hygiene.sh [--remove | --rotate-log] [--dry-run]

  (default)      install the managed daily sweep entry (idempotent)
  --remove       remove the managed entry, preserving unrelated entries
  --rotate-log   rotate the hygiene log when it exceeds the cap
  --dry-run      print the intended change and write nothing
  -h, --help     show this help

Environment overrides: CRONTAB, HOME, HYGIENE_CRON_SCHEDULE,
HYGIENE_LOG_FILE, HYGIENE_LOG_MAX_BYTES, PYTHON.
EOF
}

read_crontab() {
    "$CRONTAB_CMD" -l 2>/dev/null || true
}

write_crontab() {
    local content="$1"
    if [ -n "$content" ]; then
        printf '%s\n' "$content" | "$CRONTAB_CMD" -
    else
        printf '' | "$CRONTAB_CMD" -
    fi
}

# Drop the marker line and the command line that immediately follows it.
strip_managed() {
    awk -v marker="$MARKER" '
        $0 == marker { skip = 1; next }
        skip { skip = 0; next }
        { print }
    ' <<<"$1"
}

managed_block() {
    printf '%s\n%s' "$MARKER" "$CRON_LINE"
}

do_install() {
    local current clean desired
    current="$(read_crontab)"
    clean="$(strip_managed "$current")"
    if [ -n "$clean" ]; then
        desired="$(printf '%s\n%s' "$clean" "$(managed_block)")"
    else
        desired="$(managed_block)"
    fi

    if [ -n "$current" ] && [ "$desired" = "$current" ]; then
        echo "already installed: managed audit-log hygiene cron entry is present."
        return 0
    fi

    if [ "$DRY_RUN" -eq 1 ]; then
        echo "[dry-run] would install managed crontab entry:"
        echo "  $CRON_LINE"
        return 0
    fi

    mkdir -p "$(dirname "$LOG_FILE")"
    write_crontab "$desired"
    echo "installed managed audit-log hygiene cron entry:"
    echo "  $CRON_LINE"
}

do_remove() {
    local current desired
    current="$(read_crontab)"
    if ! grep -qF -- "$MARKER" <<<"$current"; then
        echo "not installed: no managed audit-log hygiene cron entry found."
        return 0
    fi

    if [ "$DRY_RUN" -eq 1 ]; then
        echo "[dry-run] would remove managed audit-log hygiene cron entry."
        return 0
    fi

    desired="$(strip_managed "$current")"
    write_crontab "$desired"
    echo "removed managed audit-log hygiene cron entry."
}

do_rotate() {
    local size
    if [ ! -f "$LOG_FILE" ]; then
        echo "nothing to rotate: $LOG_FILE does not exist."
        return 0
    fi
    size="$(wc -c <"$LOG_FILE" | tr -d ' ')"
    if [ "$size" -le "$LOG_MAX_BYTES" ]; then
        echo "no rotation: $LOG_FILE is $size bytes (cap $LOG_MAX_BYTES)."
        return 0
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "[dry-run] would rotate $LOG_FILE ($size bytes > cap $LOG_MAX_BYTES)."
        return 0
    fi
    mv -f "$LOG_FILE" "$LOG_FILE.1"
    : >"$LOG_FILE"
    echo "rotated $LOG_FILE ($size bytes > cap $LOG_MAX_BYTES) to $LOG_FILE.1"
}

for arg in "$@"; do
    case "$arg" in
        --remove) ACTION="remove" ;;
        --rotate-log) ACTION="rotate" ;;
        --dry-run) DRY_RUN=1 ;;
        -h | --help)
            usage
            exit 0
            ;;
        *)
            echo "error: unknown argument: $arg" >&2
            echo "try --help" >&2
            exit 2
            ;;
    esac
done

case "$ACTION" in
    install) do_install ;;
    remove) do_remove ;;
    rotate) do_rotate ;;
    *)
        echo "error: unknown action: $ACTION" >&2
        exit 2
        ;;
esac
