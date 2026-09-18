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

## Ranking contract (WL-0MTK1ILM2009QYB2) — dispatcher == Herdr list head

The downtime dispatcher does **not** maintain its own ranking. The Herdr selection list
(`packages/herdr/src/fetcher.ts:fetchNextItems` → `smart-selection.ts:selectWorkItems` →
`grouping.ts:regroupWorkItems`) is the **sole** ranking path (mandatory-always for critical +
`completed`/`in_review`, `browseItemCount` windowing of "other" items, grouping logic,
`reSort`/`computeScore` as used by the fetcher). The dispatcher (`dispatchDowntimeWork`,
and the coordination leader path `dispatchFromCoordination`) derives
its candidate from the **Herdr list head** (first ordered item) and applies every remaining
safety gate as a **sequential filter** on that ordered sequence (scheduled-prompt → code-freeze
→ producer-review gate (WL-0MTIAL65N004T22F) → dispatched-marker → free-slot minimums →
active-audit single-flight → freshness/recency → CAS claim → spawn). **Critical escalation
(WL-0MU6UL3XY001M3VT):** before the normal sequence walk, open critical items in the head are
escalated by `selectCriticalFirstCandidates` — a blocked critical item bypasses the NON-safety
filters (dispatched-marker, review-queue hold) while the safety gates above still apply — so
critical work is never starved by lower-priority items occupying the window (see the
*Critical-first tier* section). If no head item passes the filters, the dispatcher reports
"no candidate" rather than falling back to a second ranking.
No `wl next`/database scoring change is required; the observable contract is
"dispatcher == Herdr list head".

### Extended dispatch window (WL-0MU6UL3GQ0015AA5)

The Herdr head is **windowed**: mandatory items (critical + `completed`/`in_review`) are
always included and consume window slots, and the remaining slots are filled from "other"
items. When the mandatory set is large, the first genuinely dispatchable candidate can fall
**outside** the window — the 2026-09-18 incident (a 30-item head whose only dispatchable
item was the 22nd "other") left the machine with **zero dispatches for 31 h** while a
healthy backlog existed. The dispatcher therefore **extends the dispatch window when the
head yields no candidate**:

- It re-reads the **same ranking path** (`fetchNextItems` → `selectWorkItems` →
  `regroupWorkItems`) with a bounded larger count and skips the items already seen — a
  **window extension, never a second ranking**. Ordering is unchanged; only more "other"
  items become visible.
- The extension is bounded by `DOWNTIME_DISPATCH_EXTEND_MAX` (`downtime-worker.ts`, 30): at
  most `head length + 30` items are scanned per dispatch cycle (a default 30-item head
  therefore scans at most 60 items).
- The extension runs on **both** dispatch paths — `dispatchDowntimeWork` (direct dispatch)
  and `computeMostImportantItem` (the coordination check-in offer) — so an instance never
  offers "nothing" while its backlog holds dispatchable work.
- The **TUI worklist is unchanged**: it keeps rendering exactly `browseItemCount` items
  (clamped 1–50). The extension is dispatch-only.
- **Fail-open:** a failed/empty extended lookup degrades to the original terminal reason, so
  the extension can never convert a defined outcome into a new failure.

Because of the extension, the **"no candidate" contract applies only to a genuinely empty
dispatchable backlog** (or a backlog fully blocked by a safety gate) — not to an item hidden
beyond the `browseItemCount` window. Other terminal reasons (code-freeze, `audit-in-flight`,
`fresh-audit-skip`, `review-queue-hold`, `wl-error`) keep their existing semantics.

**Coordination leader (F3, WL-0MTK1ILM2009QYB2):** the shared coordination file holds ONE
entry per instance — an **offer** of that instance's own Herdr list head (computed at the
owner's check-in by `computeMostImportantItem`, which walks the same Herdr sequence with the
same filters). The leader dispatches offers in **file order** and re-validates each offer at
dispatch time (`fetchItem` + `classifyItemForDispatch` as sequential filters, no wall-clock
prune). The cross-root **tier priority** (audit → critical → implement → plan → intake), the
**global critical override** and the per-`worklogRoot` **round-robin cursor ordering** are
**retired** from the leader dispatch path — they were a second ranking and are removed by
WL-0MTK1ILM2009QYB2 AC1–2. Per-root "critical first" is preserved *by construction*: the
Herdr list (smart-selection) orders critical items first, so a root's critical head is what
its check-in offers. The retired cursor helpers (`sortEntriesByRoundRobin`,
`advanceRoundRobinCursor`, `COORDINATION_TIER_ORDER`, `coordinationTierRank`) remain
exported for the module tests only — nothing on the dispatch path calls them.

**Agreement sampling (F2):** `npm run sample:downtime-agreement [<worklog-root>]`
(`scripts/downtime-agreement-sample.ts`) proves the contract on a live worklog root: it
computes the downtime pick from the production `fetchNextItems` sequence + dispatcher
filters and asserts the pick is the Herdr head whenever the head is dispatchable (and
reports explicitly when a filter moves the pick deeper in the SAME sequence).

## Architecture

