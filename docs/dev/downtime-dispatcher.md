# Downtime Dispatcher: Leader Election + Shared Coordination File

The herdr plugin's **downtime worker** (`packages/herdr/src/downtime-worker.ts`)
uses local-LLM idle compute to advance the worklog backlog automatically
(dispatch `/skill:audit`, `/skill:plan`, `/skill:implement`, scheduled
prompts). The 2026-08 refactor (work item **WL-0MST3OJ8S0001ROL**) changed the
dispatcher from "every herdr instance polls the llama-proxy and dispatches" to
a single-leader model: **one elected leader** handles all proxy polling and
dispatch while the other herdr instances coordinate instead of polling.

This page is the deep-dive reference for operators and agents. The
package-level overview lives in
[`packages/herdr/README.md`](../../packages/herdr/README.md) *Downtime worker
(local-LLM idle dispatch)*.

## Architecture

```
                ┌─────────────────────────── single machine ───────────────────────────┐
                │                                                                      │
  herdr A ──▶   .worklog/downtime-leader.lock    (file lock, first-to-create wins)      │
                .worklog/downtime-leader-lease.json  (5-min TTL, refreshed per poll)    │
                .worklog/downtime-coordination.json   (one entry per instance)          │
                │                                                                      │
  herdr B ──▶   checks in every 30 min: offers its own worklog's most-important item    │
                │                                                                      │
  leader ⊇ A     polls llama-proxy → idle gate → dispatch tiers → removes entry         │
                └──────────────────────────────────────────────────────────────────────┘
```

### Leader election (file lock + lease)

- The first instance to atomically create
  `<worklog-root>/.worklog/downtime-leader.lock`
  (`O_CREAT|O_EXCL` — the "flock-equivalent" single-machine v1) becomes the
  leader (`packages/herdr/src/leader-election.ts`).
- The leader holds a **5-minute lease**
  (`DEFAULT_LEASE_TTL_SECONDS = 300`) written to
  `.worklog/downtime-leader-lease.json`, refreshed on every proxy-poll cycle.
- If the lease expires (leader crashed or idle), a non-leader detects the
  staleness, clears the stale lock/lease, and runs a new election (with
  exponential backoff).
- **Fail-safe:** a missing/unreadable lock or lease file is treated as "no
  leader" — the instance never dispatches without a valid leased lock.

### Shared coordination file

`<worklog-root>/.worklog/downtime-coordination.json` stores one entry per
herdr instance:

```json
{"version":1,"entries":[
  {"instanceId":"<uuid>","workItemId":"<wl-id>","directory":"<worklog-root>",
   "assignedAt":"<iso>","lastUpdated":"<iso>"}
]}
```

Lifecycle (`packages/herdr/src/coordination.ts`):

1. **Check-in** — every instance (leader and non-leader alike) reads the file
   on startup and every **30 minutes**
   (`DEFAULT_COORDINATION_CHECK_IN_MS`), recomputes its own worklog's
   **most-important item**, and upserts its entry (add if absent, update if
   the item changed).
2. **Dispatch** — the leader removes an entry when it dispatches that item;
   the owning instance re-offers its next most-important item at its next
   check-in.
3. **Pruning** — stale entries (`lastUpdated` older than the lease TTL) are
   pruned during dispatch cycles; operations are recorded in
   `.worklog/downtime-coordination.log`.

### Leader-only dispatch

1. Only the leader polls the llama-proxy status and observes the **idle
   gate** (continuous idle for the configured threshold — see timings
   below).
2. When a **scheduled prompt** is due, it dispatches immediately
   (WL-0MSS1Q5ER007QDKX).
3. Otherwise the leader reads the coordination list, classifies each offered
   item by tier priority **audit → implement → plan → intake**, and
   dispatches the highest-priority available item when a slot opens.
4. The dispatched entry is **removed** from the coordination file. The
   existing dispatched-marker exclusion and CAS claim mechanisms are
   preserved unchanged.
5. **Non-leaders** skip proxy polling and dispatch entirely — they only
   refresh their lease check (a cheap local file read) and their
   coordination entry.

