# Investigation: Excessive `wl` Process Spawning (206 concurrent, ~17 GB RAM)

**Work item:** WL-0MSB19J56006E87J — Investigate excessive wl process spawning
(206 concurrent, ~17 GB RAM)

**Status:** Investigation complete. Root cause identified, spawn trace captured,
remediation plan + health check proposed.

**Related:** [pause-when-hidden.md](./pause-when-hidden.md) (the fix for the
dominant contributor), WL-0MSB1N0HB0007N6N, WL-0MSB447TJ000R3N8,
WL-0MSAB7ZUC004SK7E.

---

## 1. Executive summary

Thirteen `pi` agent sessions (plus herdr worklist panes) were observed
spawning **206 concurrent `wl` CLI subprocesses** consuming ~17 GB RAM.
Investigation identified **five distinct spawning sources**, of which one
(the pi browse widget 5s polling) was the dominant contributor and has been
**fixed** (WL-0MSB1N0HB0007N6N / `b8840d99`). The remaining sources and the
remediation plan are documented here.

| # | Source | Spawn rate (per source) | wl commands | Status |
|---|--------|------------------------|-------------|--------|
| 1 | Pi extension browse selection widget (`packages/tui/extensions/Worklog/lib/browse.ts`) | every 5s while active (4–5 spawns/tick) | `wl next`, `wl list`, `wl sync --if-idle` | **FIXED** (idle-gated + pane-focus-gated, `b8840d99`) |
| 2 | Herdr worklist pane (`packages/herdr/src/worklist.ts` + `fetcher.ts`) | every `refreshIntervalMs` (user settings: **1500 ms!**) — 4 spawns/tick | `wl next`, `wl list --priority critical --root-only`, `wl list --status completed --stage in_review --root-only`, `wl list --status open,in-progress,blocked` | Gated in code (`b8840d99`) but **running panes pre-date the fix** + **settings override too aggressive** |
| 3 | Test harness `execAsync`/`execWithInput` (`tests/cli/cli-helpers.ts`) | per-test; leaked processes hang indefinitely | `wl create`, `wl show`, `wl update`, `wl init` | **FIXED** (process-tree kill + timeout, WL-0MSB447TJ000R3N8) |
| 4 | Agent-invoked `wl` queries via the `bash` tool (skills: heartbeat, implement, intake, plan, cleanup) | per-query, sequential | `wl next`, `wl list`, `wl sync`, `wl show`, `wl update`, `wl comment` | Acceptable; bounded by agent activity |
| 5 | `wl sync --if-idle` auto-sync timers (herdr panes / pi widget) | every 60s per visible pane | `wl sync --if-idle` | Gated with the pollers; lock-aware (`--if-idle`) |

---

## 2. Root cause analysis

### 2.1 Dominant contributor: pi browse widget 5s polling (FIXED)

**Component:** `packages/tui/extensions/Worklog/lib/browse.ts`

The pi Worklog browse widget spawned `wl list` and `wl next` **every 5 seconds
per agent session, unconditionally** — regardless of whether the selection
list pane was visible or whether the user had interacted with it. Each tick
spawned 4–5 `wl` subprocesses:

- `wl next -n <count> --include-in-progress --json` (via the fetcher)
- `wl list --priority critical --root-only --json` (smart-selection mandatory set)
- `wl list --status completed --stage in_review --root-only --json` (producer-review queue)
- `wl sync --if-idle` (auto-sync trigger)

With 13 concurrent agent sessions, each open `/wl` browser accumulated
~60 idle `wl` processes per hour (one batch per 5s). No pause mechanism
existed when the agent was idle or the pane was not focused.

**Remediation applied** (commit `b8840d99`, work item WL-0MSB1N0HB0007N6N):

- `IDLE_PAUSE_MS` (30 s) idle detection: when no keypress has occurred for
  30 s, the 5s auto-refresh interval returns early — **zero** `wl` spawns
  during idle periods.
- First keypress after idle triggers an immediate refresh and resumes the
  normal cadence.
- Herdr pane-focus gating (`PollGate` + `isPaneVisible()`): hidden herdr panes
  (not tab-focused) skip refresh/sync ticks entirely, with a
  `[paused — hidden]` header indicator.

See [pause-when-hidden.md](./pause-when-hidden.md) for verification
procedures.

### 2.2 Herdr worklist pane refresh cadence + stale running panes

**Component:** `packages/herdr/src/worklist.ts`, `packages/herdr/src/fetcher.ts`

Each herdr worklist pane (one per project tab) spawns **4 `wl` processes per
refresh cycle** (`fetchNextItems` + `fetchMandatorySubsets` run in parallel +
`fetchActionableCount`):