```
                ┌─────────────────────────── single machine ───────────────────────────┐
                │                                                                      │
  herdr A ──▶   ~/.herdr/downtime/downtime-leader.lock    (single machine lock)        │
                ~/.herdr/downtime/downtime-leader-lease.json  (5-min TTL, per poll)     │
                ~/.herdr/downtime/downtime-coordination.json  (one entry per instance)  │
                │                                                                      │
  herdr B ──▶   checks in every 5 min (WL-0MTMPSCL8000O45H): offers its own most-important item  │
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

Lifecycle (`packages/herdr/src/coordination.ts`, WL-0MTMPIQBE001J41P non-expiring contract):

1. **Check-in** — every instance reads the file on startup; leaders re-offer every ~4 minutes
   (`DEFAULT_LEADER_CHECK_IN_MS = 4 min`) and followers every 5 minutes
   (`DEFAULT_COORDINATION_CHECK_IN_MS`, WL-0MTMPSCL8000O45H — was 30 min, clamped ≥ 60 s),
   recomputing their worklog's **most-important item** (or removing their entry on a genuinely empty backlog / `wl` error fail-open — entry retained) and upserting (`add` if absent, `update` if changed). When the leader removes an entry on dispatch, the owning instance re-offers **immediately** on its next tick (observed missing-own-entry, no extra poll loop; fail-open on unreadable file degrades to next interval — WL-0MTMPSCL8000O45H AC2). The leader also renews the lease inside its 5-min TTL (`DEFAULT_LEASE_TTL_SECONDS = 300`) on the same cadence. Leadership is re-derived every tick from the lease file; a missing/unreadable coordination or lease file is fail-safe (no dispatch that cycle, never a crash, check-in cadence does not spin-loop on errors).
2. **Dispatch** — the leader validates eligibility **at dispatch time** (`fetchItem(workItemId, worklogRoot)` → `classifyItemForDispatch` / `isAuditFresh` / stage+status) as the **sole gate**. A non-dispatchable entry (closed/in_progress/done, audit-now-fresh, `needsProducerReview === true`, above-caps plan_complete, or otherwise `classifyItemForDispatch(...) === null`) is removed eagerly via `removeEntry` **without** advancing the round-robin cursor (`advanceRoundRobinCursor` only on successful dispatch), without spawning a pane or writing a dispatched marker, and the tier loop **continues to the next entry**. Entries do **not** expire by wall-clock age.
3. **Pruning — retired (WL-0MTMPIQBE001J41P)** — wall-clock TTL pruning on `lastUpdated` is removed (`pruneStaleEntries` is a no-op returning `0`, no age-based removal on the machine `downtime-coordination.json` or legacy per-worklog file). Coordination operations (check-ins, elections/takeovers, eligibility drops) are recorded in `.worklog/downtime-coordination.log`; coordination log records are separate from the dispatch log.

### Leader-only dispatch

1. Only the leader polls the llama-proxy status and observes the **idle
   gate** (continuous idle for the configured threshold — see timings
   below).
2. When a **scheduled prompt** is due, it dispatches immediately
   (WL-0MSS1Q5ER007QDKX).
3. Otherwise the leader reads the coordination OFFER list and dispatches the
   first offer in **file order** that passes the dispatch-time filters
   (`fetchItem(workItemId, worklogRoot)` → `classifyItemForDispatch` +
   producer-review gate + code-freeze split-by-skill + free-slot minimums;
   see *Ranking contract* above — the cross-root tier priority / critical
   override / round-robin ordering are retired by WL-0MTK1ILM2009QYB2).
   Each entry is eligibility re-checked at dispatch time; stale entries are
   dropped (removed) without a pane or marker (see Lifecycle §2). When a slot
   opens the first passing offer dispatches in the entry's `worklogRoot`.
4. The dispatched entry is **removed** from the coordination file. The
   existing dispatched-marker exclusion and CAS claim mechanisms are
   preserved unchanged.
5. **Non-leaders** skip proxy polling and dispatch entirely — they only
   refresh their lease check (a cheap local file read) and their
   coordination entry.

### Retired-stage recovery (WL-0MTYL7DX9000MZOH)

The `in_progress` **stage** was removed from the valid stage set
(WL-0MTOHS5B4001Y9FX) but legacy rows still carry it. Such an **open** row is
dispatchable via the `risk-effort` recovery tier
(`classifyItemForDispatch` maps `stage === 'in_progress'` → `risk-effort`,
WL-0MTTSWCJR003OMN7). The recovery claim is race-safe and self-migrating:

- `claimItem` (→ `claimWorkItem`) CASes on the item's **actual** retired
  stage (`--if-status open --if-stage in_progress`) and atomically advances
  the stored stage to the tier's target (`--stage plan_complete`).
- `wl update` validates **only the fields the update writes**: an unchanged
  legacy stage no longer aborts a status-only update (`Invalid stage
  \"in_progress\"`), so the claim can never be mistaken for a hard
  `wl-error` strike.
- Recovery is **contained**: a retired-stage offer that dispatches (or loses
  its CAS race → neutral `claim-failed`) never blocks the offers behind it —
  the leader continues to the next entry (never a 60-min pause for one bad
  row).
- `wl doctor --fix` migrates leftover retired-stage rows to `plan_complete`
  automatically when `plan_complete` is compatible with the row's status
  (open / in-progress / blocked / deleted). A status that does not admit
  `plan_complete` (e.g. `completed`) is left for manual review rather than
  migrated into another invalid combination.

### Failed-dispatch claim recovery (WL-0MT32F908002YFFA)

The dispatch pipeline is CAS claim → marker write → spawn. Two failure
points can leave the claim stranded with no agent working the item; both
are now recovered automatically:

- **`marker-write-failed`** (the marker write failed AFTER the successful
  claim): `dispatchClaimedTier` calls `rollbackClaim` (→
  `rollbackClaimWorkItem`) to reverse the CAS transition —
  `--status <pre-claim status> --if-status in_progress [--if-stage
  <pre-claim stage> --stage <pre-claim stage>]`. Plan/intake/implement/
  risk-effort roll back to `open` at the original stage; the audit tier
  rolls back to `completed`/`in_review` so the item stays in the audit
  queue. A successful rollback reports the neutral outcome
  `claim-rolled-back`; a stale/failed rollback (a concurrent human/agent
  already moved the item) reports `marker-write-failed` and leaves the item
  untouched (fail-closed).
- **`spawn-failed`** (the pane never appeared after the marker was written):
  the failure trace (`outcome: 'spawn-failed'`) is appended to the rolling
  log, the claim is rolled back the same way, and the spawn-failed entry is
  **excluded from every dispatched-marker reader** (`dispatchedItemIds`,
  `dispatchedItemMarkers`, `dispatchedItemStages`, `recentDispatchedItemIds`) — a failed spawn is not
  a success, so it never permanently excludes the item. The outcome remains
  `spawn-failed` (not success); the item is re-selectable on the next idle
  period (immediate re-dispatch — the CAS claim still serializes concurrent
  panes).

