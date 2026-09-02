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
  herdr A ──▶   ~/.herdr/downtime/downtime-leader.lock    (single machine lock)        │
                ~/.herdr/downtime/downtime-leader-lease.json  (5-min TTL, per poll)     │
                ~/.herdr/downtime/downtime-coordination.json  (one entry per instance)  │
                │                                                                      │
  herdr B ──▶   checks in every 30 min: offers its own worklog's most-important item    │
                │                                                                      │
  leader ⊇ A     polls llama-proxy → idle gate → dispatch tiers → removes entry         │
                └──────────────────────────────────────────────────────────────────────┘
```

### Leader election (file lock + lease)

- The first instance to atomically create
  `~/.herdr/downtime/downtime-leader.lock` (or `HERDR_COORDINATION_DIR` override,
  see `machine-coordination.ts`) (`O_CREAT|O_EXCL`) becomes the single
  machine-wide leader (one election, one lease — `leader-election.ts`,
  WL-0MTF0KLO10043YAN F3 + F6 migration authoritative). Per-worklog
  `<worklog-root>/.worklog/downtime-leader.lock` is retired — stale files
  are ignored (no double-election, stable instanceId → single machine entry).
- The leader holds a **5-minute lease**
  (`DEFAULT_LEASE_TTL_SECONDS = 300`) written to
  `~/.herdr/downtime/downtime-leader-lease.json` (same machine dir), refreshed on every proxy-poll cycle
  **and during the no-candidate cooldown pause** — an owned-but-EXPIRED
  lease is still renewed (`refreshLease()` is ownership-based, not
  validity-based: a lease with `leaderId === instanceId` is rewritten with a
  fresh `acquiredAt` regardless of remaining TTL).
- Leadership is **re-derived every tick** (a single cheap lease-file read):
  a lease that expires mid-pause (tick loop stalled in the cooldown) routes
  the worker out of zombie dispatch — it never polls or dispatches with
  stale cached leadership, and if another instance won the lease during the
  pause the re-derived worker yields silently (no fight, no double
  dispatch).
- If the lease expires (leader crashed or idle), a non-leader detects the
  staleness, clears the stale lock/lease, and runs a new election (with
  exponential backoff).
- **Fail-safe:** a missing/unreadable lock or lease file is treated as "no
  leader" — the instance never dispatches without a valid leased lock.

### Shared coordination file (machine-wide)

`~/.herdr/downtime/downtime-coordination.json` (or `HERDR_COORDINATION_DIR`,
WL-0MTF0KLO10043YAN) stores one entry per herdr instance — `directory` + `worklogRoot`
(the worklog root the item belongs to, so the single leader dispatches across roots):

```json
{"version":1,"entries":[
  {"instanceId":"<uuid>","workItemId":"<wl-id>","directory":"<worklog-root>","worklogRoot":"<worklog-root>",
   "assignedAt":"<iso>","lastUpdated":"<iso>"}
]}
```

Legacy per-worklog `<worklog-root>/.worklog/downtime-coordination.json` is retired
(F6 WL-0MTII4CWT00452HU): once the machine dir is authoritative, stale per-worklog
files are orphaned and ignored — the same instanceId writes exactly one machine
entry (no double-join) and the leader never double-dispatches from legacy data.
Unreadable/missing machine files degrade to "no dispatch this cycle" (fail-safe).

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
   item by tier priority — **audit → critical-first** (stage-appropriate
   intake/plan/implement, see *Critical-first tier & freeze split-by-skill*
   below) **→ non-critical implement → plan → intake** — and dispatches the
   highest-priority available item when a slot opens.
4. The dispatched entry is **removed** from the coordination file. The
   existing dispatched-marker exclusion and CAS claim mechanisms are
   preserved unchanged.
5. **Non-leaders** skip proxy polling and dispatch entirely — they only
   refresh their lease check (a cheap local file read) and their
   coordination entry.

### No-candidate cooldown & the empty offer file

The no-candidate cooldown (WL-0MSI7DQL10016QYX) pauses the worker entirely
(no poll, no idle tracking, no dispatch) for `downtimeNoCandidateCooldownMs`
(default 60 min) after a genuinely empty backlog, resetting the idle
tracker so a fresh full idle period is required after the pause. In
coordination mode (WL-0MTEZ4XZJ006Y9U7) the shared runtime file
(`.worklog/downtime-coordination.json`) is an **offer list, not the
backlog**: the leader removes each entry after dispatching (see step 4
above), so an empty file right after a dispatch is a *transient gap* while
the worklog still holds dispatchable work. Therefore:

- **Probe before pause:** a coordination-mode `no-candidate` outcome probes
  the worklog (`computeMostImportantItem`) before any cooldown. A
  genuinely empty backlog pauses exactly as in legacy mode; a probe that
  finds a candidate does NOT pause — the next check-in re-offers the work;
  a probe CLI error is a three-strike event (fail-closed — a broken
  lookup can never masquerade as an empty backlog, `deps.recordError` is
  called before any pause).
- **Check-in is never suppressed:** the cooldown gate runs AFTER the
  leader-election/check-in block, so the 30-min coordination check-in
  (the only re-offer mechanism) still lands during a pause and the leader
  lease keeps refreshing (self-healing `refreshLease()` renews an
  owned-but-expired lease — the zombie can never lose its renewal path).
  A successful re-offer
  (`checkIn.updated && offered !== null`) cancels the pause immediately.
- **Cooldown-exit renewal + re-derivation:** the first tick after the pause
  expires re-runs the leader block (self-heal refresh + per-tick leadership
  re-derivation) BEFORE reaching the cooldown gate, so every dispatch
  decision on the resume path uses lease-fresh leadership — even when the
  tick loop stalled mid-pause, the resume tick can never double-dispatch a
  foreign instance's coordination entry (zombie regression).
- **Bound achieved:** dispatch occurs at least once per `min(noCandidateCooldownMs,
  2 × checkInIntervalMs)` (60 min) whenever the worklog holds dispatchable
  work — never once per full cooldown.

### Critical-first tier & freeze split-by-skill

**Critical-first dispatch (WL-0MT3FM8VA005XBHE):** before the non-critical
implement/plan/intake tiers, the leader looks up the highest-priority open
**critical** item at ANY stage via `wl list --priority critical --status open
--json` (which — unlike `wl next` — does NOT exclude dependency-blocked
items) and dispatches it with the **stage-appropriate skill**:

- `idea` → `/skill:intake <id>`
- `intake_complete` → `/skill:plan <id>`
- `plan_complete` → `/skill:implement <id>` (only when risk ≤ Medium AND
  effort ≤ Medium — the F2 caps are retained for the implement kind)

Selection is **deterministic**: a shared round-robin cursor over the
`critical` priority group (`.worklog/downtime-round-robin.json`, see
WL-0MSSRED76008LGB6). The tier needs ≥ 1 free slot (single-pane tier) and
flows through the same `dispatchClaimedTier` pipeline as every other tier —
CAS claim with the stage-appropriate `TIER_EXPECTED` entry
(stale-claim aborts), dispatched-marker write before spawn — so the claim-
CAS, dispatched-marker change-guard, and single-flight guards compose
unchanged. The rolling-log kind is the skill-mapped
`implement`/`plan`/`intake` (never a distinct critical kind).

**Freeze split-by-skill (Q1):** while the code-freeze marker is frozen OR
ambiguous (fail-closed), a critical `plan_complete` (implement-kind)
candidate is SKIPPED — no new code changes land mid-release — but critical
`idea`/`intake_complete` (intake/plan-kind) candidates STILL dispatch: prep
work (intake/plan) is low-risk and allowed during a freeze, exactly matching
the non-critical plan/intake tiers.

**Caps retention (Q2):** a critical `plan_complete` item dispatches with
`/skill:implement` only when risk ≤ Medium AND effort ≤ Medium; an
above-caps critical item is not a valid candidate and the tier falls
through.

### Fair scheduling: global cross-project round-robin (WL-0MTJ7IEI80055V2V)

Within each tier, non-critical entries are dispatched in **global
cross-project round-robin** order, not file order. This prevents any single
project from monopolising the downtime worker when multiple projects
have offers in the coordination list.

**How it works:**

- A persistent cursor file
  (`downtime-round-robin-by-root.json`) tracks the last-dispatched
  `worklogRoot` (project) for every project that has offered work.
- On each dispatch cycle, the leader calls
  `selectLeastRecentlyServed()` to pick the **least-recently-dispatched
  project** among those with offers in the current tier.
- **New/unknown roots sort first** — a project that has never been
  dispatched is never penalised; it is served before any known root.
- After selection, the cursor is advanced: the chosen root's timestamp is
  updated to the current time and persisted atomically (tmp+rename).

**Fail-open:** a missing, corrupt, or unreadable cursor degrades to
file order (the pre-refactor behaviour) — the cursor never blocks
dispatch. Lock contention during cursor reads/writes also degrades
gracefully.

**Cursor persistence across restarts:** the cursor is written to disk
after every selection, so a leader restart picks up the most-recently
served root from the persisted file. No cursor state is lost.

**Critical override (global pre-tier):** the critical tier is evaluated
**before** the round-robin tier order. A critical entry at ANY stage
(intake/plan/implement) dispatches immediately regardless of round-robin
ordering — critical items jump ahead of all non-critical work. The
critical tier uses deterministic `sortIndex` ordering (not round-robin)
so the lowest-sortIndex critical item is always dispatched first.

**Tier priority (global):** audit → critical (pre-tier override) →
implement → plan → intake. Within each non-critical tier, round-robin
ordering applies.
**Dependency-frontier dispatch (Q3):** when the selected critical item is
dependency-blocked (`wl dep list <id>` outbound `depends-on` edges), the
worker follows the blocking chain to the nearest OPEN blocker and dispatches
THAT blocker with its own stage-appropriate skill
(intake/plan/implement). Chains bottoming out in closed/non-dispatchable/
above-caps items (or cycles) → no frontier candidate → the tier falls
through to the non-critical order.

**Fail-closed lookup:** the critical tier consults its lookup on EVERY
dispatch — including during a code freeze — and resolves through the same
`DowntimeNextResult` error channel as the other tiers: `{ok:true,
candidate:null}` is a GENUINELY empty critical tier (falls through to the
non-critical tiers); `{ok:false}` is a `wl`/parse failure — a CLI-error
strike, never a silent fall-through (a broken critical lookup can never
masquerade as "no critical work").

### Multi-worklog support (F4 cross-root + F5 single budget)

Each machine-wide entry records `worklogRoot` (preferred) + `directory` alias.
The single leader orders offers by tier priority (audit → critical →
implement → plan → intake) **across worklogRoots** and spawns each pane in
the entry's `worklogRoot`. The slot budget is machine-wide: ONE leader poll →
ONE `freeSlots` snapshot (per-slot or `available_slots`), forwarded to the sole
dispatch call — no per-worklog duplication (F5 WL-0MTII48OV008P2QU;
WL-0MT50LKAK001EF5Q single cap source). v1 scope is single-machine; a
multi-machine (real flock/NFS) extension is future work.

### Migration & legacy retirement (F6 WL-0MTII4CWT00452HU, parent AC5)

The machine dir `~/.herdr/downtime/` (or `HERDR_COORDINATION_DIR`) is
**authoritative** once provisioned. Legacy per-worklog
`downtime-coordination.json` / `downtime-leader.lock` /
`downtime-leader-lease.json` files are no longer written and are not read
as fallback — they are orphaned and ignored. Guarantees:

- No double-dispatch or double-join: stable `instanceId` writes exactly
  one machine entry regardless of stale legacy file presence.
- Fail-safe: unreadable/missing machine coordination or lease files
  degrade to "no dispatch this cycle" — never crash, never drop another
  entry.
- Dispatch/coordination **logs** (`downtime-dispatches.log`,
  `downtime-coordination.log`) remain per worklog root (retained location)
  for per-project observability; they are not migrated — stale per-worklog
  coordination files do not imply log migration.

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
| No-candidate cooldown | 60 min (`downtimeNoCandidateCooldownMs`; probe-before-pause in coordination mode, re-offer cancels) | `downtime-worker.ts` |

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
  appears, check for leftover stale lock files — delete the **machine-dir**
  `~/.herdr/downtime/downtime-leader.lock` + lease to force re-election (per-
  worklog `.worklog/` stale locks are orphaned and no longer consulted after
  the F6 migration).
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
- Work item: **WL-0MTF0KLO10043YAN** *Single machine-wide downtime leader
  across all worklogs* (+ F1 resolver / F2 shared file with worklogRoot / F3
  machine-wide election / F4 cross-root dispatch / F5 global slot budget /
  F6 migration & legacy retirement / F7 docs+green)
- Work item: **WL-0MT3FM8VA005XBHE** *Downtime dispatcher: critical items
  always progress first regardless of stage* (critical-first tier + freeze
  split-by-skill + caps retention + dependency-frontier dispatch)
- Package README: `packages/herdr/README.md` → *Downtime worker (local-LLM
  idle dispatch)*
- Docs work item: **WL-0MT76H3Z900908TV** (this page)