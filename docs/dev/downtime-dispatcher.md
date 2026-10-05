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
"dispatcher == Herdr list head". The head is fetched with the **live per-root
`browseItemCount`** limit (clamped 1–50), so the dispatcher head equals the
rendered sprint view — see *Sprint-view-only dispatch window* below.

### Sprint-view-only dispatch window (WL-0MUNS8X97007C9H9)

The dispatcher head **is** the sprint view. Both selection paths pass the live
per-root `browseItemCount` setting — clamped to the supported `1`–`50` range by
`resolveSprintViewWindow` (`packages/herdr/src/browse-window.ts`), the same
clamp the TUI worklist applies — as the `getHerdrListHead` limit:

- `dispatchDowntimeWork` (direct dispatch), and
- `computeMostImportantItem` (the coordination check-in offer).

`getHerdrListHead` forwards the limit to `fetchNextItems(limit)`, so the head
contains exactly the items the sprint view renders (`f-s-s` → `/wl`): the
mandatory set (all `critical` plus all completed/`in_review`) and enough
"other" items to fill the remaining `browseItemCount` slots. The setting is
re-read live on every dispatch cycle, so a change applies without a restart. A
caller that passes no limit falls back to the sprint-view default (20), so an
unwindowed head is never produced.

**Non-critical work outside the view is never dispatched.** When the head
yields no candidate the dispatcher reports the terminal reason derived from the
in-view flags (`no-candidate`, `review-queue-hold`, `code-freeze`,
`fresh-audit-skip`, `audit-in-flight`, `audit-host-saturated`, `in-flight-hold`,
`wl-error`) and does **not** fall back to a second ranking or an out-of-view
non-critical scan. When every visible item is filtered by a safety gate (or the
view is empty) the outcome is a NOP.

**Critical escape hatch (defensive).** A bounded out-of-window read
(`fetchExtendedHerdrItems`, `DOWNTIME_DISPATCH_EXTEND_MAX = 30`) re-reads the
**same ranking path** with a larger window — a window extension, never a second
ranking — and returns **only** `critical` items. Because every `critical` item
is already mandatory in the view, this escape hatch is normally a no-op; it
exists purely as a safety net so a release blocker can never be windowed out.
Non-critical items beyond the sprint view are filtered out, so the operator can
never be surprised by hidden-backlog dispatch. The extension runs on both
dispatch paths; the **TUI worklist is unchanged** (it keeps rendering exactly
`browseItemCount` items, plus the mandatory set).

**Supersedes WL-0MU6UL3GQ0015AA5 AC1/AC4.** That item widened the non-critical
window to prevent a 31-hour starvation incident. This item deliberately reverses
the non-critical part of that behaviour: the dispatch window now tracks the
operator-curated sprint view. The accepted trade-off (recorded on
WL-0MUNS8X97007C9H9) is that if every visible item is blocked and the only
dispatchable item lies beyond `browseItemCount`, the dispatcher no-ops —
mitigated operationally by raising `browseItemCount` (up to 50) or clearing a
blocker. The WL-0MU6UL3GQ0015AA5 starvation regression now asserts this NOP
behaviour rather than a dispatch.

**Fail-open preserved.** A failed head lookup still resolves `{ok:false}` (the
caller keeps its entry / reports `wl-error`); a failed or empty extended
critical read degrades to the original terminal reason, so the escape hatch can
never convert a defined outcome into a new failure.

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

### Non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5)

A dispatched session can end **without reaching a terminal stage** — the
agent exits, the pane is closed by the reaper, or the audit ends with no
recorded result. Those closes are recorded in the rolling dispatch log as
`entryType: 'pane-close'` entries carrying a `reasonCode`
(`agent-ended-no-terminal`, `audit-ended-no-result`, `producer-review`,
`risk-effort-incomplete`, …). Before this control, such an item became
re-eligible as soon as the dispatched success-marker was released, so a
repeatedly failing session could be re-selected on the very next idle cycle
and burn local-LLM slots in a tight loop.

`isNonTerminalCooldownActive` (`packages/herdr/src/downtime-log.ts`) is a
**neutral, sequential filter** that excludes an item from re-dispatch of the
**same kind** for a minimum cooldown after its most recent pane closed
non-terminally. It is applied at the same point as the other non-safety
filters — after the dispatched-marker exclusion and before the code-freeze
gate — on every dispatch path:

- `dispatchFromHerdrList` (direct Herdr-head dispatch),
- `computeMostImportantItem` (coordination offer computation),
- `dispatchFromCoordination` (leader dispatch of a remote offer).

The filter consults the **most recent** `pane-close` entry for the
`(itemId, kind)` pair and holds the item only while **all** of the following
hold:

1. the close was **non-terminal** — its `reasonCode` is not in the terminal
   set `{none, reached-in-review}` (`none` covers
   `closed-as-intake-complete` / `closed-as-plan-complete` / `audit-passed` /
   `audit-failed`; `reached-in-review` is the implement-pane success close).
   Any other/absent code is treated as non-terminal (fail-closed);
2. the item has **not advanced past the close's dispatched-at stage** — the
   `stage` recorded on the close entry (written from the dispatched-at
   marker). A genuinely progressed item is released immediately (parent AC4);
3. the close is **younger than the cooldown** — `now − closeTimestamp <
   cooldownMs`.

A later terminal close supersedes an earlier failure (most-recent wins), and
a later failure re-arms the cooldown. A missing or unparseable close
timestamp **fails closed** (skip), bounded by the stage-advancement release.

**Neutral semantics.** A cooldown skip is **not** a strike and **not** a
`no-candidate`: it never counts towards the three-strike CLI-error rule and
never enters the no-candidate cooldown. The dispatch outcome carries the
distinct reason `non-terminal-cooldown` (`MostImportantItemResult` gains a
`{ok:true, nonTerminalCooldownHold:true}` variant), so a cooldown-held
backlog keeps polling rather than pausing.

**Configuration.** `downtimeNonTerminalCooldownMs` is a plugin setting
(default **30 min**, `DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS`), clamped by
`clampDowntimeNonTerminalCooldownMs` to **[1 min, 24 h]**
(`DOWNTIME_NON_TERMINAL_COOLDOWN_FLOOR_MS` / `..._MAX_MS`): the floor
prevents immediate retry, the ceiling prevents indefinite stranding. It is
re-read from settings every tick (live) and wired through
`DowntimeWorkerConfig.config().nonTerminalCooldownMs` into
`dispatchDowntimeWork`, `computeMostImportantItem`, `runCoordinationCheckIn`
and `dispatchFromCoordination`.

### Per-item, per-kind dispatch-attempt cap (WL-0MUKYEXMK0033MFK)

The dispatcher enforces a **per-`(item, kind)` attempt budget** derived from
the rolling dispatch log (`countAttempts`), so an item that repeatedly closes
non-terminally (`agent-ended-no-terminal`, `audit-ended-no-result`) cannot
consume local-LLM slots across many idle cycles without escalation.