A STANDING success marker (no `outcome`) excludes the item for its tier **for a bounded lifetime**, so a dispatched item is never double-dispatched while its pane may still be running — and never stranded forever if it is not (see below).

### Success-marker lifetime (WL-0MU6UL0RJ008IHGT)

A marker is written **before** the pane spawns to prevent duplicate dispatch, and its readers exclude the item **while the item remains at the marker's dispatched-at stage**. That is correct for a healthy run (the agent advances the item and the stage change releases the marker), but a pane that spawns successfully and never advances the item — a crash, a manual close, a silent failure, or an agent that exits without progressing — left the marker standing **forever**. The item became permanently invisible to the tier that would retry it and could only leave the stage by completing the very step that would never be scheduled: a deadlock.

`markerStillExcludes` (`packages/herdr/src/downtime-log.ts`) now applies a **staleness window** in addition to the stage change-guard. A success marker excludes its item only while BOTH hold:

1. the item is **still at the marker's dispatched-at stage** (`itemStage === marker.stage`), and
2. the marker is **fresh** — its age (`now − dispatchedAt`) is **≤** `downtimeMarkerStaleWindowMs`.

Otherwise the marker is released and the item becomes re-selectable:

- **Stage advanced** → released exactly as before (no behaviour change for healthy flow).
- **Stage unchanged, marker stale** (age **exceeds** the window) → released, so a stranded item is re-dispatched within one idle cycle with no manual intervention.
- **`dispatchedAt` missing or unparseable** → **fail-closed** (keeps excluding): freshness cannot be proven, so duplicate-dispatch protection is never weakened.

| Tier(s) | Reader / mode | Missing-stage (legacy) marker |
|---|---|---|
| plan / intake / risk-effort | `dispatchedItemMarkers` + `stage-guard` | Released (historical change-guard semantics) |
| audit / implement | `dispatchedItemMarkers` + `id-guard` | Keeps excluding while fresh, released by the age TTL |

**Configuration.** `downtimeMarkerStaleWindowMs` is a plugin setting (default **24 h**, `DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS`), clamped by `clampDowntimeMarkerStaleWindowMs` to **[1 h, 7 days]**: the floor prevents the release firing while a freshly dispatched pane is plausibly still running; the ceiling bounds how long a stranded item can be excluded. It is re-read from settings every tick (live), wired through `DowntimeWorkerConfig.config().markerStaleWindowMs` into `dispatchDowntimeWork`, `computeMostImportantItem` and the coordination check-in.

Spawn-failed entries (`outcome: 'spawn-failed'`) remain **non-excluding unconditionally** (a failed spawn is not a success), as before.

**Scope note.** The staleness release is implemented in the marker reader
(`dispatchedItemMarkers` / `markerStillExcludes`) and applied on the live
production dispatch paths — `dispatchFromHerdrList` (direct Herdr-head
dispatch), `computeMostImportantItem` (coordination offers) and the
coordination check-in. The legacy per-tier lookup chain in
`dispatchDowntimeWork` (retained for test compatibility, reached only when
the Herdr head is genuinely empty — production-unreachable, see
downtime-worker.ts) keeps the historical change-guard semantics unchanged.

### Dispatcher workspace anchor (C0 WL-0MTR01EU7005SYZG — anchor-by-ID)

Automated downtime dispatches always spawn in a **dedicated Dispatcher workspace**
so panes never land in the leader's project workspace (e.g. Podcast `wR`).
Invariant: every `dispatchClaimedTier` / `dispatchFromCoordination` /
`dispatchScheduledPrompt` spawn that completes (`buildDowntimePaneArgs` →
`send-to-pi.sh`) creates its pane by **splitting the persisted Dispatcher
anchor pane** (`--anchor <paneId>`), verified via `herdr pane list` — every
`Downtime triggered …` pane's `workspace_id` equals the Dispatcher workspace.

Lifecycle (`packages/herdr/src/dispatcher-anchor.ts`, F1 WL-0MTR2CD4X006XI7U):

- **Persistence:** machine coordination dir (`~/.herdr/downtime/` or
  `HERDR_COORDINATION_DIR`, `machine-coordination.ts`) file
  `downtime-dispatch-anchor.json` — `{ paneId, workspaceId }` (atomic
  tmp+rename, `fs.renameSync`).
- **Provisioning:** `herdr workspace create --label Dispatcher --no-focus` +
  its `root_pane` is the anchor pane. Provisioning runs **under the
  coordination lock** (`tryAcquireCoordLock` on
  `~/.herdr/downtime/downtime-coordination.lock`, `O_CREAT|O_EXCL`), so
  concurrent first-dispatches produce exactly one workspace/pane (double-check
  inside the lock + raced-read fallback).
- **Validation:** `isPaneAlive(paneId)` (`herdr pane get <id>`) — when the
  persisted pane is closed, the next dispatch re-provisions under the lock
  and overwrites the file. An `isPaneAlive` throw is fail-closed (`null`).
- **Resolution (wiring, F2 WL-0MTR2HLLJ009PTPJ):** `createDowntimeDeps` wires
  `defaultDispatcherAnchorResolver` (`src/index.ts` — `resolveDispatcherAnchor`
  with `createDispatcherAnchorDeps(cwd, herdrBin)` inside a `try/catch` →
  `null`). All three dispatch entry points check
  `typeof deps.getDispatcherAnchor === 'function'`; `null` → neutral
  `{ dispatched: false, reason: 'anchor-unavailable' }` — **no pane or marker,
  never a fallback to `pane current`** (fail-closed `"no dispatch this
  cycle"`). The resolved `anchorId` flows via `spawnAgentPane` →
  `buildDowntimePaneArgs` → `--anchor <id>` → `send-to-pi.sh` (`herdr pane
  split --pane <anchor>`) and `grid.py <anchor>` — `send-to-pi.sh` skips the
  `pane current` lookup entirely in anchor mode, and the split does not
  steal focus (`--no-focus` preserved).
- **Coordination leader:** `dispatchFromCoordination` resolves the anchor
  once per tick (machine-wide); `anchor-unavailable` stops the tier loop
  immediately — no other offer can spawn without the machine-wide anchor.

