# wl Process Healthcheck

Lightweight watchdog that detects accumulation of concurrent `wl`/`worklog`
CLI processes before it degrades the host. Motivation and design rationale
come from the [wl process spawning investigation](./wl-process-spawning-investigation.md)
(206 concurrent wl processes, ~17 GB RAM, host load 150–225).

## How it works

`scripts/wl-process-healthcheck.sh` counts node `wl`/`worklog` CLI processes
(`ps`-based, no external dependencies) and classifies the result:

| Level | Count | Action |
|-------|-------|--------|
| OK | < watch threshold (20) | log count to `/tmp/wl-healthcheck-count`, exit 0 |
| WATCH | 20–50, or above 50 but not yet sustained | log count to `/tmp/wl-healthcheck-count`, exit 0 |
| ALERT | > 50 for 3 consecutive checks | emit process tree (`ps -eo pid,ppid,etime,args`), exit 2 |

The current count is written to `/tmp/wl-healthcheck-count` (overridable via
`--count-file`) on OK/WATCH levels. Consecutive high readings are tracked in
`/tmp/wl-healthcheck-ticks` (overridable via `--ticks-file`) and reset on any
OK/WATCH reading or after a completed alert.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | OK or WATCH (count logged) |
| 2 | ALERT — sustained high count; process tree emitted to stderr |

## Usage

```bash
# One-off check
./scripts/wl-process-healthcheck.sh

# JSON output for scripts / monitoring
./scripts/wl-process-healthcheck.sh --json
```

### Options

```
--alert-threshold N   Alert above N concurrent wl processes (default 50)
--watch-threshold N   Watch at N concurrent wl processes (default 20)
--sustained N         Require N consecutive high readings (default 3)
--count-file PATH     File receiving the current count (default /tmp/wl-healthcheck-count)
--ticks-file PATH     File tracking consecutive high readings (default /tmp/wl-healthcheck-ticks)
--json                Emit machine-readable JSON to stdout
-h, --help            Show help and exit
```

### cron (every 5 minutes)

```cron
*/5 * * * * /path/to/worklog/scripts/wl-process-healthcheck.sh >> /var/log/wl-healthcheck.log 2>&1
```

### systemd timer (every 5 minutes)

`/etc/systemd/system/wl-healthcheck.service`:

```ini
[Unit]
Description=wl process healthcheck watchdog
After=network.target

[Service]
Type=oneshot
ExecStart=/path/to/worklog/scripts/wl-process-healthcheck.sh
```

`/etc/systemd/system/wl-healthcheck.timer`:

```ini
[Unit]
Description=Run wl process healthcheck every 5 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wl-healthcheck.timer
```

On ALERT the exit code is non-zero, so cron/systemd mail-on-error or a
monitoring hook (herdr toast / terminal notification) can page the operator.
Typical usage: alert only when the count is *sustained* for several checks,
so transient spikes during interactive use do not page anyone.

## CI regression gate

The CLI test workflow (`.github/workflows/cli-tests.yml`) asserts after the
test suite that zero orphaned `tsx src/cli.ts` processes remain, covering the
test-harness orphan fix (WL-0MSB447TJ000R3N8). A regression there fails CI.