- **Attempt count (AC1).** An attempt is a dispatch marker for the kind
  (the same predicate the success-marker readers use). Non-terminal pane
  closes count once, via the marker that opened their pane; `spawn-failed`
  traces and post-spawn `enrichment` entries are excluded (they never opened
  a pane). No new persistent store is introduced — the count is derived from
  the existing bounded log and is **fail-open**: a missing/unreadable/corrupt
  log yields 0.
- **Cap enforced (AC2).** Once the count reaches `maxAttempts`, the item is
  excluded as a sequential filter on both paths — the Herdr-list-head scan
  (`dispatchFromHerdrList`, including the critical-first scan) and the
  coordination offer/leader path (`computeMostImportantItem`,
  `dispatchFromCoordination`). The cap is evaluated after the
  duplicate-dispatch marker guard and the in-flight guard, so it never
  bypasses either.
- **Escalation (AC3).** Reaching the cap flags the item
  `needsProducerReview = true` (`markNeedsProducerReview`, backed by
  `wl reviewed <id> true`) so it surfaces for human triage. The flag is set
  at most once per dispatch cycle, and once set the existing global
  producer-review exclusion stops all further automatic dispatch.
- **Stage advancement resets (AC4).** Only markers whose dispatched-at
  `stage` equals the item's current stage count. A stage advancement leaves
  the earlier markers at the old stage, so the item gets a fresh budget at
  its new stage.
- **Neutral skip (AC5).** The skip reason is `attempt-budget-exhausted` —
  distinct from `no-candidate` and never a CLI-error strike (the worker's
  three-strike rule is unaffected; the offer computation reports the distinct
  `{ok:true, attemptBudgetHold:true}` variant so a budget-held backlog keeps
  polling).

**Configuration.** `downtimeMaxAttempts` is a plugin setting
(default **3**, `DEFAULT_DOWNTIME_MAX_ATTEMPTS`), clamped by
`clampDowntimeMaxAttempts` to **[1, 10]**
(`DOWNTIME_MAX_ATTEMPTS_MIN` / `..._MAX`). It is re-read from settings every
tick (live) and wired through `DowntimeWorkerConfig.config().maxAttempts`
into `dispatchDowntimeWork`, `computeMostImportantItem`,
`runCoordinationCheckIn` and `dispatchFromCoordination`.

### Pane placement: project workspace first, `Dispatcher` fallback (WL-0MUR5FUWD00024XN)

Automated downtime panes spawn **inside the owning project's herdr
workspace**, in a **tab labelled with the exact work-item id** (primary
path). The machine-wide `Dispatcher` workspace is only the fail-closed
**fallback** when no project plugin pane resolves for the item's root.

`dispatchClaimedTier` evaluates placement in this precedence order
(WL-0MUR5FUWD00024XN AC1):

1. **Project workspace + item-ID tab** — `resolveProjectWorkspace` resolves
   the herdr plugin pane whose logical root equals the item's worklog root
   `R`, then `getItemTabAnchor` ensures/reuses the tab labelled with the exact
   work-item id. On success the `Dispatcher` workspace is NOT used (AC2).
2. **Per-prefix tab in the `Dispatcher` workspace** — only when
   `resolveProjectWorkspace` returns `null` (no plugin pane for `R`) and
   `getDispatcherTabAnchor` is wired (AC3, AC5).
3. **Legacy single `Dispatcher` anchor** — only when neither project
   workspace nor per-prefix resolver produces an anchor (pre-C1/test callers).

A `null`/failed project-workspace resolution does **not** abort when a
fallback is wired; a project workspace that resolves but whose item-ID tab
cannot be provisioned aborts with `anchor-unavailable` (never a wrong
placement). An empty/unparseable per-prefix likewise fails closed. The
resolved anchor is forwarded as `--anchor <rootPaneId>` to `send-to-pi.sh`
(`herdr pane split --pane <anchor>`), `--no-focus` preserved; the new pane's
`workspace_id` is the project workspace (or `Dispatcher` fallback) and its
`tab_id` equals the item-ID (or prefix) tab.

#### Project workspace + item-ID tab (primary path, WL-0MU321YK70035AYT)

Invariant: for a `dispatchClaimedTier` spawn of `<PREFIX>-<hash>` whose
worklog root is `R`:

1. **Project-workspace resolution** — `resolveProjectWorkspace(cwd, deps, R)`
   enumerates the machine-wide `herdr pane list`, keeps only plugin panes
   (`label == "Work Items"`), and reads each candidate's logical project root
   from `HERDR_RESOLVED_CWD` (via `herdr pane process-info --pane <id>` →
   `shell_pid` → `/proc/<pid>/environ`). Matching is on the logical root
   ONLY — never the pane's reported `cwd`, never the workspace label.
   Ambiguity (≥2 matching panes) is deterministic: the focused pane wins, else
   the lowest pane id. Fail-closed `null` on any unreadable boundary
   (`pane list`/`process-info` failure, missing `shell_pid`, unreadable
   `/proc`, missing `HERDR_RESOLVED_CWD`, no match).
2. **Item-ID tab resolution** — `getItemTabAnchor(cwd, deps, workspaceId,
   itemId)` fast-paths an existing tab labelled exactly the work-item id
   whose root pane is alive, else creates it under the coordination lock with
   a double-check (`herdr tab create --workspace <id> --label <itemId>
   --no-focus`). No persistence file: the tab label IS the key, discovered
   via `herdr tab list`, so a second dispatch for the same item reuses the
   same tab (never a duplicate).
3. **Spawn** — `--anchor <itemTabRootPaneId>`, `--no-focus` preserved.
4. **Root-pane cleanup** — after the dispatch pane has spawned, the item
   tab's initial root pane (herdr's automatically-provisioned empty bash
   pane, used only as the split anchor) is closed, so the tab shows only the
   productive dispatch pane (WL-0MU2EOHK900425VU). Only the ROOT pane is ever
   closed: the anchor is closed unless liveness POSITIVELY confirms it is a
   live downtime dispatch pane. Liveness uses the running **downtime** pane
   ids (`paneIds`); the full machine-wide `records` set must never be used
   directly for this check because it always contains the anchor itself and
   would suppress every close. A `records`-only payload is filtered through
   `countRunningDowntimePanes`. When liveness cannot be confirmed
   (query failed/absent) the anchor is left open (fail-safe) so a running
   agent pane is never closed. On a later dispatch for the same item the
   surviving dispatch pane is the anchor and is correctly spared. The
   retained `Dispatcher` fallback anchor is deliberately exempt: closing it
   would trigger the stale-detection re-provision loop.

When the workspace resolves but the item-ID tab cannot be provisioned, the
dispatch fails closed with `anchor-unavailable` — it never places the pane in
the `Dispatcher` workspace (WL-0MU321YK70035AYT).