Duplicate workspaces: the anchor **file** is the authority, not the workspace
label count. Multiple `Dispatcher`-labelled workspaces are harmless — only the
`workspaceId` in `downtime-dispatch-anchor.json` is the live anchor. Surplus
idle `Dispatcher` workspaces can be closed when their panes finish
(`herdr workspace close <id>` one at a time); do not disturb active dispatch
panes.

### Per-project tabs in the Dispatcher workspace (C1 WL-0MTRQT482001SNXC)

Within the single `Dispatcher` workspace, each **work-item prefix** gets its
own tab so overnight runs for different projects never intermix in one grid.
For a candidate whose id is `<PREFIX>-<hash>`, `<PREFIX>` is the substring
before the first `-` (case preserved, no normalisation): `WL-…` → tab `WL`,
`TCE-…` → tab `TCE`, `CG-…` → tab `CG`. Automated downtime dispatches only —
manual `open-worklist` / `open-pi-agent` flows keep their current-pane/tab
behaviour, and scheduled-prompt panes (no work item) keep the C0 single
anchor.

Invariant: every `dispatchClaimedTier` spawn for a worklog item resolves the
per-prefix tab anchor and forwards its anchor pane id via `spawnAgentPane` →
`buildDowntimePaneArgs` → `--anchor <paneId>` → `send-to-pi.sh`, so the pane
lands in `<PREFIX>`'s tab. Verified with `herdr tab list` (the tab's label is
exactly the prefix) and `herdr pane list` (each `Downtime triggered …` pane's
`tab_id` equals the prefix tab's `tab_id`, `cwd` equals the item's worklog
root).

Lifecycle (`packages/herdr/src/dispatcher-anchor.ts`, C1):

- **Resolver:** `getDispatcherTabAnchor(cwd, deps, prefix)` — fast-path reuse
  of a persisted live entry, else ensure the `Dispatcher` workspace (via
  `getDispatcherAnchor`, reused not duplicated), then under the coordination
  lock double-check the persisted map, adopt an existing matching tab, or
  create one. Returns `{ workspaceId, tabId, paneId }` or `null` (fail-closed).
