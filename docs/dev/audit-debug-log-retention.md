# Audit Debug Log Retention

Policy and runbook for the transient `audit_debug_*.jsonl` forensic dumps
written by the audit skill. Stale dumps are pruned by
[`scripts/prune_audit_debug_logs.py`](../../scripts/prune_audit_debug_logs.py)
and the daily sweep is installed as an idempotent cron entry by
[`scripts/install-audit-log-hygiene.sh`](../../scripts/install-audit-log-hygiene.sh).

Work item: `WL-0MUJL0PTS009MC8F` (parent) / `WL-0MUJRQP5A003BKDH` (this page).

## Why this exists

Audit debug logs are transient forensics, not durable data. Legacy dumps had
accumulated unbounded — on this host, 48 files / 12.5 GB in the ContextHub
`.worklog` store, 33 files / 11.3 GB in `open_source_llm/.worklog`, and 2.5 GB
under `~/.audit_debug`. Multi-GB JSONL inputs turned recursive greps into
minutes-long, high-CPU scans. The retention sweep keeps the footprint bounded
and predictable.

## What is swept

| Location | Recursion | Notes |
|----------|-----------|-------|
| `~/projects/*/.worklog/` (every worklog store) | **non-recursive** — files directly in the store only | Worktree sub-directories (`.worklog/worktrees/**`) are never swept. |
| `~/.audit_debug/**` | **recursive** | Where `audit_runner.py` now writes dumps. |

Only files whose basename matches `audit_debug_*.jsonl` are ever considered.
Every other file — `worklog.db`, `worklog.db-wal`, `worklog.db-shm`,
`config.yaml`, worktrees, and anything else — is never selected or deleted.

`--root <path>` (repeatable) replaces the default locations. A root whose
basename is `.worklog` is scanned non-recursively; every other root is scanned
recursively. Missing roots are a no-op.

## `~/.audit_debug` vs legacy `.worklog`

- **Current.** The SorraAgents audit skill's `audit_runner.py` writes dumps to
  `~/.audit_debug/<project-slug>/` (`_debug_log_dir` / `_default_debug_log_path`)
  and deletes them after a successful run (`_remove_debug_log`).
- **Legacy.** Dumps under `*/.worklog/audit_debug_*.jsonl` predate that move and
  are stale; they will not regrow. They are still swept because the two largest
  stores hold tens of GB of them.

Both locations share the same name guard and thresholds.

## Selection thresholds

A name-matched candidate is selected for deletion when **either** holds:

| Rule | Default | Flag |
|------|---------|------|
| Strictly older than *N* days | 7 days | `--older-than DAYS` |
| Strictly larger than *M* MB | 50 MB | `--max-size MB` |

A file exactly at the boundary is kept (the comparisons are strict). Newer and
smaller files survive, which is why `~/.audit_debug` settles at a bounded
footprint rather than emptying.

## Modes

| Mode | Effect |
|------|--------|
| *(default)* | **Dry-run.** Prints the selected set and aggregate bytes; changes nothing on disk. |
| `--apply` | Deletes exactly the selected set, emitting one audit line per removed file (path + bytes). |
| `--check` | Deletes nothing. Exits non-zero when the total debug-log footprint exceeds `--budget-gb` (default **5**). |

`--apply` and `--check` are mutually exclusive. A second `--apply` immediately
after the first reports `0 candidate(s) selected` — the sweep is idempotent.

When `--log-file PATH` is given, each removed-file audit line is also appended
to that file. Only aggregate counts and sizes are ever reported — log
**contents** are never printed or recorded (dumps may contain provider
payloads).

## CLI reference

```text
prune_audit_debug_logs.py
  --root PATH          Search root (repeatable). Overrides the defaults.
  --older-than DAYS    Select files strictly older than this (default 7).
  --max-size MB        Select files strictly larger than this (default 50).
  --budget-gb GB       --check budget (default 5).
  --log-file PATH      Append one audit line per removed file.
  --apply              Delete the selected files (default: dry-run).
  --check              Delete nothing; non-zero when over --budget-gb.
  -h, --help           Show help.
```

Exit codes: `0` success / within budget; `1` `--check` over budget, invalid
argument, or usage error. The sweep never exits 0 while over budget.

## Runbook

Run from the repository root so the relative script path resolves:

```bash
cd /home/rgardler/projects/ContextHub

# 1. Inspect (safe): what would be removed, and the total footprint.
python3 scripts/prune_audit_debug_logs.py
python3 scripts/prune_audit_debug_logs.py --check

# 2. Reclaim: delete the selected set and audit each removal.
python3 scripts/prune_audit_debug_logs.py --apply --log-file "$HOME/.audit_debug/hygiene-cron.log"

# 3. Confirm idempotence (expect "0 candidate(s) selected").
python3 scripts/prune_audit_debug_logs.py --apply
```

Tighter or looser thresholds:

```bash
python3 scripts/prune_audit_debug_logs.py --older-than 3 --max-size 20      # dry-run
python3 scripts/prune_audit_debug_logs.py --older-than 3 --max-size 20 --apply
python3 scripts/prune_audit_debug_logs.py --check --budget-gb 2
```

Sweep a specific tree (useful for testing or narrowing scope):

