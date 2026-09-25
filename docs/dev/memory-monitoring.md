# Memory Pressure Monitoring & Alerting

**Work Item:** WL-0MT1KJNGA006EEHU — Set up memory pressure monitoring and alerting
**Date:** 2026-09-25
**Status:** Installed and verified

---

## 1. Summary

| Component | Mechanism | Status |
|-----------|-----------|--------|
| Live memory pressure check | `scripts/memwatch.sh` via `/etc/cron.d/memwatch` (every minute) | ✅ Installed |
| Alert delivery | journald via `logger -p user.warning` (prefix `MEMWATCH:`) | ✅ Verified |
| Historical memory trend data | sysstat `sar -r` (10-minute interval, 7-day retention) | ✅ Active |
| Log-noise control | State-file deduplication (one alert per level change) | ✅ Verified |

**Why:** During the 2026-08-20 system hang, the kernel logged *"Under memory
pressure, flushing caches"* 10+ times between 13:27 and 13:40 with no alert and
no early warning. The system had run for 21 days with accumulating memory
pressure and no monitoring to catch it before it became unresponsive.

**What is monitored:** `/proc/meminfo` `MemAvailable` — the kernel's own estimate
of how much memory is available for new applications without swapping. This is
the standard metric for headroom (it accounts for reclaimable page cache, unlike
`MemFree`).

---

## 2. Monitoring script — `scripts/memwatch.sh`

The script reads `MemAvailable` (and `MemTotal`) from `/proc/meminfo`, compares
the result against two configurable thresholds, and writes a structured alert to
journald when the pressure level changes.

### 2.1 Levels

| Level | Condition (default) | Exit code | Meaning |
|-------|--------------------|-----------|---------|
| `OK` | `MemAvailable` ≥ 4096 MB | 0 | Normal headroom |
| `WARN` | 2048 MB ≤ `MemAvailable` < 4096 MB | 1 | Memory pressure building — investigate |
| `CRIT` | `MemAvailable` < 2048 MB | 2 | Imminent exhaustion — intervene now |
| `ERR` | `MemAvailable` unreadable | 2 | Monitoring failure — check `/proc/meminfo` access |

Thresholds are absolute MB values (not percentages) so behaviour is predictable
regardless of total RAM. The defaults correspond to ~17% (warning) and ~8%
(critical) of a 24 GB system.

### 2.2 Log-line format

One line per level change, written to journald through `logger`:

```
MEMWATCH: 2026-09-25 19:00:01 available=3072MB / total=30970MB (9%) level=WARN
```

The line contains the timestamp, the available memory value, the total RAM, the
percentage, and the threshold status — satisfying the AC requirement for a
single structured line per interval.

### 2.3 Deduplication (log-noise control)

The script records the last reported level in `MEMWATCH_STATE_FILE` (default
`/run/memwatch-state`). A line is emitted **only when the level changes** from the
previous interval:

```
OK → WARN    → one line (WARN)
WARN → WARN  → no line (deduplicated)
WARN → CRIT  → one line (CRIT)
CRIT → CRIT  → no line (deduplicated)
CRIT → OK    → one line (OK)
```

This means sustained pressure produces exactly one alert, not one per minute,
bounding log volume even through a long incident. The exit code still reflects
the current level on every run, so external callers can always poll status.

### 2.4 Configuration

All settings are file-level variables at the top of the script, each overridable
by an environment variable:

| Variable | Default | Purpose |
|----------|---------|---------|
| `MEMWATCH_WARNING_MB` | `4096` | Warning threshold (MB) |
| `MEMWATCH_CRITICAL_MB` | `2048` | Critical threshold (MB) |
| `MEMWATCH_MEMINFO` | `/proc/meminfo` | MemAvailable source (tests override this) |
| `MEMWATCH_STATE_FILE` | `/run/memwatch-state` | Deduplication state file |
| `MEMWATCH_LOG_PREFIX` | `MEMWATCH` | Log line prefix |
| `MEMWATCH_LOGGER` | `logger -p user.warning` | Alert delivery command |
| `MEMWATCH_DRY_RUN` | *(unset)* | Log to stdout instead of journald |
| `MEMWATCH_JSON` | *(unset)* | Emit machine-readable JSON |

### 2.5 Manual use

```bash
# Production (logs to journald)
scripts/memwatch.sh

# Dry run — print the alert line to stdout instead of journald
scripts/memwatch.sh --dry-run

# Machine-readable output
scripts/memwatch.sh --json

# Custom thresholds
MEMWATCH_WARNING_MB=8192 MEMWATCH_CRITICAL_MB=4096 scripts/memwatch.sh --dry-run
```

---

## 3. Installation

`scripts/install-memwatch.sh` deploys the cron job (requires root):

```bash
sudo scripts/install-memwatch.sh
# Custom thresholds:
sudo scripts/install-memwatch.sh --warning 8192 --critical 4096
# Preview without installing:
scripts/install-memwatch.sh --dry-run
# Remove it again:
sudo scripts/install-memwatch.sh --uninstall
```

Installation has two parts:

1. The script is **copied to a root-owned location** `/usr/local/sbin/memwatch`
   (`root:root`, mode `0755`). This is deliberate: the cron job runs as root,
   so the executed script must not be writable by a non-root user — pointing
   root cron at a script inside a user-writable checkout would be a
   privilege-escalation vector.
2. `/etc/cron.d/memwatch` is written (`root:root`, mode `0644`):

```
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

* * * * * root /usr/local/sbin/memwatch
```

Only root can modify either file, so a non-root process cannot alter what the
root cron job executes.