```
wl next -n 20 --include-in-progress --json
wl list --priority critical --root-only --json        (parallel)
wl list --status completed --stage in_review --root-only --json  (parallel)
wl list --status open,in-progress,blocked --json     (after refresh)
```

Two aggravating factors were found:

1. **User settings override is extremely aggressive.**
   `~/.config/herdr/worklog-plugin.json` sets `refreshIntervalMs: 1500`
   (1.5 s!) against a 30 s default:

   ```json
   {
     "browseItemCount": 20,
     "showHelpText": false,
     "autoRefresh": true,
     "refreshIntervalMs": 1500,
     "showIcons": true,
     "autoSync": true,
     "syncIntervalMs": 60000
   }
   ```

   At 1.5 s × 4 spawns/tick × 12 panes this alone can sustain
   **~32 spawns/sec** — the dominant ongoing source during active use.

2. **Running panes pre-date the visibility-gating fix.** At the time of the
   investigation, 3 of 4 running panes were started before `b8840d99`
   (Aug 1 22:04, Aug 1 22:48, Aug 2 02:26) and therefore run the **old code
   without pane-focus gating**. tsx does not hot-reload; the panes must be
   restarted to pick up the gating fix.

3. **No in-flight guard on `doRefresh`.** `setInterval` fires regardless of
   whether the previous refresh cycle is still awaiting its `wl` calls. Under
   load (slow `wl` due to SQLite/lock contention), refresh cycles overlap and
   processes pile up. (`doSync` has a single-flight guard via
   `--if-idle`/`createSyncTimer`, but `doRefresh` does not.)

### 2.3 Test-harness orphans (FIXED — WL-0MSB447TJ000R3N8)

**Component:** `tests/cli/cli-helpers.ts`

`execAsync`/`execWithInput` tracked only the **shell PID** from
`child_process.exec`/`spawn(shell: true)`. When the test worker was killed
(SIGKILL from vitest timeout, worktree cleanup, or OOM), the actual
`tsx src/cli.ts --json create/update/show/init` processes (grandchildren of
the shell) were reparented to init (ppid=1). Their cwd pointed to a
**deleted temp test directory**, so they hung forever on `ep_poll` waiting
for I/O that could never complete.

Observed: 26 orphaned `wl create -t "Valid JSON test item N"` processes
(ppid=1, state `Sl`, 52+ min elapsed) from the
`wl-WL-0MSAUI2MW002ETPF-init-pre-push-guards` test worktree, plus additional
`wl show`/`wl update`/`wl init` orphans from the same worktree — **22 + 8 + 2
= 32 processes killed during this investigation** (~2.5 GB RSS freed).

**Fix applied (WL-0MSB447TJ000R3N8):**

- `killProcessTree(pid)`: kills the whole process group (`-pid`) first, then
  falls back to the individual PID — grandchildren included.
- `_execTracked` rewritten with `child_process.spawn(..., { shell: true,
  detached: true })` so a process group exists, plus an enforced timeout
  (default 30 s) that SIGKILLs the tree.
- `execWithInput` likewise: `detached: true` + timeout.
- New `killStaleWlProcesses(match)` helper for CI teardown / manual sweeps of
  orphaned `wl` processes from a named test worktree.
- Tests in `tests/cli/process-lifecycle.test.ts` verify process-tree kill,
  timeout kill, worker-exit cleanup wiring, and the stale-process sweeper.

### 2.4 Agent-invoked `wl` queries (bounded, acceptable)

Skills invoke `wl` via the `bash` tool (each call spawns a shell → `wl`) or
via `subprocess.run` in Python scripts (heartbeat, implement, intake, plan,
cleanup). These are:

- **Sequential** (no concurrent fan-out),
- **Short-lived** (complete in seconds; `subprocess.run` waits and reaps),
- **Bounded** by actual agent activity (a work item being processed).

The heartbeat skill polls `wl list`/`wl next` but only **per invocation**
(after a completed process, per its completion-detection gate), not on a
timer. No systematic leak is present here; no change required beyond the
health check below.

### 2.5 Why processes were not being cleaned up

| Reason | Mechanism |
|--------|-----------|
| No idle pause in the browse widget | 5s interval ran unconditionally (fixed) |
| No pane-focus gate in old herdr panes | Old panes polled even when hidden (fixed in code; needs pane restart) |
| Aggressive user setting | `refreshIntervalMs: 1500` multiplied spawn rate 20× over default |
| No in-flight guard on refresh | Overlapping refresh cycles under load pile up |
| Test orphans | Shell PID tracked, not the tree; SIGKILLed worker orphans grandchildren; deleted temp cwd hangs them forever |