- **Persistence:** machine coordination dir file
  `downtime-dispatch-tab-anchors.json` —
  `{ workspaceId, byPrefix: { "<PREFIX>": { tabId, paneId } } }` (atomic
  tmp+rename). This map is the authority for reuse. Missing file → empty map
  (inheriting the legacy anchor's `workspaceId` when present); corrupt JSON →
  `null` (re-provision).
- **Provisioning:** `herdr tab create --workspace <id> --label <PREFIX>
  --no-focus`; the returned `tab_id` + `root_pane.pane_id` are the tab anchor.
  Runs **under the coordination lock** (`tryAcquireCoordLock` on
  `~/.herdr/downtime/downtime-coordination.lock`) with a double-check inside
  the lock, so concurrent first-dispatches for the same new prefix create the
  tab exactly once.
- **Validation:** the tab's anchor pane is checked with `isPaneAlive`
  (`herdr pane get <id>`). A stale persisted entry (dead/missing pane) is
  re-provisioned on the next dispatch for that prefix; a matching tab that
  still hosts a live pane is adopted and re-persisted (e.g. after the anchor
  file was lost).
- **Resolution (wiring, C1):** `createDowntimeDeps` wires
  `defaultDispatcherTabAnchorResolver` (`src/index.ts` —
  `resolveDispatcherTabAnchor` with `createDispatcherAnchorDeps(cwd, herdrBin)`
  inside a `try/catch` → `null`). `dispatchClaimedTier` derives
  `candidate.id.split('-', 1)[0]` and, when the resolver is present, uses it
  **instead of** the legacy single anchor; a `null` result → neutral
  `{ dispatched: false, reason: 'anchor-unavailable' }` — **never a fallback
  to the legacy single anchor, another tab, or the leader's pane**.
- **CLI shape tolerance:** `tab list` / `tab create` / `pane list` parsers
  accept `tab_id`/`tabId`/`id`, `pane_id`/`paneId`/`id`, `label`/`title`, a
  nested `result` envelope, and log lines before the JSON. A parse failure is
  **fail-closed** (`null` → `anchor-unavailable`) and logs the raw output — it
  is never silently read as "no tab exists", which would duplicate tabs.

Duplicate tabs: the persisted `byPrefix` map is the authority. If a prefix tab
must be reset, close it (`herdr tab close <tabId>`) and delete or edit its
entry in `downtime-dispatch-tab-anchors.json`; the next dispatch for that
prefix re-creates the tab under the lock.

### No-candidate cooldown & the empty offer file

The no-candidate cooldown (WL-0MSI7DQL10016QYX) pauses the worker entirely
(no poll, no idle tracking, no dispatch) for `downtimeNoCandidateCooldownMs`
(default 60 min) after a genuinely empty backlog, resetting the idle
tracker so a fresh full idle period is required after the pause. The
**extended dispatch window** (WL-0MU6UL3GQ0015AA5, see *Ranking contract*
above) guarantees a `no-candidate` outcome means the *whole* bounded
dispatch backlog — not merely the initial head — held nothing dispatchable:
the window is extended at least to the first dispatchable candidate, up to
`DOWNTIME_DISPATCH_EXTEND_MAX` additional items, before `no-candidate` is
reported. In
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
  leader-election/check-in block, so the coordination check-in
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

### Producer-review gate (WL-0MTIAL65N004T22F)

Every dispatch tier — audit, critical (including its dependency-frontier walk), implement,
plan, and intake — excludes items with `needsProducerReview === true`. Classification
(`classifyItemForDispatch`) and every `select*` helper check strict `=== true` only, so
absent/false/undefined remain dispatchable. Parsers preserve the flag via `Boolean(...)`
coercion; a missing or unparseable field never crashes the dispatcher. The coordination
leader path equally skips review-gated entries (retaining them for later re-offer after the
flag is cleared). The filter report is "no candidate" (not a `wl-error` strike) and the
no-candidate cooldown is not triggered while review-gated work exists.

### Review-queue depth gate — producer review policy (WL-0MT2UQWOR007CYY9; live-path rewire WL-0MTTSWC1X005P4VD)

The **producer review policy**: while the root-only `completed`/`in_review` queue is deep
(at/over `browseItemCount`, default 20), new NON-CRITICAL `implement` work is held back so
the review bottleneck can drain; audits (the queue drain), `plan`, `intake`, scheduled
prompts and **critical** implements flow unconditionally. A deep queue with nothing
audit-needed reports the neutral reason **`review-queue-hold`** (never `no-candidate`), so
the no-candidate cooldown is never entered while the queue drains and polling resumes the
moment the queue thins.

- **Counting:** root-only `wl list --status completed --stage in_review --root-only --json`
  per worklog root; `browseItemCount` is re-read live from settings each dispatch
  (`DEFAULT_BROWSE_ITEM_COUNT = 20`). **Fail-closed:** a count-query failure activates the
  gate (only critical implements remain eligible) — same convention as the code-freeze
  "ambiguous ⇒ frozen" rule.
- **Shared gate implementation** (`readReviewQueueGate` / `isImplementHeldByReviewGate` in
  `downtime-worker.ts`): ONE bounded `wl list` per dispatch/offer computation, applied
  identically on every dispatch path — `dispatchFromHerdrList` (direct Herdr-head
dispatch), `computeMostImportantItem` (coordination check-in offer) and
  `dispatchFromCoordination` (leader dispatch, gated per **offer's own root** via the
  per-root count — `createDowntimeDeps.getReviewQueueCount` targets the passed root with
  `buildWlArgsForRoot`). The legacy tier chain (test-compat fallback) consumes the same
  shared read rather than a second call site. A held implement entry is KEPT (never
  removed/dropped like a freeze or stale offer) so dispatch resumes the moment the queue
  thins.
- **Neutral reason semantics:** `review-queue-hold` is treated by the worker exactly like
  the code-freeze skip — no strike, no cooldown, keep polling. In coordination mode the
  no-candidate probe (WL-0MTEZ4XZJ006Y9U7) treats a `reviewQueueHold` result as
  "not an empty backlog" (no pause); `runCoordinationCheckIn` removes the own entry when
  only held implements remain (nothing offerable) and re-offers on the periodic cadence.

#### Sprint-complete auto-disable REMOVED (RCA root cause A, WL-0MTTSWC1X005P4VD)

Sep 8→9 the sprint-complete auto-disable (parent WL-0MTHSHN5V008R5L0) wrote the
`.herdr-downtime-disabled` marker and **early-returned before leader-election/check-in**
when root-only `completed/in_review` reached `browseItemCount`, halting ALL dispatch AND
check-ins — ContextHub went silent ~21:53Z→07:11Z with zero log lines. That auto-disable is
**removed** from the worker tick; queue depth must never stop audits, plan, intake, critical
implements or coordination check-ins. The `.herdr-downtime-disabled` marker is now written
ONLY by the manual `d` toggle (per-instance durable disable, WL-0MT5SFP990001FNW) and is
honoured live and across restarts — it is never derived from queue depth. The worklist
header's "sprint complete" banner is display-only (a review-queue-depth indicator); it no
longer writes/clears the marker. If a genuinely distinct sprint-complete signal is ever
desired it must be a separate, explicit mechanism (follow-up, out of scope here).

### Critical-first tier & freeze split-by-skill

> **Scope note (WL-0MTK1ILM2009QYB2):** "critical first" now lives INSIDE the
> Herdr ranking — smart-selection orders critical items at the head of every
> root's Herdr list, so the dispatcher's first-classifyable list item IS the
> critical item whenever the root has one (no separate critical lookup or
> global pre-tier override remains on either dispatch path). The historical
> leader-side critical lookup described below was retired with the
> coordination tier ordering; the freeze split-by-skill rule below still
> applies verbatim as a sequential filter (frozen → audit/implement offers
> and candidates are skipped, plan/intake still dispatch).

**Critical escalation in the Herdr-head contract (WL-0MU6UL3XY001M3VT).**
Critical items are mandatory-always in the Herdr head, but a *non-safety*
filter can still exclude one from dispatch — most notoriously a **stale
dispatched marker** (a previous dispatch was rolled back / the implementing
agent aborted and reset the item to `open` while the standing marker
remained). Before Herdr-head migration (WL-0MTK1ILM2009QYB2) the legacy
critical-first tier re-looked-up the highest-priority open critical item
from outside the head; that tier is unreachable today because the head is
never empty. The result was silent starvation: a critical item blocked by a
stale marker (or the review-queue hold) sat indefinitely while
lower-priority work consumed each idle window (2026-09-18 RCA: three open
critical items undispatched for 30+ hours).

What the contract now guarantees:

1. **Non-safety filters are bypassed for critical work.** Within one idle
   cycle, the direct dispatcher (`dispatchFromHerdrList`) and the
   coordination offer computation (`computeMostImportantItem`) both run a
   **critical-first scan** over the Herdr head's open critical items
   (`selectCriticalFirstCandidates`) — deterministic lowest-`sortIndex`
   first, matching the historical critical-tier ordering — and dispatch /
   offer the first one that passes. The dispatched-marker exclusion and the
   review-queue depth hold are deliberately **not** applied to it (they are
   the non-safety filters named in AC1); the pre-dispatch CAS claim still
   serialises concurrent panes.
2. **Safety gates still block.** The scan applies ONLY the safety gates:
   `needsProducerReview === true` excludes the candidate; the code-freeze /
   ambiguous split-by-skill rule pauses audit/implement-kind candidates
   while plan/intake/risk-effort prep still dispatches (Q1); per-tier
   free-slot minimums gate the dispatch path; the CAS claim and
   per-process single-flight guards are unchanged. The active-audit
   single-flight gate remains audit-tier scoped (an open critical item is
   never audit-kind, so matching the legacy tier ordering it escalates even
   while an audit is in flight).
3. **No second ranking is introduced (AC3).** Scanning never re-ranks
   against a separate `wl list` lookup — candidates come only from the
   Herdr head, and only the critical group is re-ordered (by `sortIndex`).
   `computeMostImportantItem` returns the critical item as the instance's
   offer, so the coordination leader (which validates offers at
   dispatch-time without a marker check) dispatches it.
4. **A critical `completed`/`in_review` (audit-kind) item is out of the
   scan's scope** — it is handled by the normal audit tier, so the
   audit-freshness and active-audit gates keep acting on it unchanged.

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

> **Retired for the coordination leader (WL-0MTK1ILM2009QYB2).** The cross-root
> round-robin cursor ordering below was a *second ranking* on the dispatch path
> and is removed: the coordination leader now dispatches offers in file order
> (each offer is its root's Herdr list head). Cross-project interleaving is
> achieved by offer removal + re-offer: a dispatched root's entry is removed and
> its owner re-offers its next Herdr head at the next check-in, so the next
> cycle serves the next offer in the file. The cursor module
> (`downtime-round-robin-by-root.ts`) and `sortEntriesByRoundRobin` /
> `advanceRoundRobinCursor` remain exported only for module tests — nothing on
> the dispatch path calls them. The historical description below is retained
> for the record.

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
The single leader dispatches offers in **file order** (each offer is its root's
Herdr list head) **across worklogRoots** and spawns each pane in the entry's
`worklogRoot`. The slot budget is machine-wide: ONE leader poll →
ONE `freeSlots` snapshot (per-slot or `available_slots`), forwarded to the sole
dispatch call — no per-worklog duplication (F5 WL-0MTII48OV008P2QU;
WL-0MT50LKAK001EF5Q single cap source). v1 scope is single-machine; a
multi-machine (real flock/NFS) extension is future work.

### Owner lease, pane liveness & contention feedback (WL-0MTYZXSLN008HZOW;
    pane-count cap removed by WL-0MU2EP6JL006A1U3)

**Problem:** with a single-slot local LLM the worker over-dispatched agent
panes because the free-slot gate used the instantaneous per-tick proxy poll —
an agent on a tool call (wl, bash, tests) left the slot "free", so multiple
`Downtime triggered` panes queued on one slot (`contention_queued_count` 6,
~78 s cumulative queue time).

**Fix — the parts that remain (lease/ownership/contention):**

1. **Owner-lease gate (AC2)** — a non-null Local Proxy owner lease
   (`local_owner_session_id` / `local_owner_lease_remaining_seconds`) counts
   as "slot busy" for the dispatch decision when the worker has a live
   dispatch pane; only a truly unowned slot is dispatchable. The lease
   signal **self-heals**: proxy dispatch leases carry an `expires_at`
   (~180 s, `_get_lease_timeout_seconds`) refreshed on activity, are marked
   inactive when a stream ends, and expired records are cleaned up — so an
   idle-but-open pane stops holding a slot.
   Dispatch outcome reason: `slot-owned`.
2. **Per-slot owner tracking (AC5)** — `LlamaSlot` carries an optional
   `owner_session_id`; `countFreeUnownedSlots` excludes owned slots from the
   free count and the per-slot idle tracker resets an owned slot's timer, so
   a slot with a live lease is never considered available for a new pane.
   A single idle-but-owned slot (count-based path) fails closed via the
   derived `local_lease_active`.
3. **Contention feedback (AC6)** — the proxy's LIVE `contention_queue_depth`
   is parsed; while > 0 the dispatcher backs off with outcome reason
   `proxy-contention` until the queue drains. The sibling
   `contention_queued_count` is a CUMULATIVE counter (never decremented;
   resets only on a proxy restart) and is telemetry only — it must never
   gate dispatch (WL-0MU1DWXO600153OI: using it wedged dispatch permanently
   after the first queue event, even with depth 0).

These gates are neutral refusals — never a strike, never a cooldown — and
apply to BOTH dispatch paths (coordination leader and legacy direct chain).
The in-flight pipeline guard (`dispatch-in-flight`) remains as a same-process
safeguard bounding PIPELINES (claim → marker → spawn), not live panes.

**No client-side pane cap (WL-0MU2EP6JL006A1U3).** The
`downtimeMaxRunningPanes` setting (and its legacy alias
`downtimeMaxConcurrentDispatches`) has been **removed**, together with
`DEFAULT_DOWNTIME_MAX_RUNNING_PANES` / `clampDowntimeMaxRunningPanes`. It
counted *live panes* via `deps.getRunningDowntimePanes` and refused dispatch
at `running-panes >= cap` (reason `running-pane-cap`). Because dispatched
panes deliberately **stay open until an operator closes them**, that count
never released and the worker dispatched exactly one item per pane-close —
overnight dispatch stalled silently (a neutral refusal logs nothing).

**The local LLM idle check is the sole concurrency limiter.** Each running
agent holds a proxy slot/lease, so the free-slot idle gate already bounds
real concurrency; adding a pane count on top is both redundant and harmful.
Consequences of the removal:

- `getRunningDowntimePanes` / `countRunningDowntimePanes` remain, but feed
  **only** the `slotOwned` qualifier ("does this worker have a pane of its
  own?") so an operator's own lease does not block spare-capacity dispatch.
- A failed liveness query is now **fail-open**: it no longer blocks dispatch
  (a `herdr pane list` hiccup must not silently stop the dispatcher); the
  proxy's own lease/ownership signals still gate slot capacity.
- A settings file still carrying either removed key loads cleanly and the key
  is ignored.

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
| Leader check-in | 4 min (`DEFAULT_LEADER_CHECK_IN_MS`) — leader re-offer + lease renew inside 5-min TTL | `downtime-worker.ts`, `leader-election.ts` |
| Follower check-in | 5 min (`DEFAULT_COORDINATION_CHECK_IN_MS`, WL-0MTMPSCL8000O45H) — non-leader re-offer | `downtime-worker.ts` |
| No-candidate cooldown | 60 min (`downtimeNoCandidateCooldownMs`; probe-before-pause in coordination mode, re-offer cancels) | `downtime-worker.ts` |
| Success-marker staleness window | **24 h** (`downtimeMarkerStaleWindowMs`; clamped to 1 h – 7 d; releases a stranded success marker at an unchanged stage, WL-0MU6UL0RJ008IHGT) | `DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS`, `clampDowntimeMarkerStaleWindowMs` (`downtime-worker.ts`) |
| (removed) Max running downtime panes | **none** — no client-side pane cap; the LLM idle / free-slot check is the concurrency limiter (WL-0MU2EP6JL006A1U3) | `downtime-worker.ts` |

Both dispatch-poll and idle-threshold are configurable in the herdr plugin
settings file (`~/.config/herdr/worklog-plugin.json`,
`downtimePollIntervalMs` / `downtimeIdleThresholdMs`) and are clamped on
load (see `clampDowntimePollInterval` / `clampDowntimeIdleThresholdMs` in
`downtime-worker.ts`). The success-marker staleness window
(`downtimeMarkerStaleWindowMs`) is likewise configurable and clamped on load
(`clampDowntimeMarkerStaleWindowMs`).

## Files & runtime artifacts

| Path | Purpose |
|---|---|
| `packages/herdr/src/dispatcher-anchor.ts` | Dispatcher anchor provisioning (C0) — `getDispatcherAnchor` + per-prefix `getDispatcherTabAnchor` (C1), persistence + lock + aliveness |
| `packages/herdr/src/machine-coordination.ts` | Machine coordination dir resolver (`~/.herdr/downtime` / `HERDR_COORDINATION_DIR`) |
| `packages/herdr/src/leader-election.ts` | Lock acquisition, lease management, re-election (machine dir) |
| `packages/herdr/src/coordination.ts` | Coordination file read/write (entries, prune, upsert) — machine dir `downtime-coordination.json` |
| `packages/herdr/src/downtime-worker.ts` | Worker tick: election, check-in, idle gate, dispatch (anchor-before-claim) |
| `packages/herdr/src/downtime-log.ts` | Coordination/dispatch rolling logs (per worklog root, retained) |
| `packages/herdr/shared/send-to-pi.sh` | `--anchor <paneId>` \u2192 `herdr pane split --pane <anchor>` (no `pane current` in anchor mode); forwards `--cwd`/`--model`/`AUDIT_PHASE2_PARALLELISM` |
| `packages/herdr/shared/grid.py` | Grid rebalance around anchor pane |
| `~/.herdr/downtime/downtime-dispatch-anchor.json` | Persisted Dispatcher anchor `{ paneId, workspaceId }` (machine dir, C0) |
| `~/.herdr/downtime/downtime-dispatch-tab-anchors.json` | Persisted per-prefix tab map `{ workspaceId, byPrefix: { "<PREFIX>": { tabId, paneId } } }` (machine dir, C1) |
| `~/.herdr/downtime/downtime-leader.lock` | Leader lock file (machine dir, `O_CREAT\|O_EXCL`) |
| `~/.herdr/downtime/downtime-leader-lease.json` | Leader lease (5-min TTL, machine dir) |
| `~/.herdr/downtime/downtime-coordination.json` | Shared coordination list (machine dir, one entry per instance) |
| `~/.herdr/downtime/downtime-coordination.lock` | Coordination lock (machine dir, guards anchor provisioning + coordination writes) |
| `<worklog-root>/.worklog/downtime-leader.lock` | Legacy per-worklog lock (orphaned after F6, ignored) |
| `<worklog-root>/.worklog/downtime-coordination.log` | Check-ins, elections, pruning (per worklog, retained) |
| `<worklog-root>/.worklog/downtime-dispatches.log` | Dispatched items (per worklog, retained; includes `anchor-unavailable` neutral no-dispatch) |

## Troubleshooting / operations

- **Pane landed in project workspace (e.g. Podcast `wR`) instead of Dispatcher:** the dispatcher invariant is anchor-by-ID — every automated pane must split the persisted anchor pane. Check (a) `~/.herdr/downtime/downtime-dispatch-anchor.json` exists and `herdr pane get <paneId>` is alive and `herdr workspace list` shows its `workspaceId` labelled `Dispatcher` (stale/missing → delete the file and let the next dispatch re-provision under the coordination lock); (b) the running herdr plugin loads this repo's code — `herdr plugin list` must show `worklog-selection-list` → `local:/…/packages/herdr` (stale `dist/` or a worktree link dangles the plugin; rebuild with `npm run build` in `packages/herdr` / re-link with `herdr plugin link <main-checkout>/packages/herdr/herdr-plugin.toml`); (c) duplicate `Dispatcher` workspaces are harmless — the anchor file is the authority, not the label count — close surplus idle ones with `herdr workspace close <id>` (one at a time) without disturbing active `Downtime triggered …` panes. Incident RCA 2026-09-07: the two Podcast `wR` dispatches (`wR:p1X` CG-0MTR7DLMY 13:03:57, `wR:p1Y` WL-0MTOHS5B4001Y9FX 13:10:14) pre-dated the anchor wiring commit `69ae52f2` (14:45) and the local `packages/herdr/dist/` rebuild (15:17) — the live code at incident time had no anchor resolution path (F1 `893d6d22` added the module only, F2 wired it), so the leader fell back to the legacy `pane current` split. After the rebuild the anchor persisted at `~/.herdr/downtime/downtime-dispatch-anchor.json` (observed 15:57 `wZ:p1` → later `w0:p1`) and all subsequent downtime panes landed in `Dispatcher` (`wZ`/`w0`, including this work item's own dispatch in `wZ:p4`).
- **No `Downtime triggered …` pane but `anchor-unavailable` in logs:** the Dispatcher anchor could not be provisioned — `getDispatcherAnchor()` / `getDispatcherTabAnchor()` returned `null` (fail-closed, never a project-workspace fallback). Check `~/.herdr/downtime/` writability, coordination lock contention (`downtime-coordination.lock` held by another dispatch), the `herdr workspace create --label Dispatcher` / `herdr tab create --workspace <id> --label <PREFIX> --no-focus` JSON parse (shape drift across herdr versions), and `herdr pane get <anchor>` RPC health. The worker degrades to “no dispatch this cycle” and retries next idle tick; an empty/missing anchor file or unreadable machine dir is treated as missing (never a crash).
- **Pane landed in the wrong tab/workspace (e.g. a `TCE-…` pane in the `WL` tab, or default `1` instead of `<PREFIX>`):** the per-prefix tab invariant is anchor-by-ID. Check (a) `~/.herdr/downtime/downtime-dispatch-tab-anchors.json` has an entry for the item's prefix whose `paneId` is alive (`herdr pane get <paneId>`) and whose `tabId` still exists (`herdr tab get <tabId>`); (b) `herdr tab list --workspace <Dispatcher id>` shows a tab labelled exactly `<PREFIX>` (prefix is the id substring before the first `-`, case preserved — a `CG-…` item routes to `CG`, not `TCE`); (c) the running plugin loads this repo's code (`herdr plugin list` → `worklog-selection-list` → `local:/…/packages/herdr`; rebuild with `npm run build` in `packages/herdr` after pulling). To re-provision a prefix, close its tab (`herdr tab close <tabId>`) and delete/edit its `byPrefix` entry — the next dispatch re-creates it under the coordination lock. Duplicate tabs are harmless but stale: the persisted map is the authority.
- **No dispatches happening:** confirm a leader is elected (lease file
  present + recent `lastUpdated` refresh), the proxy reports idle for ≥ 60 s
  continuously, and the coordination list has offers. Check
  `downtime-coordination.log` for check-ins and the dispatches log for the
  last dispatch.
- **Diagnosing wl errors with per-strike logs (WL-0MTJPYM53003ORCV):**
  when the downtime worker encounters CLI errors, it now logs a **structured
  JSONL entry on every strike** (not just the third). To diagnose:

  ```bash
  # Extract all per-strike error entries for a specific time window
  grep '"message":.*consecutive' .worklog/downtime-dispatches.log \
    | jq -s '[.[] | select(.at > "2026-09-02T01:00:00" and .at < "2026-09-02T06:00:00")]' \
    | jq '.[].stderrExcerpt'
  ```

  **Distinguishing probe failures from dispatch failures:** look at the
  `probeContext` field:

  - `probeContext: "coordination-probe"` — the coordination probe failed
    (the shared coordination file check-in or offer probe errored). This
    usually indicates a worklog-root accessibility issue on the leader.
  - `probeContext: "dispatch-cli"` — the dispatch-tier `wl` lookup failed
    (e.g. `wl next` or `wl list` returned an error). This usually points
    to a worklog parsing or network issue.

  **Aggregating across machines:** in a multi-machine setup, each machine
  has its own `~/.herdr/downtime/` directory. Collect the
  `downtime-dispatches.log` from each machine's `.worklog/` directory and
  correlate by `at` timestamp to build a complete picture.

  **Key fields:** see [Log schema](#log-schema) below for all documented
  fields. The `attempt` field (1, 2, or 3) identifies the strike number;
  `stderrExcerpt` (≤ 200 chars) carries the truncated error output;
  `exitCode` (if available) is the CLI exit code.

## Log schema

### `DowntimeErrorEvent` fields (per-strike error log entries)

These fields are written to `.worklog/downtime-dispatches.log` when
`pauseAfterPersistentErrors` is called (every wl-error strike and the
three-strike pause). All fields except `message`, `at`, and `cwd` are
optional — only fields with actual data are serialized.

| Field | Type | Description |
|---|---|---|
| `message` | string | Human-readable summary (e.g. "Downtime worker: 3 consecutive wl CLI errors…") |
| `at` | string (ISO 8601) | UTC timestamp of the event |
| `cwd` | string | The worklog root directory from which the dispatch was attempted |
| `attempt` | number | Strike number (1, 2, or 3) — the sequence index of this consecutive error |
| `stderrExcerpt` | string (≤ 200 chars + `[truncated]`) | Truncated stderr output from the failing `wl` command; appended with `[truncated]` if longer than 200 chars |
| `exitCode` | number \| null | Non-zero exit code of the `wl` command, or null if not available |
| `timeoutMs` | number | Timeout in milliseconds for the failing `wl` command (typically `DOWNTIME_WL_TIMEOUT_MS = 10_000`) |
| `workItemId` | string | The work item ID being dispatched when the error occurred (may be `undefined` for coordination-probe failures) |
| `command` | string | The CLI command that failed (e.g. `wl next <stage>`, `wl list --priority critical`) |
| `probeContext` | string | One of `"coordination-probe"` (shared coordination file probe) or `"dispatch-cli"` (dispatch-tier `wl` call) |

### Rolling log trimming

The log file is bounded to the most recent 100 entries
(`DOWNTIME_LOG_MAX_ENTRIES`). Entries are appended; when the file exceeds
100 lines the first lines are truncated. All new schema fields are
preserved during trimming.

### Backward compatibility

The `DowntimeLogEntry` interface treats all new fields as optional:

```typescript
export interface DowntimeLogEntry {
  at: string;
  cwd: string;
  message: string;
  // Legacy
  error?: string;
  // Enriched (WL-0MTJPYM53003ORCV)
  stderrExcerpt?: string;
  exitCode?: number | null;
  timeoutMs?: number;
  workItemId?: string;
  command?: string;
  probeContext?: string;
  attempt?: number;
}
```

Older herdr versions reading the log will see `undefined` for the new
fields and continue to work — they simply ignore them.

- **Two leaders:** impossible with `O_CREAT|O_EXCL` on one machine; if it
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
- Work item: **WL-0MTTSWC1X005P4VD** *P2 (CRITICAL): Replace sprint-complete
  auto-disable with review policy on live path* (RCA root cause A/B2 fix —
  review-queue depth gate rewired onto the live Herdr path, sprint-complete
  auto-disable removed, marker manual-only)
- Package README: `packages/herdr/README.md` → *Downtime worker (local-LLM
  idle dispatch)*
- Docs work item: **WL-0MT76H3Z900908TV** (this page)