#### Per-prefix tabs in the Dispatcher workspace (fallback, C1, WL-0MTRQT482001SNXC)

Retained as the AC3 fallback for roots with no resolvable project workspace
(and the path used by pre-project-workspace/test callers). For such a
`<PREFIX>-<hash>` item:

1. **Prefix extraction** — `prefix = candidate.id.split('-', 1)[0]` (the raw
   substring before the first `-`, case-preserved; `WL-…` → `WL`,
   `TCE-…` → `TCE`, `CG-…` → `CG`).
2. **Per-prefix tab resolution** — `getDispatcherTabAnchor(cwd, deps, prefix)`
   ensures the single `Dispatcher` workspace exists, finds-or-creates a tab
   labelled exactly `prefix` there, and returns its root (anchor) pane.
3. **Spawn** — the pane's `workspace_id` is the `Dispatcher` workspace and its
   `tab_id` equals the prefix tab.

**Fail-safe (no fallback):** when the per-prefix resolver is reached and
returns `null`/throws, the dispatch degrades to the neutral
`{ dispatched: false, reason: 'anchor-unavailable' }` — **no pane and no
marker, never the leader's current pane, never the legacy single anchor, and
never a wrong tab**. An empty/unparseable prefix likewise fails closed.

**Idempotency & concurrency.** The persisted per-prefix map
(`~/.herdr/downtime/downtime-dispatch-tab-anchors.json`, atomic tmp+rename) is
the authority for reuse and has the shape:

```json
{
  "workspaceId": "w13",
  "byPrefix": {
    "WL":  { "tabId": "w13:t5", "paneId": "w13:p23" },
    "TCE": { "tabId": "w13:t6", "paneId": "w13:p31" }
  }
}
```

- **Fast path:** a persisted entry whose pane is alive is reused directly —
  no `herdr tab list` round-trip.
- **Stale entry:** a persisted entry whose pane is dead is ignored and
  re-provisioned on the next dispatch for that prefix.
- **Create-or-reuse:** on a cache miss the resolver lists tabs in the
  `Dispatcher` workspace and adopts a tab labelled exactly `prefix` whose root
  pane is alive.
- **Concurrent first-dispatch:** tab creation runs under the coordination
  lock (`tryAcquireCoordLock` in `~/.herdr/downtime`) with a **double-check
  inside the lock**, so two leaders racing on a previously unseen prefix
  produce exactly one tab. A holder that cannot acquire the lock re-checks
  once and otherwise fails closed (never a duplicate tab).
- **CLI drift:** `tab list`/`tab create`/`pane list` parsers tolerate the
  `tab_id`/`tabId`/`id` and `pane_id`/`paneId`/`id` key variants and a nested
  `result` envelope; an unparseable response is **fail-closed** (`null`) and
  logs the raw output (never silently treated as "no tab" → duplicate).

Lifecycle (`packages/herdr/src/dispatcher-anchor.ts`):

- **Project workspace + item-ID tab (primary):** `resolveProjectWorkspace`
  resolves the plugin pane for the item's root; `getItemTabAnchor` returns the
  anchor pane for the exact item-ID tab, creating it on first use under the
  coordination lock. After the first dispatch the tab's initial root pane is
  closed (see invariant step 4) so the tab is never left with an empty bash
  pane; a later dispatch for the same item reuses the surviving dispatch pane
  as the split anchor (WL-0MU2EOHK900425VU). The cleanup is fail-safe: it
  closes the anchor only when the running-downtime-pane liveness query
  succeeds and the anchor is absent from it — never using the full pane list,
  which would include the anchor and suppress the close. `dispatchClaimedTier`
  consults this path first whenever both deps are wired.
- **Per-prefix tab (fallback):** `getDispatcherTabAnchor(cwd, deps, prefix)`
  ensures the `Dispatcher` workspace, fast-paths the persisted live anchor,
  else lists tabs (`herdr tab list --workspace <id>`), else under the
  coordination lock (with a double-check) runs `herdr tab create --workspace
  <id> --label <prefix> --no-focus` and returns the new `tab_id` +
  `root_pane.pane_id`. Consulted only when no project workspace resolves. Its
  initial root pane is cleaned up after the first dispatch by the same
  fail-safe rule as the project item tab (step 4); the fallback
  `getDispatcherAnchor` pane is never closed.
- **Fallback anchor:** `getDispatcherAnchor(cwd, deps)` provisions one
  `Dispatcher` workspace + persisted anchor pane in the machine coordination
  dir (`~/.herdr/downtime/downtime-dispatch-anchor.json`, atomic tmp+rename,
  under the coordination lock). It is used **only** for scheduled prompts
  (which have no work-item id) and as the final fallback when neither the
  project workspace nor the per-prefix resolver yields an anchor. The
  freshly-provisioned root pane is adopted into a `Downtime` tab (`herdr pane
  move <id> --new-tab --tab-label Downtime --no-focus`, best-effort) so the
  workspace never shows a blank pane (WL-0MU2EOHK900425VU). `isPaneAlive`
  (`herdr pane get <id>`) detects a closed anchor and re-provisions.
- **Wiring:** `createDowntimeDeps` wires `defaultProjectWorkspaceResolver` /
  `defaultItemTabAnchorResolver` (primary), `defaultDispatcherTabAnchorResolver`
  (per-prefix fallback), and `defaultDispatcherAnchorResolver` (final fallback
  + scheduled prompts).

#### Troubleshooting: pane landed in the wrong tab/workspace