```bash
python3 scripts/prune_audit_debug_logs.py --root "$HOME/.audit_debug" --check
python3 scripts/prune_audit_debug_logs.py --root "$HOME/projects/ContextHub/.worklog"
```

### Safety guarantees

- **Name guard.** Only `audit_debug_*.jsonl` basenames are considered.
- **Never touches tracked/live data.** `worklog.db`, its WAL/SHM sidecars,
  `config.yaml`, and worktree directories are never selected; live SQLite
  worklog data is unaffected.
- **Dry-run by default.** Deletion requires the explicit `--apply` flag.
- **Resilient.** An `OSError` while stat-ing or unlinking a candidate is logged
  and skipped; the sweep continues with the remaining candidates and never
  aborts mid-set.
- **Aggregate-only reporting.** Only counts/sizes are recorded — never log
  contents.

## Automation (cron)

### Install / remove with the helper

The helper is idempotent: it tags the entry with a stable marker comment, so
re-running never adds a duplicate and `--remove` never disturbs unrelated
crontab lines.

```bash
cd /home/rgardler/projects/ContextHub

# Install the daily sweep (idempotent). Prints "already installed" on re-run.
./scripts/install-audit-log-hygiene.sh

# Preview the change without writing anything.
./scripts/install-audit-log-hygiene.sh --dry-run

# Remove only the managed entry.
./scripts/install-audit-log-hygiene.sh --remove

# Rotate the hygiene log now if it exceeds the cap.
./scripts/install-audit-log-hygiene.sh --rotate-log
```

The managed entry runs the sweep with `--apply` once a day (default
`17 3 * * *`) and then rotates its own log:

```cron
# managed by install-audit-log-hygiene.sh (worklog audit debug retention)
17 3 * * * cd '/home/rgardler/projects/ContextHub' && 'python3' '/home/rgardler/projects/ContextHub/scripts/prune_audit_debug_logs.py' --apply --log-file '/home/rgardler/.audit_debug/hygiene-cron.log' ; '/home/rgardler/projects/ContextHub/scripts/install-audit-log-hygiene.sh' --rotate-log >/dev/null 2>&1
```

### Manual install (if you decline the helper)

Operators who prefer to edit their own crontab can append the exact managed
line. Run this **from the repository root** — `$PWD` is expanded when the
snippet runs, so the installed line contains absolute paths:

```bash
( crontab -l 2>/dev/null; \
  printf '%s\n' \
    '# managed by install-audit-log-hygiene.sh (worklog audit debug retention)' \
    "17 3 * * * cd '$PWD' && python3 '$PWD/scripts/prune_audit_debug_logs.py' --apply --log-file '$HOME/.audit_debug/hygiene-cron.log' ; '$PWD/scripts/install-audit-log-hygiene.sh' --rotate-log >/dev/null 2>&1" \
) | crontab -
```

Verify with `crontab -l`. To reverse it, remove the two managed lines
(the marker comment and the line beneath it) with `crontab -e` — or just run
`./scripts/install-audit-log-hygiene.sh --remove`.

### Bounded hygiene log

`~/.audit_debug/hygiene-cron.log` receives one audit line per removed file.
After each sweep the managed entry calls the helper's `--rotate-log` action,
which rotates the log to `hygiene-cron.log.1` and starts a fresh file once it
exceeds the cap (default **5 MB**, `HYGIENE_LOG_MAX_BYTES`). At most two
generations exist, so the hygiene log can never itself become the next runaway.

Environment overrides for the helper:

| Variable | Default | Purpose |
|----------|---------|---------|
| `CRONTAB` | `crontab` | crontab command (test seam; rarely needed) |
| `HYGIENE_CRON_SCHEDULE` | `17 3 * * *` | cron schedule |
| `HYGIENE_LOG_FILE` | `$HOME/.audit_debug/hygiene-cron.log` | hygiene log path |
| `HYGIENE_LOG_MAX_BYTES` | `5242880` | rotation cap in bytes |
| `PYTHON` | `python3` | interpreter used by the sweep |

## Relationship to the audit skill

The SorraAgents audit skill ships `cleanup_debug_logs.py`, which sweeps
`~/.audit_debug` only, with a **14-day** retention and dry-run default. That
script is **referenced, not forked** — this page and its tooling do not edit
the audit skill (repo-boundary rule). The repo-local sweep broadens coverage to
the legacy `.worklog` stores, uses the 7-day/50 MB defaults, adds `--check`,
and is automated by cron. Upstreaming the `~/.audit_debug` half into the audit
skill is a follow-up, not scope.

## Out of scope (follow-ups)

- Machine-hygiene skill `WL-0MUJLCVRS0093EJJ` — the broader performance-pressure
  remediation workflow.
- Pre-commit/pre-push enforcement of `--check` — only a documented optional
  hook call; not wired in here.
- Cold-storage archiving (gzip `--archive-dir`) — deletion is the current
  default; archiving would be an additive follow-up.

## Related documentation

- [`scripts/prune_audit_debug_logs.py`](../../scripts/prune_audit_debug_logs.py) — the sweep.
- [`scripts/install-audit-log-hygiene.sh`](../../scripts/install-audit-log-hygiene.sh) — cron installer.
- [wl process healthcheck](./wl-process-healthcheck.md) — another machine-hygiene watchdog.