### Multi-worklog support

Each coordination entry records its own worklog root (`directory`). The
leader compares offers across directories using the standard tier priority
system and spawns dispatch panes into each entry's directory. v1 scope is
single-machine; a multi-machine (real flock/NFS) extension is future work.

## Timing defaults (canonical)

The original spec (parent AC8) said "30s proxy poll + 4 min continuous idle
threshold". **Accepted variance (2026-08-24): the code defaults are
canonical — 10s dispatch poll, 60s continuous idle threshold, with the proxy
status refresh unchanged at 30s.**

| Setting | Default | Source |
|---|---|---|
| Dispatch poll interval | **10 s** (`downtimePollIntervalMs`) | `DEFAULT_DOWNTIME_POLL_INTERVAL_MS`, floor 10 s (`downtime-worker.ts`) |
| LLM continuous idle threshold | **60 s** (`downtimeIdleThresholdMs`) | `DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS`, floor 1 s (`downtime-worker.ts`) |
| Proxy status refresh | 30 s (`refreshIntervalMs`) | `settings.ts` (unchanged, pre-refactor cadence) |
| Leader lease TTL | 5 min (`DEFAULT_LEASE_TTL_SECONDS = 300`) | `leader-election.ts` |
| Coordination check-in | 30 min (`DEFAULT_COORDINATION_CHECK_IN_MS`) | `downtime-worker.ts` |

Both dispatch-poll and idle-threshold are configurable in the herdr plugin
settings file (`~/.config/herdr/worklog-plugin.json`,
`downtimePollIntervalMs` / `downtimeIdleThresholdMs`) and are clamped on
load (see `clampDowntimePollInterval` / `clampDowntimeIdleThresholdMs` in
`downtime-worker.ts`).

## Files & runtime artifacts

| Path | Purpose |
|---|---|
| `packages/herdr/src/leader-election.ts` | Lock acquisition, lease management, re-election |
| `packages/herdr/src/coordination.ts` | Coordination file read/write (entries, prune, upsert) |
| `packages/herdr/src/downtime-worker.ts` | Worker tick: election, check-in, idle gate, dispatch |
| `packages/herdr/src/downtime-log.ts` | Coordination/dispatch rolling logs |
| `<worklog-root>/.worklog/downtime-leader.lock` | Leader lock file |
| `<worklog-root>/.worklog/downtime-leader-lease.json` | Leader lease (5-min TTL) |
| `<worklog-root>/.worklog/downtime-coordination.json` | Shared coordination list |
| `<worklog-root>/.worklog/downtime-coordination.log` | Check-ins, elections, pruning |
| `<worklog-root>/.worklog/downtime-dispatches.log` | Dispatched items |

## Troubleshooting / operations

- **No dispatches happening:** confirm a leader is elected (lease file
  present + recent `lastUpdated` refresh), the proxy reports idle for ≥ 60 s
  continuously, and the coordination list has offers. Check
  `downtime-coordination.log` for check-ins and the dispatches log for the
  last dispatch.
- **Two leaders:** impossible with `O_CREAT|O_EXCL` on one machine; if it
  appears, check for leftover stale lock files (delete
  `downtime-leader.lock` + lease to force re-election).
- **Corrupt coordination file:** read failures are treated as "missing" —
  the instance degrades to the pre-refactor no-dispatch behavior, never
  crashes. The file is safe to delete; instances rebuild it at their next
  check-in.
- **Lease expiry after a crash:** the other instances detect the stale lease
  (TTL 5 min), clean up, and re-elect automatically.

## Related

- Work item: **WL-0MST3OJ8S0001ROL** *Refactor Downtime Dispatcher: leader
  election with shared coordination file* (+ its children H3UF5/H9UT6/HA1B/
  HA7LP/HAE2/HAKDT)
- Package README: `packages/herdr/README.md` → *Downtime worker (local-LLM
  idle dispatch)*
- Docs work item: **WL-0MT76H3Z900908TV** (this page)