1. **Confirm the item's root resolves a project plugin pane** — `herdr pane
   list` must include a pane labelled `Work Items` whose process environ has
   `HERDR_RESOLVED_CWD` equal to the item's worklog root (`herdr pane
   process-info --pane <id>` → `shell_pid` → `grep HERDR_RESOLVED_CWD
   /proc/<pid>/environ`). If it does not, the dispatch intentionally falls
   back to the `Dispatcher` workspace (per-prefix tab) — run the plugin from
   the project root so the plugin pane reports the right `HERDR_RESOLVED_CWD`.
2. **Project path** — `herdr tab list --workspace <project-workspace-id>` must
   show a tab labelled exactly the work-item id, and the `Downtime triggered …`
   pane's `tab_id` must equal that tab's `tab_id` (`herdr pane list --workspace
   <id>`). A missing/wrong tab means the item-ID tab provision failed (check
   the worker log for `[worklog-plugin] Dispatcher tab create …`).
3. **Dispatcher fallback path** — when the project workspace did not resolve,
   `herdr tab list --workspace <Dispatcher-workspace-id>` must show a tab
   labelled with the item's prefix, and the pane's `tab_id` must equal it.
   Inspect `~/.herdr/downtime/downtime-dispatch-tab-anchors.json` — a stale
   `paneId` (dead) is re-provisioned on the next dispatch; a malformed file is
   treated as "no anchors yet" (tabs are rediscovered via `herdr tab list`).
4. If a dispatch reports `anchor-unavailable`, the resolved path's anchor
   could not be provisioned this cycle — the resolver deliberately does **not**
   fall back to the leader pane or (for the project path) a wrong tab; fix the
   herdr CLI/parse failure and the next idle window retries.

Duplicate `Dispatcher` workspaces are harmless — the persisted anchor file is
the authority, not the label count; close surplus idle ones one at a time
without disturbing active `Downtime triggered …` panes. Manual
`open-worklist` / `open-pi-agent` flows are unaffected (this placement applies
only to automated downtime dispatch).


### No-candidate cooldown & the empty offer file

The no-candidate cooldown (WL-0MSI7DQL10016QYX) pauses the worker entirely
(no poll, no idle tracking, no dispatch) for `downtimeNoCandidateCooldownMs`
(default 60 min) after a genuinely empty backlog, resetting the idle
tracker so a fresh full idle period is required after the pause. A
`no-candidate` outcome means the *sprint view* — the live `browseItemCount`
window (plus mandatory items) — held nothing dispatchable: the dispatcher does
not scan hidden backlog (WL-0MUNS8X97007C9H9; see *Sprint-view-only dispatch
window* above). In
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

### Host-wide audit serialisation (WL-0MUIVE0YG000UVIA)

**Problem.** On 2026-09-26 four downtime audits ran concurrently on a single host —
dispatched by *different projects' dispatchers*. The existing per-instance
active-audit single-flight (WL-0MT3PHW4I002SNOV) only reads the per-worklog
`<cwd>/.worklog/downtime-dispatches.log`, so it cannot see an audit dispatched
by another project on the same host. Both the shared Local Proxy slots and the
audit runner's host-wide slot (`AUDIT_MAX_CONCURRENCY=1` in cheap-proxy mode)
were saturated; the audit for `SA-0MUG0WFP8008WN63` failed on every Pi call
after 90 s and was aborted with no usable verdict.

**Contract.** At most **one audit-tier `/skill:audit` run is actively
executing per host**, across herdr instances and projects. The mechanism is a
dedicated machine-wide marker file
(`~/.herdr/downtime/active-audit`, or `HERDR_COORDINATION_DIR`):

- **Written** by `recordDispatch` on an **audit** dispatch, immediately before
the per-worklog marker (best-effort: a write failure never aborts the
dispatch — the per-worklog marker and stale window still protect the project).
- **Read first** by `getActiveAudit` before the per-worklog check. A non-stale
marker returns `{ ok: true, active: true, source: 'host-wide' }` without any
`wl` call, so the audit tier is skipped host-wide; the candidate falls
through to the next tier (implement → plan → intake) or the tick reports the
neutral reason **`audit-host-saturated`** (never `no-candidate`, so the
no-candidate cooldown is not entered and the next idle tick re-checks).
- **Removed** by `recordPaneClose` when an audit pane completes
(`audit-passed` / `audit-failed`), releasing the host slot for other
instances, and by `recordDispatchFailure` when an audit **spawn fails** (the
attempt never produced a running audit, so the slot must not be stranded). A
best-effort removal; a crashed audit pane is released by the stale window.
- **Staleness:** a marker older than `DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS`
(default **2 h**, matching `DOWNTIME_AUDIT_STALE_WINDOW_MS`) is treated as
released, so a crashed audit pane can never block the host indefinitely.

**Relationship to the existing guards** (defence in depth — the host-wide
gate is the *outermost* audit-concurrency guard, never a replacement):

| Guard | Scope | Sees | Action |
|---|---|---|---|
| **Host-wide marker** (this mechanism) | machine-wide, all projects/instances | an audit dispatched by ANY project on this host | skip audit tier; reason `audit-host-saturated` |
| **Per-worklog single-flight** (WL-0MT3PHW4I002SNOV) | one project's dispatch log | a non-stale `kind=audit` marker mapping to an `in_progress` item in THIS worklog | skip audit tier; reason `audit-in-flight` |
| **Proxy-slot gating** (`available_slots` / `contention_queue_depth` / per-slot ownership) | the Local Proxy | live slot availability, queue depth, live leases | ineligible/skip audit dispatch (per-tier minimum 2 free slots) or `proxy-contention` |
| **`AUDIT_PHASE2_PARALLELISM=1`** | the audit skill's child fan-out | Phase 2 deep-analysis children | parent + one child = exactly 2 local slots |

**Observability.** The skip is logged to stderr as
`Downtime audit tier skipped: audit-host-saturated (concurrentAudits=1,
freeSlots=…, contentionQueueDepth=…)` and recorded (rate-limited) in
`.worklog/downtime-coordination.log` via the shared no-dispatch decision log
(`reason: 'audit-host-saturated'`, with the poll's `freeSlots`/`totalSlots`/
`contentionDepth`). The concurrent-audit count is `1` by construction (the
host-wide single-flight); the free-slot and contention figures distinguish
infrastructure saturation from a content problem.

**Scope.** Single-machine v1 only — matches the machine-coordination contract
(`machine-coordination.ts`): multi-machine (flock/NFS) is out of scope and the
dir resolves per-user. The marker adds no read-modify-write contention on the
shared `downtime-coordination.json` (a dedicated file, read as a cheap
fast-path before the `wl` query).

**Tests.** `machine-coordination.test.ts` pins the marker lifecycle
(write/read/remove, malformed/stale/absent fail-safe); `index.test.ts`
exercises the real `createDowntimeDeps` wiring (a second instance sees the
marker; `recordDispatch` writes it for audits only; `recordPaneClose` releases
it on audit completion); `downtime-worker.test.ts` pins the worker gate (a
host-wide active audit skips the tier, reports `audit-host-saturated`, and
falls through/deferred; a per-worklog active audit still reports
`audit-in-flight`; the observability line carries the concurrent-audit count
and slot state).

### Producer-review gate (WL-0MTIAL65N004T22F)

Every dispatch tier — audit, critical (including its dependency-frontier walk), implement,
plan, and intake — excludes items with `needsProducerReview === true`. Classification
(`classifyItemForDispatch`) and every `select*` helper check strict `=== true` only, so
absent/false/undefined remain dispatchable. Parsers preserve the flag via `Boolean(...)`
coercion; a missing or unparseable field never crashes the dispatcher. The coordination
leader path equally skips review-gated entries (retaining them for later re-offer after the
flag is cleared). The filter report is "no candidate" (not a `wl-error` strike) and the
no-candidate cooldown is not triggered while review-gated work exists.

**Live Herdr-head thread (WL-0MU72WJ8C0005GIE).** The flag reaches
`classifyItemForDispatch` on BOTH dispatch paths. The normal scan in
`dispatchFromHerdrList` builds its `DowntimeItemInfo` field-by-field from the Herdr
head item, so it must thread `needsProducerReview` explicitly; the offer path
(`computeMostImportantItem`) passes the item object directly, so it always honoured
the flag. Before the threading fix (`022f1b24`) the two paths disagreed and the live
path auto-dispatched a `needsProducerReview: true` item — the regression suite
(`needsProducerReview === true blocks a non-critical item…`) pins the agreement.

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

> **Child coverage is display-only (WL-0MUBVH8QG0020H9L):** a `completed`/`in_review`
> child never enters the audit tier — it is *covered* by its parent's fresh audit
> (rendered as a dimmed parent-audit symbol in the worklist). Coverage is derived at
> read time by the shared `isCoveredByParent`/`isAuditFresh` predicates; nothing is
> persisted and the root-only dispatch query is unchanged (plus a belt-and-suspenders
> client-side `parentId` exclusion in `selectAuditCandidate`). Durable reporting of
> uncovered children is out of scope here (WL-0MUBVH9FV0027COG).
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

**In-flight guard — the marker bypass is bounded, not unconditional
(WL-0MUBEZ6PE002WLP4 / F3 WL-0MUBVKXQJ000L8EO).** The unconditional bypass
above traded starvation for a *duplicate-dispatch window*: a critical item
whose `status` reverted to `open` at its marker's stage (H5 — an aborted
`implement.py start` reset, a `wl reviewed <id> true` release, a rolled-back
dispatch) while its dispatch pane was still live was re-selected by the
critical-first scan, the CAS claim succeeded (the DB genuinely said `open`),
and a **second pane spawned for the same in-flight item** (H1+H5, confirmed by
the F1 RCA). The critical-first loop (and the normal loop for critical
candidates) now consults an **item-scoped** in-flight signal before
escalating, via `evaluateCriticalFirstGuard`:

| # | Condition | Decision | Reason |
| --- | --- | --- | --- |
| 1 | a live `working` downtime pane whose label suffix is the item id | **skip** | `in-flight-pane` |
| 2 | pane query succeeded and found no such pane | **escalate** | `no-live-pane` |
| 3 | pane query failed/unparseable, marker fresh (age ≤ `markerStaleWindowMs`) | **skip** | `in-flight-unverified` |
| 3b | pane query failed/unparseable, marker stale/absent | **escalate** | `marker-stale-escalation` |

This is deliberately **neither blind fail-closed nor blind fail-open**: a
duplicate is impossible while a pane is proven in-flight, and escalation is
never permanently starved (a pane-query outage only defers it until the
marker goes stale — bounded by `markerStaleWindowMs`, default 24 h, clamped
1 h – 7 d; the same bound documented under "Rolling log trimming"). It is
benign in practice because pane spawn itself needs herdr, so a persistent
pane-query outage also prevents dispatch.

The guard is **item-scoped and gated on a non-terminal (`working`) agent** —
it never uses the global running-pane count as a dispatch limit (the
WL-0MU2EP6JL006A1U3 invariant is preserved: `count` remains the owner-lease
qualifier only). Panes whose agent is absent, `done`, or `exited`, and idle
or not-yet-started agents, do **not** block dispatch (no idle-pane
deadlock).

The signal is resolved **once per idle cycle** from the same `herdr pane
list` read already used for the owner-lease qualifier
(`getRunningDowntimePanes`, now returning the parsed `records` alongside
`count`/`paneIds`) and threaded into both dispatch loops. A resolver failure
or an unwired dep resolves `{available:false}` and the decision table falls
back to the marker TTL — the resolver never throws into the dispatch loop.

The guard covers **both dispatch paths** (AC5 names both): the direct
Herdr-head dispatcher above, and the **coordination path** (WL-0MUBVKYH5009CGBI
/ F4). On the coordination path the item-scoped signal is resolved **per offer
root** — never the leader's root — preserving the cross-root invariant
(WL-0MTQ14W7L003II5A):

- `computeMostImportantItem` (the owner's check-in offer) skips an in-flight
  critical item and offers its next dispatchable head item instead, returning
  `{ok:true, inFlightHold:true}` when ONLY in-flight criticals remain (a
  non-empty backlog — never `noCandidate`, so no cooldown);
- `dispatchFromCoordination` (the leader) **re-checks at dispatch time** and
  rejects an offer whose pane appeared after the offer was computed (the
  TOCTOU gap), keeping the entry — the offer is still valid once the pane
  finishes. When every surviving offer is in-flight the terminal reason is the
  neutral `in-flight-pane` (never a strike/cooldown).

The leader-side re-check blocks only a **proven** live working pane; an
unavailable query does not stall all coordination dispatch (the owner's offer
computation already applied the marker-TTL fallback).

> **Post-fix verification:** the repeatable duplicate-dispatch scan and its
> results are recorded in
> [downtime-dispatcher-post-fix-verification.md](downtime-dispatcher-post-fix-verification.md)
> (WL-0MUBVL5770009DO9 / F7).

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
   dispatch pane; only a truly unowned slot is dispatchable.
   Dispatch outcome reason: `slot-owned`.

   **Lease contract (WL-0MU8809SZ0022VZG; cross-repo dependency:
   `llm-manager`).** The lease is **adaptive**, NOT a fixed ~180 s. The
   implementation lives in `llm-manager` (`proxy/proxy/router_helpers.py`):
   it extends a static base in proportion to the generation and caps it at
   `local_dispatch_lease_max_seconds` (**default 1500 s**), with chunk/prefill
   refresh buffers keeping it alive while a stream is active. A long agent
   generation therefore holds the lease for its **whole run** — the RCA
   observed a dispatched-pane lease run 836 s → 0 (WL-0MU87ZGPP0029V28).
   The dispatcher does **not** wait out a lease: it dispatches into genuinely
   free **unowned** slots via the per-slot gate (WL-0MU8807BI008C9ME), and a
   lease held by a dispatched pane (which already owns its own slot) does not
   block the OTHER free unowned slots. Only the **count-based single-slot**
   path treats a held lease as blocking (a truly owned sole slot stays
   protected). The maximum is pinned in code as
   `LOCAL_DISPATCH_LEASE_MAX_SECONDS`; if `llm-manager` changes the default,
   revisit that constant and this section so the assumption cannot drift
   silently again.
2. **Per-slot owner tracking (AC5)** — `LlamaSlot` carries an optional
   `owner_session_id`; `countFreeUnownedSlots` excludes owned slots from the
   free count and the per-slot idle tracker resets an owned slot's timer, so
   a slot with a live lease is never considered available for a new pane.
   A single idle-but-owned slot (count-based path) fails closed via the
   derived `local_lease_active`.

   **Stale/empty per-slot data (WL-0MUFP30T2003OX1F).** The proxy serves
   `slots: []` together with `slots_stale: true` when its fresh `/slots`
   query fails: the slot COUNTS come from the last-known cache but the
   per-slot detail is unavailable. An empty array is **not** "zero free
   slots", so the worker treats stale OR empty `slots` as "no per-slot
   identity" and falls back to the count-based path. In that path, with a
   multi-slot config (`0 < N < total`) a held lease no longer blocks
   dispatch into the proxy-reported spare capacity: the count-based gate
   uses `available_slots`, reserving one slot per lease only when the owner
   may be idle (`local_active_query !== true` — an active query's slot is
   already processing and excluded from the count). A single-slot
   (`total_slots = 1`) or `N <= 0` / `N >= total` setup keeps the strict
   fail-closed gate. The proxy-side improvement (serve cached per-slot
   detail when stale) is tracked separately in `llm-manager`.
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

### Pane-closure reaper (WL-0MUJL1NAH0042GOS)

Dispatched panes should not linger once their agent has finished or died.
Two mechanisms were built; only the scheduled reaper is active, and it is
idempotent:

- **Dispatch monitor (`pane-lifecycle.ts`, WL-0MU308WSF0002JWN) — DISABLED
  (WL-0MUMEKDK0008LKH8).** It closed *dispatched* panes recorded in the
  rolling dispatch log (`.worklog/downtime-dispatches.log`) once their item
  reached a terminal or attention state, but was observed to close panes
  prematurely (stage-propagation lag; `requires-attention` outcomes still
  closing) and to race with the reaper (the two share only a non-atomic
  idempotency key). The worker therefore no longer invokes it
  (`PANE_LIFECYCLE_MONITOR_ENABLED` is `false`). The classifier and its unit
  tests are retained pending a redesign — do not re-enable it without first
  reworking the double-close race.
- **Scheduled pane-closure reaper — the only active auto-close path** — covers
  panes the monitor never saw
  (manually opened panes, and marker-less panes whose agent died). It runs
  on the downtime-worker tick at most once per `PANE_CLOSE_REAPER_INTERVAL_MS`
  (default 60 s), gated by the `paneCloseEnabled` setting (default on), with
  a `paneCloseIdleThresholdMinutes` idle threshold (default 30, clamped
  [1, 1440]).

The reaper classifies each Herdr pane via the shared `classifySession()`
module (`packages/herdr/src/pane-close.ts`): close when the final assistant
message ends with `</end_session>`, when the agent process is gone, or when
the agent is alive but idle beyond the threshold. It never closes an
`implement` pane, an item awaiting producer review, the invoking pane, or a
pane with live children. A close failure for one pane is recorded and the
run continues; a reaper throw is caught and logged so it can never crash the
worker.

**Coexistence.** With Mechanism B disabled there is a single active closer,
so the previous non-atomic double-close race is gone. The reaper still skips
pane ids already recorded as handled in the rolling dispatch log, so any
historical monitor entries remain honoured.
Session-scoped child processes are torn down on close
(`packages/herdr/src/process-group.ts`), so spawned audit/plan runners are
not reparented to PID 1.

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
canonical — 10s dispatch poll, 75s continuous idle threshold, with the proxy
status refresh unchanged at 30s.**

| Setting | Default | Source |
|---|---|---|
| Dispatch poll interval | **10 s** (`downtimePollIntervalMs`) | `DEFAULT_DOWNTIME_POLL_INTERVAL_MS`, floor 10 s (`downtime-worker.ts`) |
| LLM continuous idle threshold | **75 s** (`downtimeIdleThresholdMs`) | `DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS`, floor 1 s (`downtime-worker.ts`) |
| Proxy status refresh | 30 s (`refreshIntervalMs`) | `settings.ts` (unchanged, pre-refactor cadence) |
| Leader lease TTL | 5 min (`DEFAULT_LEASE_TTL_SECONDS = 300`) | `leader-election.ts` |
| Leader check-in | 4 min (`DEFAULT_LEADER_CHECK_IN_MS`) — leader re-offer + lease renew inside 5-min TTL | `downtime-worker.ts`, `leader-election.ts` |
| Follower check-in | 5 min (`DEFAULT_COORDINATION_CHECK_IN_MS`, WL-0MTMPSCL8000O45H) — non-leader re-offer | `downtime-worker.ts` |
| No-candidate cooldown | 60 min (`downtimeNoCandidateCooldownMs`; probe-before-pause in coordination mode, re-offer cancels) | `downtime-worker.ts` |
| Success-marker staleness window | **24 h** (`downtimeMarkerStaleWindowMs`; clamped to 1 h – 7 d; releases a stranded success marker at an unchanged stage, WL-0MU6UL0RJ008IHGT) | `DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS`, `clampDowntimeMarkerStaleWindowMs` (`downtime-worker.ts`) |
| Non-terminal pane-close cooldown | **30 min** (`downtimeNonTerminalCooldownMs`; clamped to 1 min – 24 h; holds same-kind re-dispatch after a non-terminal pane close, WL-0MUKYERLZ006ELL5) | `DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS`, `clampDowntimeNonTerminalCooldownMs` (`downtime-worker.ts`) |
| Per-item/per-kind attempt cap | **3** (`downtimeMaxAttempts`; clamped to 1 – 10; flags `needsProducerReview` and stops re-dispatch of that kind once the cap is reached at the current stage, WL-0MUKYEXMK0033MFK) | `DEFAULT_DOWNTIME_MAX_ATTEMPTS`, `clampDowntimeMaxAttempts` (`downtime-worker.ts`), `countAttempts` (`downtime-log.ts`) |
| Pane-closure reaper cadence | **60 s** (`PANE_CLOSE_REAPER_INTERVAL_MS`; gated by `paneCloseEnabled`, WL-0MUJL1NAH0042GOS) | `pane-close-scheduler.ts` |
| Pane-closure idle threshold | **30 min** (`paneCloseIdleThresholdMinutes`; clamped to 1 min – 24 h) | `pane-close-scheduler.ts` |
| (removed) Max running downtime panes | **none** — no client-side pane cap; the LLM idle / free-slot check is the concurrency limiter (WL-0MU2EP6JL006A1U3) | `downtime-worker.ts` |

Both dispatch-poll and idle-threshold are configurable in the herdr plugin
settings file (`~/.config/herdr/worklog-plugin.json`,
`downtimePollIntervalMs` / `downtimeIdleThresholdMs`) and are clamped on
load (see `clampDowntimePollInterval` / `clampDowntimeIdleThresholdMs` in
`downtime-worker.ts`). The 75 s idle threshold exceeds the 1-minute
slot-exhaustion cooldown so that existing sessions have a chance to reclaim
the slot before a new work item is dispatched. The success-marker staleness
window (`downtimeMarkerStaleWindowMs`) is likewise configurable and clamped
on load
(`clampDowntimeMarkerStaleWindowMs`). The non-terminal pane-close cooldown
(`downtimeNonTerminalCooldownMs`) is likewise configurable and clamped on load
(`clampDowntimeNonTerminalCooldownMs`). The per-item/per-kind attempt cap
(`downtimeMaxAttempts`) is likewise configurable and clamped on load
(`clampDowntimeMaxAttempts`).

## Files & runtime artifacts

| Path | Purpose |
|---|---|
| `packages/herdr/src/dispatcher-anchor.ts` | Project-workspace resolver (`resolveProjectWorkspace`) + item-ID tab anchor (`getItemTabAnchor`) + retained Dispatcher fallback (`getDispatcherAnchor`): CLI parsers, coordination lock, aliveness |
| `packages/herdr/src/machine-coordination.ts` | Machine coordination dir resolver (`~/.herdr/downtime` / `HERDR_COORDINATION_DIR`) |
| `packages/herdr/src/leader-election.ts` | Lock acquisition, lease management, re-election (machine dir) |
| `packages/herdr/src/coordination.ts` | Coordination file read/write (entries, prune, upsert) — machine dir `downtime-coordination.json` |
| `packages/herdr/src/downtime-worker.ts` | Worker tick: election, check-in, idle gate, dispatch (anchor-before-claim) |
| `packages/herdr/src/downtime-log.ts` | Coordination/dispatch rolling logs (per worklog root, retained) |
| `packages/herdr/src/pane-close.ts` | Shared pane-closure classifier (`classifySession`, `extractFinalAssistantText`) consumed by the reaper and `pane-triage` (WL-0MUJL1NAH0042GOS) |
| `packages/herdr/src/pane-close-reaper.ts` | Closure reaper orchestration + CLI (`runReaper`, `runReaperCli`) |
| `packages/herdr/src/pane-close-scheduler.ts` | Periodic scheduling, settings clamps, enabled guard (`runScheduledPaneClose`) |
| `packages/herdr/src/pane-close-herdr.ts` | Production `ReaperDeps` over `herdr pane list` + pi session logs |
| `packages/herdr/src/process-group.ts` | Session-scoped child-process teardown (SIGTERM → grace → SIGKILL) |
| `packages/herdr/shared/send-to-pi.sh` | `--anchor <paneId>` \u2192 `herdr pane split --pane <anchor>` (no `pane current` in anchor mode); forwards `--cwd`/`--model`/`AUDIT_PHASE2_PARALLELISM` |
| `packages/herdr/shared/grid.py` | Grid rebalance around anchor pane |
| `~/.herdr/downtime/downtime-dispatch-anchor.json` | Persisted Dispatcher fallback anchor `{ paneId, workspaceId }` (machine dir; AC4 fallback + scheduled prompts only) |
| ~~`~/.herdr/downtime/downtime-dispatch-tab-anchors.json`~~ | **Retired** (per-prefix map). Item tabs are discovered via `herdr tab list`; a leftover file is no longer read. |
| `~/.herdr/downtime/downtime-leader.lock` | Leader lock file (machine dir, `O_CREAT\|O_EXCL`) |
| `~/.herdr/downtime/downtime-leader-lease.json` | Leader lease (5-min TTL, machine dir) |
| `~/.herdr/downtime/downtime-coordination.json` | Shared coordination list (machine dir, one entry per instance) |
| `~/.herdr/downtime/downtime-coordination.lock` | Coordination lock (machine dir, guards anchor provisioning + coordination writes) |
| `~/.herdr/downtime/active-audit` | Host-wide audit serialisation marker `{ instanceId, dispatchedAt }` (machine dir; written on audit dispatch, removed on audit-pane close, stale-released after 2 h — WL-0MUIVE0YG000UVIA) |
| `<worklog-root>/.worklog/downtime-leader.lock` | Legacy per-worklog lock (orphaned after F6, ignored) |
| `<worklog-root>/.worklog/downtime-coordination.log` | Check-ins, elections, pruning (per worklog, retained) |
| `<worklog-root>/.worklog/downtime-dispatches.log` | Dispatched items (per worklog, retained; includes `anchor-unavailable` neutral no-dispatch) |
| `<worklog-root>/.worklog/pane-close-ledger.jsonl` | Pane-closure reaper ledger (one JSONL row per evaluated pane, per worklog, WL-0MUJL1NAH0042GOS) |

## Troubleshooting / operations

- **Pane landed in the project workspace but not under the item tab:** the item-ID tab invariant is anchor-by-ID — every automated pane must split the item tab's root pane. Check (a) `herdr tab list --workspace <workspaceId>` shows a tab labelled exactly the work-item id and `herdr pane get <tabRootPaneId>` is alive; (b) the resolved project workspace is the one whose `Work Items` plugin pane has `HERDR_RESOLVED_CWD` equal to the item's worklog root (`herdr pane process-info --pane <pluginPane>` → `shell_pid` → `grep HERDR_RESOLVED_CWD /proc/<pid>/environ`); (c) the running plugin loads this repo's code — `herdr plugin list` must show `worklog-selection-list` → `local:/…/packages/herdr` (stale `dist/` or a dangling worktree link breaks resolution; rebuild with `npm run build` in `packages/herdr`). To reset an item tab, close it (`herdr tab close <tabId>`) — the next dispatch re-creates it under the coordination lock.
- **No `Downtime triggered …` pane but `anchor-unavailable` in logs:** neither the project workspace/item tab nor the Dispatcher fallback anchor could be provisioned (fail-closed, never the leader's pane). For the project path check the `pane list` / `process-info` / `/proc/<pid>/environ` reads (no `Work Items` pane for the root, missing `HERDR_RESOLVED_CWD`, or unreadable `/proc` on non-Linux); for the fallback check `~/.herdr/downtime/` writability, coordination lock contention (`downtime-coordination.lock`), and the `herdr workspace create --label Dispatcher` / `herdr tab create --workspace <id> --label <itemId> --no-focus` JSON parse (shape drift across herdr versions). The worker degrades to “no dispatch this cycle” and retries next idle tick; an empty/missing anchor file or unreadable machine dir is treated as missing (never a crash).
- **Pane landed in the wrong project's workspace:** resolution is fail-closed — it never selects another root's workspace. Check (a) the item's `cwd` (worklog root) matches exactly the plugin pane's `HERDR_RESOLVED_CWD` (trailing-slash tolerant); (b) when ≥2 `Work Items` panes resolve to the same root the focused pane wins, else the lowest pane id — close the surplus plugin pane to remove the ambiguity; (c) stale `dist/` in the running plugin (rebuild with `npm run build` in `packages/herdr`). If no plugin pane resolves, panes intentionally fall back to the `Dispatcher` workspace — that is AC4, not a misroute.
- **No dispatches happening:** confirm a leader is elected (lease file
  present + recent `lastUpdated` refresh), the proxy reports idle for ≥ 75 s
  continuously, and the coordination list has offers. Check
  `downtime-coordination.log` for check-ins and the dispatches log for the
  last dispatch.
- **Audits skipped with `audit-host-saturated` (WL-0MUIVE0YG000UVIA):** a
  non-stale `~/.herdr/downtime/active-audit` marker means an audit is running
  on this host — possibly dispatched by another project's dispatcher. This is
  expected host-wide single-flight behaviour, not a failure: audits resume
  when the running pane completes and `recordPaneClose` removes the marker,
  or after the 2-hour stale window. Inspect the marker (`cat
  ~/.herdr/downtime/active-audit`) and the decision log
  (`grep audit-host-saturated <root>/.worklog/downtime-coordination.log`). If
  no audit is actually running, the marker is stale — wait for the window or
  remove the file; set `HERDR_COORDINATION_DIR` when testing to avoid the live
  machine dir.
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

### Dispatch marker fields: selection provenance + pane id (F6)

Successful dispatch marker entries (and their post-spawn enrichment entry)
carry two additional provenance fields (WL-0MUBVL251006JAQ0 / F6), so the next
duplicate-dispatch RCA is answerable from the log alone:

| Field | Type | Description |
|---|---|---|
| `selectionPath` | string | Which loop selected the candidate: `critical-first`, `normal-scan`, `coordination-offer`, `scheduled-prompt`, or `legacy-tier` |
| `selectionReason` | string | Machine-readable reason: e.g. `no-live-pane`, `marker-stale-escalation`, `in-flight-pane` (skip), `non-critical`, `leader-offer`, `scheduled-due`, `critical-tier` |
| `paneId` | string \| null | (Enrichment entry only) the resolved dispatch pane/session id, or `null` when it could not be resolved — never a guess |
| `enrichment` | `true` | (Enrichment entry only) discriminator marking a post-spawn enrichment rather than a fresh dispatch |

**Post-spawn enrichment (AC6.2/AC6.3).** The pane id is not available before
the pane spawns (the marker is written BEFORE the spawn, fail-closed), so a
second **best-effort** entry is appended after a successful spawn. It copies
`itemId`/`kind`/`stage`/`dispatchedAt` verbatim from the success marker, so the
dispatched-marker readers (last-entry-wins, stale-release, fail-closed
staleness) see an **unchanged** marker state. Appending is fail-open: a missing
dep, a thrown resolver, or an unresolved pane never blocks, rolls back, or
un-marks the dispatch (an unresolved pane is recorded as `paneId: null`).
Legacy entries without the new fields parse and behave exactly as before, and
`scan_duplicate_dispatches.py` excludes `enrichment: true` entries from its
dispatch count (they are not a second dispatch) while reporting
`selectionPaths` / `selectionReasons` / `paneIds` for post-fix evidence.

### Rolling log trimming

The log file is bounded to the most recent 100 entries
(`DOWNTIME_LOG_MAX_ENTRIES`). Entries are appended; when the file exceeds
100 lines the first lines are truncated. All new schema fields are
preserved during trimming.

**Atomic replacement (WL-0MUBVL1FI0071WN3 / F5).** Both the dispatch log
(`downtime-dispatches.log`) and the coordination log
(`downtime-coordination.log`) are written **atomically**: `appendRollingJsonl`
writes the full new content to a temporary sibling file
(`.<file>.<pid>.<random>.tmp` in the same directory, so the rename stays on one
filesystem) and `rename`s it over the target. A concurrent reader — in
particular the dispatched-marker readers that scan the log by kind — therefore
sees either the whole previous file or the whole new one, **never** a
truncated, empty, or partially written log. Previously the writer did
`readFile → push → trim → writeFile` directly on the target, so a reader could
momentarily observe an empty file and lose a marker (a contributing factor in
the duplicate-dispatch RCA, WL-0MUBEZ6PE002WLP4 / H3). The temp file is removed
on failure before the error is rethrown and the target is left untouched;
trimming to `DOWNTIME_LOG_MAX_ENTRIES` and the throw-on-I/O-failure
(fail-closed) contract are unchanged, and the JSONL format stays
human-readable.

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
  // Enriched (WL-0MUBVL251006JAQ0 / F6) — selection provenance + enrichment
  selectionPath?: string;
  selectionReason?: string;
  paneId?: string | null;
  enrichment?: true;
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

## Recent Dispatches View (Herdr)

The Herdr worklist exposes a **recent dispatches** view (`f d`, or
`/wl dispatches`) that projects the local rolling dispatch log into browsable
rows (WL-0MUGLL9SS002E1D2). It exists because the pane-closure reaper (see
[Pane-closure reaper](#pane-closure-reaper-wl-0mujl1nah0042gos)) now
auto-closes panes whose dispatched work reached a clean terminal state, so
completed work otherwise disappears from the active worklist without a durable
trace.

- **Local-log scope only.** The view reads
  `<worklog-root>/.worklog/downtime-dispatches.log` for the **current worklog
  root** — the same per-root file the dispatcher writes. It deliberately does
  **not** aggregate across project roots; machine-wide cross-project reporting
  is a separate effort (`/skill:dispatch-logs`, WL-0MTJQOZ0K007KD40).
- **Bounded window.** The log keeps only the most recent
  `DOWNTIME_LOG_MAX_ENTRIES` (100) entries, so a very busy period can push an
  older candidate out of the retained window. There is no separate result cap:
  the view shows every item still present in the log.
- **Projection semantics.** Rows are deduplicated by work item id (one row
  per id) and grouped into 4-hour **UTC** time blocks by each item's most
  recent log timestamp (e.g. `00:00–04:00`, `04:00–08:00`, …,
  `20:00–24:00`). Blocks are ordered **oldest first**, and within each block
  items stay **newest-first**; a heading (`29 Sep 2026, 00:00–04:00`) is
  rendered before each block through the existing group-heading path. Rows
  whose timestamp is missing or unparseable collect into a trailing
  **`Unknown time`** block. Each row is annotated with the dispatch `kind`
  and the latest pane-close `outcome` where available. The id and title come
  from the log for items absent from `wl`, so closed/deleted items still
  appear.
- **Same icons as the live views.** The log decides which items appear and
  their order, but a row for an item that still exists in `wl` is rendered
  from the **live work item** (the same data the other Herdr views use), so
  its status/stage/audit/producer-review/priority icons are identical to those
  views (WL-0MUGLL9SS002E1D2). Only items no longer present in `wl` fall back
  to log-derived metadata: they render the dispatch marker's stage icon and
  show `—` for fields the log does not carry.
- **Read-only & fail-safe.** The view never writes the log or mutates work
  items, and a missing/unreadable/empty/malformed log renders an empty list
  (0 items) with no crash. Selecting a row opens the detail view with a
  best-effort `wl show <id>` fetch that falls back to the log-derived
  metadata for closed/deleted items.
- **Single filter slot.** Dispatches replaces (and is replaced by) the
  stage/priority filters; bare `/wl` clears all three axes (WL-0MSKC8T46006999S).

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