---

## 3. Spawn trace (captured 2026-08-02)

### 3.1 Process tree — herdr worklist pane → wl subprocesses

```
herdr server (PID 1302715, up 1 day)
 └─ npm exec tsx src/index.ts            (pane, e.g. PID 1554865 — started Aug 1 22:04, PRE-fix)
     └─ sh -c tsx src/index.ts
         └─ node .../tsx src/index.ts    (the pane process)
             ├─ node /usr/local/bin/wl --worklog-dir <proj>/.worklog next -n 20 --include-in-progress --json
             ├─ node /usr/local/bin/wl --worklog-dir <proj>/.worklog list --priority critical --root-only --json
             ├─ node /usr/local/bin/wl --worklog-dir <proj>/.worklog list --status completed --stage in_review --root-only --json
             ├─ node /usr/local/bin/wl --worklog-dir <proj>/.worklog list --status open,in-progress,blocked --json
             └─ node /usr/local/bin/wl --worklog-dir <proj>/.worklog sync --if-idle
```

### 3.2 Observed command mix (peak, from the original report)

```
wl list --status open,in-progress,blocked --json       126 instances
wl next -n 20 --include-in-progress --json              63 instances
wl sync --if-idle                                        4 instances
wl list --priority critical --root-only --json          multiple
wl list --status completed --stage in_review --root-only --json  multiple
```

### 3.3 Orphaned test processes (WL-0MSB447TJ000R3N8)

```
node .../.worklog/worktrees/wl-WL-0MSAUI2MW002ETPF-init-pre-push-guards/...tsx
      .../src/cli.ts --json create -t "Valid JSON test item N"     (ppid=1, Sl, 13h)
/usr/bin/node --require ...tsx/preflight... src/cli.ts --json create -t "..." (child)
```

cwd → `/tmp/worklog-test-XXXX (deleted)` — the temp dir was cleaned while the
process was still alive, so the process hung forever.

### 3.4 Measured spawn rate during investigation

- **112 unique wl PIDs in 30 s** (~3.7/s) while 4 herdr panes were running
  (3 pre-fix panes polling at the 1.5 s user setting + post-fix panes).
- At peak (13 sessions + more panes, pre-fix): 206 concurrent processes.

---

## 4. Remediation plan (prioritized)

| # | Change | Where | Effort | Impact | Status |
|---|--------|-------|--------|--------|--------|
| 1 | Idle-gate the pi browse widget (30 s no-keypress pause + resume on keypress) | `packages/tui/extensions/Worklog/lib/browse.ts` | S (done) | Eliminates ~60 spawns/hour/session idle | **Done** (`b8840d99`) |
| 2 | Pane-focus-gate herdr worklist refresh + sync timers | `packages/herdr/src/worklist.ts`, `visibility.ts` | S (done) | Hidden panes spawn zero wl processes | **Done** (`b8840d99`) |
| 3 | **Reset user settings** `refreshIntervalMs: 1500 → 30000` | `~/.config/herdr/worklog-plugin.json` | XS | 20× reduction in refresh spawns | **Operator action** (see §5) |
| 4 | **Restart pre-fix herdr panes** so gating code takes effect | herdr (`herdr server reload` / pane restart) | XS | Old panes stop polling when hidden | **Operator action** |
| 5 | Add in-flight guard to `doRefresh` (skip tick if previous refresh still running) | `packages/herdr/src/worklist.ts` | S | Prevents overlap pile-up under load | Proposed |
| 6 | Process-tree kill + timeout in test harness; `killStaleWlProcesses` helper | `tests/cli/cli-helpers.ts` | S (done) | Kills orphaned test `wl` processes | **Done** (WL-0MSB447TJ000R3N8) |
| 7 | Health check / watchdog for wl process counts | see §6 | S–M | Detects regression before 200+ processes | Proposed |

### 4.1 Recommended immediate operator actions

```bash
# 1. Reset the aggressive refresh interval
sed -i 's/"refreshIntervalMs": 1500/"refreshIntervalMs": 30000/' \
  ~/.config/herdr/worklog-plugin.json

# 2. Restart herdr so all panes run the gated code
herdr server reload-config      # if the fix is already on disk
# or restart herdr panes entirely:
#   herdr server restart        # recreates panes from the current source

# 3. Verify
ps -eo args | grep -E 'wl (next|list|sync)' | grep -v grep | wc -l
# Expect: transient counts only while interacting; ~0 when idle/hidden.
```

---

## 5. Agent spawning behavior (documented)