> **Updating the script:** after changing `scripts/memwatch.sh` in the repo,
> re-run `sudo scripts/install-memwatch.sh` to refresh the installed copy.
> The repo is the source of truth; the installed copy is a deploy artefact.

---

## 4. Querying alerts

```bash
# Recent memory alerts (logger -t MEMWATCH sets the syslog tag)
journalctl -t MEMWATCH --since '1 hour ago'

# All warning-or-worse entries carrying the MEMWATCH message prefix
journalctl -p warning --since today | grep MEMWATCH

# Follow live
journalctl -f -t MEMWATCH
```

---

## 5. Historical trend analysis (sysstat)

sysstat is active and collecting memory statistics every 10 minutes. The
`sysstat-collect.timer` drives collection; `sysstat-rotate.timer` rotates daily
and `sysstat-summary.timer` builds daily summaries.

### 5.1 Verified configuration (2026-09-25)

```
$ dpkg -l sysstat | tail -1
ii  sysstat  12.7.7-0ubuntu2  amd64  system performance tools for Linux

$ systemctl status sysstat-collect.timer
● sysstat-collect.timer - Run system activity accounting tool every 10 minutes
     Loaded: loaded (/usr/lib/systemd/system/sysstat-collect.timer; enabled)
     Active: active (waiting)

$ grep HISTORY /etc/sysstat/sysstat
HISTORY=7

$ ls /var/log/sysstat/
sa17 sa18 sa19 sa20 sa21 sa22 sa23 sa24 sa25 ...
```

- **Collection interval:** 10 minutes (`sysstat-collect.timer`)
- **Raw retention:** 7 days (`HISTORY=7`)
- **Data location:** `/var/log/sysstat/` (daily files `sa<DD>`)

### 5.2 Example query — memory trends

```bash
# Today's memory usage, 10-minute samples
sar -r

# Specific date (day-of-month form)
sar -r -f /var/log/sysstat/sa24

# Time-windowed (13:00–14:00 on the 20th — the 2026-08-20 incident)
sar -r -f /var/log/sysstat/sa20 -s 13:00:00 -e 14:00:00

# Percentage-used only, sorted to spot peak pressure
sar -r | awk 'NR>3 {print $4, $5}' | sort -k2 -n | tail -20
```

`kbavail` in `sar -r` output is the same `MemAvailable` metric memwatch alerts on,
so the historical data and live alerts are directly comparable.

### 5.3 Retention extension

If 7 days is insufficient for long-term trend analysis, raise `HISTORY` in
`/etc/sysstat/sysstat` (e.g. `HISTORY=30`) and reload sysstat. Disk cost is
roughly 1 MB per day per host for the memory-relevant data.

---

## 6. Verification (operator runbook)

```bash
# 1. Script works against current system state (no journald write)
scripts/memwatch.sh --dry-run

# 2. Cron file is installed
cat /etc/cron.d/memwatch

# 3. End-to-end alert emission (writes one real journald line)
logger -p user.warning "MEMWATCH: $(date '+%Y-%m-%d %H:%M:%S') available=0MB level=SELFTEST"
journalctl -t MEMWATCH --since '1 minute ago' | tail -1

# 4. Confirm the cron job has run (a MEMWATCH line per level change)
journalctl -t MEMWATCH --since '5 minutes ago' | tail -5

# 5. Historical data is queryable
sar -r | tail -5

# 6. Automated tests
npx vitest run tests/memwatch.test.ts
```

Expected: step 3 prints the `SELFTEST` line; step 4 shows real `level=OK` lines;
step 6 reports 22 passing tests.

---

## 7. False-positive and limitation notes

- **`MemAvailable` notionally excludes swap pressure.** A system can be swapping
  heavily while `MemAvailable` still looks acceptable. Swap monitoring and PSI
  (`/proc/pressure/memory`) are **out of scope** for this work item and are
  candidates for follow-up work.
- **Warning threshold is intentionally conservative** (4 GB on a 30 GB host).
  Sustained `WARN` without `CRIT` indicates memory is being consumed by
  reclaimable cache/workloads that the kernel can recover — useful early signal,
  not necessarily an emergency.
- **The state file (`/run/memwatch-state`) is cleared on reboot.** After a reboot the first
  interval always emits one line (level change from unknown), which is desirable:
  it records the post-reboot memory state.
- **Cron granularity is one minute.** The system can exhaust memory faster than
  that; memwatch is an early-warning system, not a hard OOM guard. `systemd-oomd`
  or `earlyoom` would be the reactive counterpart (out of scope).

---

## 8. Tests

`tests/memwatch.test.ts` (22 tests) runs the real script with a fixture
`/proc/meminfo` supplied through `MEMWATCH_MEMINFO` and captures output via
`--dry-run`. It covers:

- OK/WARN/CRIT level classification and exact threshold boundaries
- Per-level deduplication (repeated intervals produce no second line)
- Level-transition logging (OK→WARN, WARN→CRIT, CRIT→OK)
- Configurable thresholds and log prefix
- Unreadable-meminfo error handling (exit 2, `level=ERR`)
- JSON output shape and `--help`

---

## 9. References

- `/etc/cron.d/memwatch` — installed cron job (this work item)
- `scripts/memwatch.sh` — monitoring script
- `scripts/install-memwatch.sh` — installer
- `tests/memwatch.test.ts` — automated tests
- `/proc/meminfo`, `/proc/pressure/memory` — kernel memory signals
- `/etc/sysstat/sysstat`, `/var/log/sysstat/` — sysstat configuration and data
- `docs/dev/crash-reporting.md` — related host-health monitoring precedent
- `docs/dev/wl-process-spawning-investigation.md` — `wl-process-healthcheck.sh` precedent