| Caller | Invocation style | Commands | Frequency | Lifecycle |
|--------|------------------|----------|-----------|-----------|
| Pi browse widget (extension) | `runWl` via `execFile` (fetcher) | `wl next`, `wl list`, `wl sync --if-idle` | 5 s while active; **0 when idle** (fixed) | Promisified execFile; waited + reaped |
| Herdr worklist pane | `runWl` via `execFile` (fetcher) | `wl next`, `wl list` ×3, `wl sync --if-idle` | `refreshIntervalMs` (default 30 s; **user override 1.5 s**) | Promisified execFile; waited + reaped |
| Agent `bash` tool (skills) | shell spawn per query | `wl next`, `wl list`, `wl show`, `wl update`, `wl comment`, `wl sync` | per agent decision, sequential | Shell exits after command; reaped by pi |
| Python skills (heartbeat, implement, intake, plan, cleanup) | `subprocess.run` | `wl list`, `wl next`, `wl audit-show`, `wl update` | per skill invocation (heartbeat: after each completed process, gated) | `subprocess.run` waits and reaps |
| Test harness | `exec`/`spawn(shell:true)` | `wl create/update/show/init` | per test | **Was**: shell PID only, orphans on SIGKILL. **Now**: detached + process-tree kill + timeout (WL-0MSB447TJ000R3N8) |

**Key takeaway:** agents do **not** batch or cache `wl` queries — every query
spawns a fresh CLI process. That is acceptable when cadence is human-driven,
but any **timer-driven** poller must be idle/focus-gated and must enforce
in-flight guards.

---

## 6. Health check mechanism (proposal)

### 6.1 Lightweight watchdog script

A small, dependency-free script that counts `wl`/`worklog` processes and
alerts when the count exceeds a threshold for a sustained period. Proposed as
`scripts/wl-process-healthcheck.sh` (or a skill), run from cron/systemd
timer every 5 minutes:

```bash
#!/usr/bin/env bash
# wl-process-healthcheck — detect wl process accumulation
set -uo pipefail
THRESHOLD="${1:-50}"           # alert above N concurrent wl processes
SUSTAINED_TICKS=3              # require 3 consecutive high readings
COUNT_FILE="/tmp/wl-healthcheck-count"
TICKS_FILE="/tmp/wl-healthcheck-ticks"

count=$(ps -eo args | grep -E '^node .*(/wl|/worklog)( |$)' | grep -v grep | wc -l)

if [ "$count" -gt "$THRESHOLD" ]; then
  ticks=$(cat "$TICKS_FILE" 2>/dev/null || echo 0)
  ticks=$((ticks + 1))
  echo "$ticks" > "$TICKS_FILE"
  if [ "$ticks" -ge "$SUSTAINED_TICKS" ]; then
    echo "[ALERT] $count wl processes sustained for $ticks checks" >&2
    ps -eo pid,ppid,etime,args | grep -E 'wl (next|list|sync|create|show|update)' | grep -v grep
    rm -f "$TICKS_FILE"
    exit 2
  fi
else
  rm -f "$TICKS_FILE"
fi
echo "$count" > "$COUNT_FILE"
exit 0
```

### 6.2 Thresholds & escalation

| Level | Count | Action |
|-------|-------|--------|
| OK | < 20 | no action |
| Watch | 20–50 | log + count in `/tmp/wl-healthcheck-count` |
| Alert | > 50 for 3 checks | emit alert with `ps` tree; notify operator (herdr toast / terminal) |

### 6.3 Regression gates (CI / pre-push)

- **CI:** after the test suite, assert
  `ps -eo args | grep -c 'tsx.*src/cli.ts'` returns 0 (no orphaned test
  processes). This is covered by the WL-0MSB447TJ000R3N8 tests.
- **Manual:** after 10 minutes of idle herdr panes, `wl` count should be ~0
  (see [pause-when-hidden.md](./pause-when-hidden.md) verification).

### 6.4 Where to put it

- Repo-local: `scripts/wl-process-healthcheck.sh` + a systemd timer or cron
  entry in the affected projects.
- Framework-level (optional): a `pi` status footer showing current wl process
  count, or a periodic check in the herdr plugin.

---

## 7. Scope & follow-ups

- **In scope:** investigation + documentation (this report), the dominant
  poller fix (done), and the test-harness orphan fix (done, WL-0MSB447TJ000R3N8).
- **Out of scope (separate work items):** in-flight guard for herdr
  `doRefresh` (§4 #5), watchdog deployment (§4 #7), settings reset + pane
  restart (§4 #3/#4 — operator actions).
