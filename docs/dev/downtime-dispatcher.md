# Downtime Dispatcher: Leader Election + Shared Coordination File

The herdr plugin's **downtime worker** (decomposed into a re-export barrel,
`packages/herdr/src/downtime-worker.ts`, over ~24 sibling modules — see
[Module layout](#module-layout))
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

## Module layout (WL-0MVF3F9A7000HKP7)

`packages/herdr/src/downtime-worker.ts` is a **thin barrel** — a module-level
doc comment plus re-export statements only, re-exporting exactly the symbols
consumers import from `./downtime-worker.js` (Q2 refinement: unused exports
stay internal to their module). Every behaviour lives in the sibling modules
below; each one carries a doc comment stating its single responsibility.

| Module | Single responsibility | Key exports (consumer-facing) |
|---|---|---|
| `downtime-worker.constants.ts` | Tuning constants, floors/maxima, tier ordering and decision helpers | `DEFAULT_DOWNTIME_POLL_INTERVAL_MS`, `DOWNTIME_AUDIT_STALE_WINDOW_MS`, `decisionHeaderToken`, `withTransientRetry` |
| `downtime-worker.types.ts` | Pure-data type surface (status/slot/poller, candidates, claim/result, config/worker) | `LlamaStatus`, `DowntimeCandidate`, `DowntimeStage`, `RunningPanesResult`, `HerdrPaneRecord` |
| `downtime-worker.clamps.ts` | The ten `clampDowntime*` settings normalisers (floors/ceilings) | `clampDowntimePollInterval`, `clampDowntimeAuditBatchMax`, … |
| `downtime-worker.idle.ts` | Idle evaluation, idle-duration tracker, per-slot tracker, prefill pacing | `evaluateIdle`, `isIdleStatus`, `createIdleTracker`, `createPerSlotIdleTracker`, `evaluatePrefillPacing` |
| `downtime-worker.poller.ts` | One `GET {proxyUrl}/llama/local/status` poll (fail-closed parse) | `parseLlamaStatus`, `fetchLocalStatus`, `createDowntimePoller` |
| `downtime-worker.parsers.ts` | Raw `wl` CLI stdout → typed candidates/results | `parseNextCandidatesOutput`, `parseAuditCandidatesOutput`, `parseShowItemOutput`, `skillKindFromPrompt` |
| `downtime-worker.selection.ts` | Per-tier candidate selection, rotation, critical-first, dependency frontier | `selectNextCandidate`, `selectAuditCandidate`, `selectWithRotation`, `resolveDependencyFrontier` |
| `downtime-worker.pane.ts` | Pane identity, in-flight resolution, spawn invocation, pane-lifecycle monitor | `buildDowntimePaneArgs`, `spawnDowntimePane`, `monitorDispatchedPanes`, `parseHerdrPaneListOutput` |
| `downtime-worker.gates.ts` | Every "may the worker dispatch X?" decision (holds, depth, attempt budget, classification) | `classifyItemForDispatch`, `evaluateCriticalFirstGuard`, `readReviewQueueGate`, `isAttemptBudgetExhausted` |
| `downtime-worker.prompts.ts` | The prompt a dispatched pane receives (incl. blocked-questions instruction) | `buildDowntimePrompt`, `BLOCKED_QUESTIONS_INSTRUCTION`, `buildDowntimeDispatchComment` |
| `downtime-worker.dispatch-filter.ts` | The Herdr list-head FILTER pipeline (sequential safety filters; critical-first selector) | `selectCriticalFirstCandidates` |
| `downtime-worker.dispatch-cpu-gate.ts` | Host-CPU dispatch gate (host-utilisation seam) | `CPU_SATURATED_REASON` |
| `downtime-worker.dispatch-claims.ts` | The claim → marker → spawn pipeline for one selected candidate | *(internal to the dispatch entry)* |
| `downtime-worker.dispatch-contract.ts` | The dispatch pipeline's dependency boundary + event/outcome types | `DowntimeDispatchEvent`, `DowntimeErrorEvent`, … |
| `downtime-worker.dispatch.ts` | The dispatch entry point + the single `dispatchInFlightCount` (single-flight) | `dispatchDowntimeWork` |
| `downtime-worker.local-reservation.ts` | The local-capacity reservation handshake (wire contract, tolerant 429s) | `createLocalReserver`, `parseLocalReservationResponse` |
| `downtime-worker.stalled-resume.ts` | Prefer resuming a stalled pane in place over opening a new one | `resumeStalledWorkIfAble` |
| `downtime-worker.coordination.ts` | The coordination OFFER computation (one item per instance per check-in) | `computeMostImportantItem`, `coordinationTierRank` |
| `downtime-worker.coordination-leader.ts` | Leader-side coordination dispatch, own-head fallback, check-in | `dispatchFromCoordination`, `runCoordinationCheckIn` |
| `downtime-worker.worker-contract.ts` | The injected dependency boundary (`DowntimeWorkerDeps`) + config/result/handle types | `DowntimeWorker`, `DowntimeWorkerDeps` |
| `downtime-worker.launch-fence.ts` | One-per-idle-window launch fence (closes the stale-status launch window) | `createIdleWindowLaunchFence` |
| `downtime-worker.orchestrator-dispatch.ts` | Per-tick dispatch admission and the dispatch attempt (shared tick context) | *(internal to the orchestrator)* |
| `downtime-worker.orchestrator-tick.ts` | The per-tick state machine: markers, leader/check-in, cooldown/three-strike, decision log | *(internal to the orchestrator)* |
| `downtime-worker.orchestrator.ts` | The worker factory and returned handle | `createDowntimeWorker` |

Layering: extracted modules import concrete siblings — never the barrel — so
the import graph stays acyclic (enforced by
`packages/herdr/test/split-guard/scan.ts`, suite
`downtime-worker.split-guard.test.ts`).

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

**Non-critical work outside the view is never dispatched by the normal
paths.** When the head yields no candidate the dispatcher reports the terminal
reason derived from the in-view flags (`no-candidate`, `review-queue-hold`,
`code-freeze`, `fresh-audit-skip`, `audit-in-flight`, `audit-host-saturated`,
`in-flight-hold`, `wl-error`) and does **not** fall back to a second ranking or
an out-of-view non-critical scan. Audit-batch observability adds the decision
*observation* tokens `audit-batch-continue` / `audit-batch-end` (never terminal
reasons) — see *Decision-log entries: audit-batch tokens & metadata* under
*Log schema*. When every visible item is filtered by a
safety gate (or the view is empty) the outcome is a NOP — **except** on the
coordination leader path, which has one bounded, own-root escape valve that
then hands off leadership (see *Own-backlog fallback & leadership hand-off*
below).

**Critical escape hatch (defensive).** A bounded out-of-window read
(`fetchExtendedHerdrItems`, `DOWNTIME_DISPATCH_EXTEND_MAX = 30`) re-reads the
**same ranking path** with a larger window — a window extension, never a second
ranking — and returns **only** `critical` items. Because every `critical` item
is already mandatory in the view, this escape hatch is normally a no-op; it
exists purely as a safety net so a release blocker can never be windowed out.
Non-critical items beyond the sprint view are filtered out, so the operator can
never be surprised by hidden-backlog dispatch. (The critical-only filter is
lifted **only** for the coordination-mode own-backlog fallback below; the
defensive escape hatch itself stays critical-only.) The extension runs on both
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

### Own-backlog fallback & leadership hand-off (WL-0MUU4XFU90008E24)

The sprint-view-only window above is the **normal** dispatch contract: the
dispatcher head equals the rendered view and a view with nothing dispatchable
is a NOP. In **coordination/leader mode** the leader additionally has a
bounded, self-scoped escape valve so a fleet does not idle when one root's view
is momentarily empty or fully blocked — with a fairness guard so no instance
can monopolise leadership by repeatedly reaching into its own hidden backlog.

**Trigger (AC1).** The fallback is evaluated in `dispatchFromCoordination`
**only after** the coordination offer scan yields no dispatchable candidate —
i.e. the same terminal-reason set the view can produce (`no-candidate`,
`review-queue-hold`, `code-freeze`, `fresh-audit-skip`, `audit-in-flight`,
`audit-host-saturated`, `in-flight-hold`, or a genuinely empty view). It never
runs when a normal in-view/coordination offer dispatched. Blocked audit-batch
continuations reuse these tokens unchanged and add the batch metadata — see
*Decision-log entries: audit-batch tokens & metadata* under *Log schema*.

**Own root only (AC2).** The fallback reads the leader's **own** worklog root
(`opts.cwd`) only — never another instance's or another worklog root's hidden
backlog. A `{ok:false}` lookup, a thrown error, or an empty extended tail is
fail-open: the original terminal reason is reported unchanged and nothing
panics (AC9).

**Bounded window, canonical ranking, gates are filters (AC3/AC7/AC9).** The
fallback is a **window extension**, never a second ranking: it re-reads the
SAME canonical ranking path (`getHerdrListHead` → `fetchNextItems` →
`selectWorkItems` → `regroupWorkItems`) with a larger, bounded window
(`current.length + DOWNTIME_DISPATCH_EXTEND_MAX`, `= 30` additional items) and
returns only the newly visible tail. The critical-only filter of the defensive
escape hatch above is lifted for the fallback (any ranked item in the extended
tail is eligible), but every existing safety gate still applies as a
**sequential filter** — classify/producer-review/freshness/caps,
dispatched-marker exclusion, attempt budget, non-terminal cooldown,
code-freeze, audit slot minimum, in-flight (critical) guard, and the
review-queue hold. A gated own-backlog item is skipped exactly like an in-view
one; a lost CAS race tries the next ranked candidate.

**Leadership hand-off (AC4/AC5/AC6, assumption A3).** A successful dispatch
sourced from the own backlog is flagged machine-readably on the outcome
(`ownBacklogDispatch: true`). After the claim, dispatch marker and pane spawn
have completed, the worker loop calls the existing
`LeaderElectionManager.releaseLeadership()` **exactly once** and sets
`leaderState = false`, so another instance can win the next election. The
step-down never rolls back the pending dispatch and never orphans the spawned
pane. It is **not** called after a normal in-view dispatch. **Exception — audit
batching:** while an audit batch is armed a continuation audit sourced from the
leader's own head does **not** step down mid-batch; the hand-off is deferred to
batch end and fires once, on the batch-ending dispatch (see *Depth-aware audit
batching* above; parent WL-0MVEDM8OT007WDRS AC4). Because there is no
reliable peer-eligibility predicate (coordination entries are removed on
dispatch), the step-down is unconditional after a successful fallback dispatch;
with no peer the same instance simply re-wins the normal election on a later
tick, bounded by the existing election backoff.

**Empty-leader step-down (WL-0MVP7QHUB003ZA2A AC1).** Leadership is a
*transient* role granted to the instance with work to do — never a permanent
perk of the instance that happened to win first. So the step-down fires on a
**genuinely empty cycle** as well: when a dispatch cycle yields no in-view
item, no coordination offer and no own-backlog dispatch, **and** the own-root
probe confirms the leader's own head/backlog is empty, the worker loop calls
the same `releaseLeadership()` and sets `leaderState = false` — exactly once
per cycle (a repeat call in the same tick is a no-op because `leaderState` is
already `false`, and `releaseLeadership()` itself is an idempotent stateless
lock/lease file delete). A peer whose sprint view *does* hold dispatchable
work can then win the next election and dispatch it. Contract details:

- **Fail-safe.** The call is guarded by `leaderManager !== null &&
  leaderState`; `releaseLeadership()` never throws, so nothing can escape the
  dispatch attempt and no double-release is possible.
- **Never on a dispatched cycle.** The trigger sits only in the
  `no-candidate` arm, after the genuine-empty probe; a cycle that dispatched an
  in-view or offer item never reaches it, and the `ownBacklogDispatch`
  hand-off above is untouched (including the audit-batch deferral).
- **Never on an unknown backlog.** A probe *failure* is a fail-closed
  three-strike event, not an empty backlog, so it retains leadership.
- **Never on a hold/gate.** `review-queue-hold`, `in-flight-pane`,
  `non-terminal-cooldown`, `attempt-budget-exhausted`, `code-freeze` and
  CPU-saturation each return their own neutral reason before this arm — the
  backlog is *not* empty, so the leader keeps its role and keeps polling.
- **No peer needed.** The step-down fires whether or not a peer has an offer:
  with no peer the same instance simply re-wins the next election (the leader
  block re-elects it on the following tick), which is cheap and keeps the
  invariant "leadership follows work" simple. The no-candidate pause still
  arms on that cycle unless a peer offer is live (see *No-candidate cooldown &
  the empty offer file* below).

**Scope: coordination/leader mode only.** The fallback lives on the
coordination leader path (`dispatchFromCoordination`) and both step-downs are
guarded by a non-null `leaderManager`. **Legacy mode** (no `coordinationDir`;
`leaderManager === null`, `leaderState` hard-coded `true`) is unchanged — there
is no manager and no peer to hand off to, so the direct/legacy path keeps the
strict sprint-view-only behaviour (non-critical out-of-view work is never
dispatched). The TUI worklist is unchanged.

**No contradiction with WL-0MUNS8X97007C9H9.** The sprint-view-only contract
still governs the dispatcher head and the direct/legacy path; the fallback is a
bounded, own-root, leadership-handing-off exception on the coordination leader
path only. It is *not* a reinstatement of the unconditional non-critical
extension that WL-0MUNS8X97007C9H9 superseded: the window stays bounded, the
ranking is the same, and the fairness guard removes the monopolisation risk.

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
   opens the first passing offer dispatches in the entry's `worklogRoot`. If
   **no** offer passes, the leader performs one bounded own-backlog fallback
   against its **own** root (`opts.cwd`) and, on a successful fallback
   dispatch, voluntarily steps down via `releaseLeadership()` so another
   instance can take over (WL-0MUU4XFU90008E24; see *Own-backlog fallback &
   leadership hand-off* above).
4. The dispatched entry is **removed** from the coordination file. The
   existing dispatched-marker exclusion and CAS claim mechanisms are
   preserved unchanged.
5. **Non-leaders** skip proxy polling and dispatch entirely — they only
   refresh their lease check (a cheap local file read) and their
   coordination entry.

### Truthful local-slot capacity (schema v2, LP-0MVGDUVGE0024YAI)

The llama-proxy publishes `status_schema_version: 2` with additive
per-slot and top-level capacity fields. When the dispatcher sees version
`>= 2` with a `lease_state` on every reported slot, **lease state is
authoritative**:

| Field | Meaning for dispatch |
|---|---|
| `slots[].lease_state: "generating"` | busy — never eligible |
| `slots[].lease_state: "idle_leased"` | reserved-but-idle — **counts as dispatchable capacity** (removes the false-busy denial behind 2,633 of 2,641 measured `local_dispatch_denied` events) |
| `slots[].lease_state: "free"` | available |
| `capacity_hint: "saturated"` | defensive no-dispatch (reason `capacity-saturated`, header `saturated`), even if the per-slot detail looks inconsistent |
| `capacity_hint: "idle"` / `"prefill_bound"` | not by themselves a stop; the per-slot free budget still applies |
| `slots[].phase`, `slots[].context_tokens` | advisory evidence only — recorded in the decision log, never a gate |
| `slots[].prefill_eta_seconds`, `prefill_budget_seconds` | not availability gates; they feed the prefill-ETA deferral (`prefill-eta`, see *Prefill serialisation pacing* below) |

With truthful lease state, the coarse global `local_lease_active` flag no
longer blocks dispatch (`idle_leased` leases are exactly the case it
over-reports). Per-slot fail-closed rules are unchanged: `slots: []`,
`slots_stale: true` or unusable detail still yields `slots-unavailable` /
`no-slots`. On a pre-v2 payload (fields absent — typically a proxy from
before the upstream change) the legacy rule applies unchanged: any live
`owner_session_id` lease makes the slot busy. Malformed
availability-affecting fields (`lease_state`, `capacity_hint`) reject the
poll (treated as busy); malformed advisory fields are ignored.

Every no-dispatch decision entry records the observed `capacityHint`,
`statusSchemaVersion`, `idleLeasedSlots`, `generatingSlots`, `slotPhases`
and `slotPrefillEtaSeconds` so an operator can see *why* a tick refused.

### Prefill serialisation pacing (LP-0MVGDUUV3001XFRJ, WL-0MVHSZRZQ00482QX)

**Problem:** the proxy serialises local prefills (`local_max_concurrent_prefills`,
default `1`), but the dispatcher used the free-slot count as its only
concurrency budget. With two free slots it could launch two downtime panes;
the second prefill queued behind the first and could fall back to a remote
provider while the GPU was only ever prefilling one request. Prefill dominates
hold time (measured p50 61.8 s, p90 269.8 s), so launching during an in-flight
prefill is the worst moment to start — measured per-request first-byte p50 was
85.0 s with one overlap vs 23.4 s alone, while aggregate prefill throughput
stayed flat (concurrency added latency, not capacity).

The proxy publishes the gate state on `GET /llama/local/status`:

| Field | Meaning |
|---|---|
| `local_prefills_in_flight` | prefills currently in flight |
| `local_max_concurrent_prefills` | effective cap; `1` = serialised (default), `0` = gate disabled |
| `prefill_gate_waiters` | requests waiting for the prefill gate (the live gate queue depth) |
| `queue_eta_seconds` / `prefill_budget_seconds` | the prefill-ETA guard's projected wait and admission budget (LP-0MVGDUV5E005UWBQ) |
| `slots[].phase` / `slots[].prefill_eta_seconds` | per-slot prefill phase and calibrated prefill cost |

**Concurrency-budget contract.** On every poll the dispatcher computes an
**effective local dispatch budget** and passes it to the tier chain (and to
`dispatchFromCoordination`):

```
effectiveBudget      = min(freeSlotBudget, prefillCapacityBudget)
freeSlotBudget       = countFreeUnownedSlots(slots)      # downtimeRequiredFreeSlots gate
prefillCapacityBudget = 0                                 when cap > 0 and inFlight >= cap
                      = cap - inFlight                    otherwise (at least 1)
                      = unbounded (freeSlotBudget)        when cap is absent or 0
```

- `prefillCapacityBudget = 0` → **no dispatch** that tick (reason
  `prefill-cap`, header token `prefill-cap`); the budget recovers on the first
  poll where `local_prefills_in_flight < local_max_concurrent_prefills`.
- `prefill_gate_waiters > 0` → contention evidence, equivalent to a non-empty
  `contention_queue_depth`: no dispatch, reason `prefill-gate`, header token
  `prefill-gate` (deliberately distinct from `contention`).
- `queue_eta_seconds` (or a per-slot `prefill_eta_seconds`) above
  `prefill_budget_seconds` → defer, reason `prefill-eta`, header token
  `prefill-eta`. Both values must be present and finite; a missing ETA **or**
  budget never blocks dispatch. This mirrors the proxy's own admission guard
  instead of parking a pane behind a doomed wait.
- The effective budget is what the dispatch tier sees, so a reduced budget
  interacts directly with `downtimeRequiredFreeSlots` and the **per-tier
  free-slot minimums**: with a prefill headroom of `1` the audit tier (≥ 2
  free slots) is skipped and the implement tier dispatches instead, even
  though more slots are physically free.

**Pacing only reduces concurrency.** It never raises the free-slot budget,
never bypasses `slots_stale` / `slots: []` (`slots-unavailable`) or
`capacity_hint: "saturated"` (`capacity-saturated`), and never bypasses the
per-slot `lease_state` availability rule. All prefill fields are absent on a
pre-v2/pre-feature proxy → `capacityBudget` is unbounded and the tick behaves
exactly as before (no new configuration knob: pacing follows the proxy's own
cap and budget, avoiding a second source of truth). Malformed gate counters
(`local_prefills_in_flight`, `local_max_concurrent_prefills`,
`prefill_gate_waiters`) fail closed (poll treated as busy, like
`contention_queue_depth`); malformed ETA values are advisory and ignored.

**Observability.** Every polled decision entry records `prefillsInFlight`,
`maxConcurrentPrefills`, `prefillGateWaiters`, `prefillBudgetSeconds`,
`queueEtaSeconds` (and the per-slot `slotPrefillEtaSeconds`) alongside the
existing `capacityHint` / `contentionDepth` evidence, and the paced refusal
carries its own `reason` (`prefill-gate` / `prefill-cap` / `prefill-eta`).

**Tests.** `downtime-worker.parse.test.ts` pins the parser (gate counters
fail-closed, ETA advisory, absent fields unchanged);
`downtime-worker.idle.test.ts` pins `evaluatePrefillPacing` (budget 0 at the
cap, headroom recovery, gate waiters, ETA deferral, missing budget/ETA
non-blocking, cap absent/0 unbounded); `downtime-worker.test.ts` pins the tick
reason/token, decision-log evidence, ETA deferral and the effective-budget
clamp (audit vs implement tier).

### Local capacity reservation (LP-0MVIKPCSG002B0NL, parent WL-0MVIKRFP0005JDL8, slice C2)

**Problem (pre-reservation behaviour, now replaced by the handshake below):**
polling `GET /llama/local/status` and then launching was racy — two herdr
instances could observe the same idle window and both launch. With the prefill
gate serialised (`local_max_concurrent_prefills: 1`) only one start was
admissible, so the loser queued behind the winner's prefill and could fall back
to a remote provider after a long wait. An idle window can be *observed* by N
instances but *owned* by one.

The proxy adds an atomic reservation handshake:

```
POST {proxyUrl}/llama/local/reserve
     { "expected_tokens": <n>, "priority": "interactive" | "background",
       "cache_state": "warm" | "cold" | "unknown" }

200  -> { "ticket_id": "<id>", "ttl_s": <seconds> }      # granted
429  -> { "reason": "<open vocabulary>", "retry_after_s": <seconds> }  # refused
```

**Dispatch gate.** After winning the CAS claim and **before** the success
marker and the pane spawn, `dispatchClaimedTier` asks for ONE ticket:

| Reserve outcome | Dispatcher behaviour |
|---|---|
| `200` granted | The ticket id is forwarded to the pane (`--reservation-ticket` / `PI_LOCAL_RESERVATION_TICKET`) and the spawn proceeds. The marker records `reservationTicketId` + `reservationGrantedAt`. |
| `429` refused | **No launch.** The tick defers by the proxy's `retry_after_s`, the CAS claim is rolled back (the item is re-selectable next idle period), and the decision entry records `reason` = the proxy's reason (`reserved-fallback` / `prefill-gate` / `queue-full` / …), `admit: false`, `retryAfterS` and `projectedWaitS`. |
| absent (404) / 500 / timeout / malformed | **Fail open** — the dispatch behaves exactly as before this feature: no ticket, no header, no behaviour change. Once per poll, no retry loop (a failed reserve is simply asked again on the next poll cadence). |

**No new polling loop.** The reserve call rides the existing single-flight
status-poll cadence: `dispatchClaimedTier` is reached at most once per tick
with a won claim, so a poll issues **at most one** `POST /llama/local/reserve`.
It never raises the free-slot budget and never bypasses the fail-closed
`slots-unavailable` / `capacity-saturated` / prefill-gate checks, which all run
earlier in the tick.

**Ticket forwarding.** The pane's first request must carry
`X-Local-Reservation: <ticket_id>`, but an env var set on the launching script
does not reach the herdr pane process. The dispatcher therefore forwards the id
as `--reservation-ticket <id>` (and sets `PI_LOCAL_RESERVATION_TICKET` on the
spawn's env); `send-to-pi.sh` injects it into the pane process
(`exec env PI_LOCAL_RESERVATION_TICKET=… bash run-pi-agent.sh …`), where the
Worklog pi extension (parent slice C4) turns it into the request header.
Ticket ids are validated token-safe (`[A-Za-z0-9._:-]`); an invalid or absent
id is ignored (fail-open, the pane still launches).

**Ticket lifetime.** A ticket is single-use. When it cannot be forwarded (the
marker or spawn fails) it is dropped — the outcome records
`reservationReleased: true` with the ticket evidence, and the next idle period
asks for a fresh one. Tickets are never reused or leaked.

**Observability.** Decision entries carry `reservationTicket` (`{ id,
grantedAt }`), `admit`, `projectedWaitS` and `retryAfterS` alongside the
existing capacity evidence (see [Decision-log
entries](#decision-log-entries-audit-batch-tokens--metadata-parent-wl-0mvedm8ot007wdrs-ac5)).

**Tests.** `downtime-worker.reserve.test.ts` pins the client (POST shape,
grant, 429 refusal, 404/500/timeout/garbage fail-open), the dispatch gate
(grant → launch with the ticket; refusal → defer, roll back and never spawn;
fail-open per failure mode; at most one reserve per poll; prefill pacing
unchanged) and the pane-arg/env forwarding;
`tests/herdr/send-to-pi.test.ts` pins `--reservation-ticket` →
`PI_LOCAL_RESERVATION_TICKET` in the pane process.

### One launch per idle window (parent WL-0MVIKRFP0005JDL8 AC3, slice C3)

**Problem (the residual half of the race).** The reservation handshake above is
the *cross-instance* arbiter — two instances observing the same idle window ask
for a ticket and exactly one is granted. But a `200` grant was not yet enough
to guarantee *one pane per window*, because a freshly launched pane takes
seconds to boot pi and start its prefill: for the next few polls the proxy's
`local_prefills_in_flight` still reports the **pre-launch** value, so the same
(or a permissive) dispatcher sees headroom that the launch has already spent
and can be granted a second ticket against it. Observed impact: an idle window
*observed* by N instances but *owned* by one.

**The rule.** An idle window produces **at most one** launch for this instance,
and a further launch is admitted only when BOTH hold:

1. a **fresh status tick** whose `local_prefills_in_flight` has advanced past
   the admission value — i.e. the proxy has REGISTERED the launch, so the
   headroom it reports is demonstrably post-launch (with the serialised default
   `local_max_concurrent_prefills: 1` this also means the pacing gate itself
   refuses until the launched prefill finishes); and
2. a **new reservation ticket granted for that specific launch** (the launch
   carries its own ticket; nothing is reused).

With a headroom-permitting proxy (`cap > 1`) the rule permits at most `cap`
concurrent launches per window, matching the prefill headroom — it never
raises the budget.

**Implementation.** A per-instance fence (`createIdleWindowLaunchFence`) is fed
by every usable poll (`idle`, `local_prefills_in_flight`,
`local_max_concurrent_prefills`) and records each successful launch. It is
consulted at the single machine-wide gate the worker runs **before BOTH dispatch
paths** (coordination-leader and own-backlog), so the rule is identical on each:

| Situation | Behaviour |
|---|---|
| No launch yet in this window | admit (subject to every existing gate) |
| Launched, proxy still reports the pre-launch in-flight count | **refuse** — reason `idle-window-spent`, token `window-spent`: no reserve request, no spawn, no strike, no cooldown, claim never taken |
| Launched, proxy now counts the launched prefill | admit (the pacing gate then decides on the real headroom) |
| Window ended (busy poll), counters absent / `cap: 0`, or no registration within the 5-minute grace | admit (fail-open — an older proxy and a dead pane can never wedge the dispatcher) |

**Evidence.** A refusal on the `dispatchClaimedTier` reserve gate is recorded
under the grouped reason `reservation-refused` with header token
`reservation-lost`, and the proxy's own vocabulary is preserved in
`reservationReason` (`prefill-gate` / `queue-full` / `reserved-fallback` / …)
alongside `admit: false`, `retryAfterS` and `projectedWaitS`. The token is
deliberately distinct from herdr's OWN paced stops (`prefill-gate` /
`prefill-cap` / `prefill-eta`) and from the fence hold (`window-spent`), so an
operator can tell a lost reservation race from a paced stop from the herdr
header alone. The coordination-leader path returns that refusal directly
instead of falling through to the own-backlog fallback (which would retry other
items and replace the evidence with a generic terminal reason).

**Composition with the coordination leader.** The fence holds no distributed
lock and never claims capacity: the proxy remains the arbiter (an atomic
grant), the coordination leader remains the only dispatcher, and the fence only
ever *adds* refusals on top of the per-slot / saturated / prefill gates — it
never admits a dispatch they would refuse.

**Tests.** `downtime-worker.launch-window.test.ts` pins the fence state machine
(registration releases it, a busy poll ends the window, absent counters and
`cap: 0` are inert, the bounded grace self-releases, `cap > 1` still requires
registration first), the same-tick two-instance race (one spawn total from one
shared mock-proxy ledger; the loser records `reservation-refused` with
`admit: false` / `retryAfterS` / `reservationReason` under the
`reservation-lost` token), later-tick suppression against a stale status,
the positive path (registered headroom + its own ticket), and
coordination-leader parity (evidence returned, not masked; the leader window
fenced like the own-backlog window).

### Idle-age authority (`local_idle_seconds`, WL-0MVHSZR9C0012NQY)

The proxy publishes the authoritative monotonic local idle age
(`local_idle_seconds`, LP-0MVGD9Z8Z0055Y5J — updated on dispatch start, every
forwarded SSE chunk and request finish; baseline is proxy process start).
When it is present and finite it **owns the idle-duration qualification** in
the worker's per-tick gate:

| Idle age vs `downtimeIdleThresholdMs` | Effect |
|---|---|
| `>=` threshold | the duration requirement is met **on this poll** — a worker that starts polling while the GPU has been idle for hours (plugin/pane restart, resumed session) dispatches on its first poll, no local accumulation needed |
| `<` threshold | **not qualified** — no dispatch, even when the worker's own tracker already holds an older idle run (the proxy is authoritative) |
| absent / non-finite / negative | fall back to the local tracker exactly as a pre-feature proxy would (regression-pinned) |

The signal qualifies **duration only** — it never relaxes capacity or
availability:

- `requiredFreeSlots` / per-slot free-slot budget unchanged; in per-slot mode
  an elapsed idle age still requires the *current* free-unowned count to meet
  the budget.
- The fail-closed contract is unchanged: `slots_stale: true`, `slots: []` or
  unusable per-slot detail still yields `slots-unavailable` / `no-slots` even
  when the idle age is large.
- A poll that reports **live activity** — a slot not available for dispatch, a
  coarse live lease on a pre-v2 payload, or a live contention/gate waiter —
  outranks the idle age: the age is ignored (local tracker decides) and a
  live contention waiter additionally **resets the idle run immediately**, so
  no idle credit survives onto the next poll. Contradictory payloads are
  fail-closed, never dispatched.
- Proxy restart resets the signal to a small value; the worker then waits one
  threshold via the local tracker (documented trade-off, fail open to today's
  behaviour).

Observability: every polled decision entry records `localIdleSeconds` and
`localLastActivitySource` (and `local_last_activity_at` where served) so an
operator can see *why* a tick was admitted or deferred; a deferred tick with a
usable idle age logs a rate-limited, non-blocking `idle-age-pending`
observation, and a tick admitted by the proxy's elapsed idle age logs
`idle-age-qualified` (both `blocking: false` — the header blocking token still
reflects refusals only). Pre-feature proxies (`local_idle_seconds` absent)
log nothing on the deferral path — byte-for-byte today's behaviour.

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
  `rollbackClaimWorkItem`) to reverse the CAS transition. The plan/intake/
  implement/risk-effort tiers keep the legacy status restore —
  `--status <pre-claim status> --if-status in_progress [--if-stage
  <pre-claim stage> --stage <pre-claim stage>]`, rolling back to `open` at
  the original stage. The AUDIT tier claim is STATUS-NEUTRAL
  (WL-0MV85WCJJ0087VMP): it never flips status/stage, so its rollback
  clears only the claiming agent's assignee, guarded by
  `--assignee "" --if-assignee <agent>` — the item stays at
  `completed`/`in_review` (never a hybrid write) and only THIS claim's
  state is reverted. A successful rollback reports the neutral outcome
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

**Probe window (how `spawn-failed` is observed).** `spawnDowntimePane` waits
for a spawn `error` (ENOENT/EACCES) or a non-zero child `exit` for
`DOWNTIME_SPAWN_PROBE_MS` (default 500 ms) before assuming the pane started.
The window is a caller-side fallback deadline, not a timing guarantee, and is
overridable per call via `probeMs` (stripped before the opts reach the spawn
boundary). A caller that spawns a real interpreter on a loaded host must widen
it: real `node` startup has been observed at ~0.56 s under load average ~28,
which would otherwise resolve `{ok: true}` before the exit event and hide a
non-zero script exit (WL-0MVOTIJ2U000JI44).

### Status-neutral audit-tier claim (WL-0MV85WCJJ0087VMP)

The AUDIT tier claim is deliberately STATUS-NEUTRAL: an audited
`completed`/`in_review` item must never enter the `in_progress`/`in_review`
hybrid that stranding autocracies were built on. `claimItem` (→
`claimWorkItem`) writes ONLY the assignee for the audit tier:

```
wl update <id> --assignee <agent> --if-status completed --if-stage in_review --if-assignee ""
```

- No `--status`/`--stage` — the item reads back `completed`/`in_review`
  throughout the claim (AC: no hybrid state).
- `--if-assignee ""` is the exclusive claim token: only an UNASSIGNED item
  may be claimed, so assigning an item (e.g. to the producer) makes the
  claim fail stale at every re-claim.
- A failed audit Phase 2 restores via the status-neutral rollback
  (`--assignee "" --if-assignee <agent>`), so the item can never be stranded
  off the review queue.
- Assignee-based scheduling hold: `classifyItemForDispatch` and every tier's
  `select*` helper exclude items with a non-empty assignee, and the parse
  helpers (`parseShowItemOutput`, `parseAuditCandidatesOutput`,
  `parseNextCandidatesOutput`, `parseImplementCandidatesOutput`,
  `parseCriticalCandidatesOutput`) carry the field so the exclusion holds at
  every selection path.

Every OTHER tier keeps the legacy status-flip claim
(`--status in_progress` + the tier's status/stage CAS), and its rollback
keeps the legacy status restore guarded by `--if-status in_progress`.

### Producer-hold sentinel (WL-0MV85WDOM007BKF8)

The **scheduling-hold convention**: a non-empty `assignee` means the item is
intentionally held from auto-dispatch — `classifyItemForDispatch` and every
tier's `select*` helper exclude it, and the audit claim's `--if-assignee ""`
CAS fails stale on it. Assigning an item therefore *pauses its automatic
scheduling*, with no magic DB flag involved.

The per-item **producer pause switch** is assigning the item to the
producer's wl identity. The reserved sentinel is
`PRODUCER_HOLD_ASSIGNEE` (`'Map'`, the producer's wl identity), recognised
by `isProducerHold()`. Because the value is self-describing, the ship
release gate can key on it: an item assigned to the producer means "the
producer owns it" and is not shippable until it has a passing audit
(epic WL-0MV82CHGQ000HAZZ Q2; re-homed ship gate — SA-tracked).

Rules:

- Assigning to the producer (`wl update <id> --assignee Map`) holds the item
  at every tier — claims fail stale and selectors skip it.
- Clearing the assignee (`wl update <id> --assignee ""`) **releases** the
  hold and makes the item dispatchable again.
- The sentinel never collides with an automated agent identity
  (`pi`, `implement`, `@github-copilot`, …); comparison is exact
  (whitespace-tolerant), not case-insensitive.
- **Clearing discipline:** every assignee writer clears the assignee on
  session end so a finished/aborted claim never silently suppresses future
  auto-dispatch. `status_lifecycle`'s failure-exit already clears; the
  dispatch claim/rollback paths clear it on every terminal outcome
  (WL-0MV85WD400091OZ6).

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

### Stalled-work scan and resume (WL-0MUYMBSA90092QV2; parent WL-0MUMA5OMH0024PN1)

Before this feature the dispatcher always took the next item from the Herdr
head and spawned a **new** pane when local-LLM capacity was idle. An existing
pane holding a non-terminal item whose agent had stopped working (its pi agent
went `idle`, or exited as `done`, without the item reaching a terminal stage)
was ignored, so half-finished work accumulated in workspaces while fresh
capacity was spent on new work. The dispatcher now performs a **machine-wide
stalled-work scan and in-place resume** on every idle dispatch cycle, **before**
selecting a new work item.

The decision half (`classifyStalledPane`, `scanStalledPanes`) and the resume
half (`resumeStalledPane`, `resumeStalledWorkIfAble`) live in
`packages/herdr/src/stalled-work.ts`; production I/O seams are wired in
`createDowntimeDeps` (`packages/herdr/src/index.ts`).

#### Ordering relative to new-item dispatch (parent AC3)

The scan is consulted **once per idle cycle, immediately before new-item
selection**, on every dispatch entry point:

- `dispatchDowntimeWork` (direct leader dispatch) — after the idle / free-slot
  gate and before the Herdr-head filters (`dispatchFromHerdrList`);
- `computeMostImportantItem` (the instance check-in offer) — before reading the
  Herdr head, so a resumed pane makes the instance offer **nothing** that cycle
  rather than pausing;
- `dispatchFromCoordination` (leader dispatch of a remote offer) — before the
  offer's review-queue / in-flight / cooldown filters.

When the scan yields a resumable candidate and a resume succeeds, the cycle
**short-circuits** with the neutral reason `stalled-resume`
(`{dispatched:false, reason:'stalled-resume'}`; `computeMostImportantItem`
returns `{ok:true, stalledResume:true}`) — **no new item is dispatched in that
cycle**. When no candidate is resumable the existing dispatch path proceeds
unchanged. The LLM idle / free-slot check remains the sole concurrency
limiter; the scan introduces no client-side pane cap.

#### Stall conditions (parent AC1)

A pane is **stalled** only when **all** hold:

1. it hosts a live pi agent — the parsed `herdr pane list` record has an
   `agent` value;
2. its label suffix parses to a non-terminal item — status not
   `completed`/`deleted`, stage not `in_review`/`done` (reuses the canonical
   `isActiveBlocker` predicate);
3. its `agent_status` is neither actively working (active set
   `work`/`working`/`busy`/`running`) nor `blocked`; and
4. its not-`working` state has persisted at least the stall threshold
   (`downtimeStallThresholdMs`).

#### Exclusion rules and machine-readable reasons (parent AC4)

Every skip is **neutral** — never a CLI-error strike, never a `no-candidate`
cooldown, never a duplicate. `classifyStalledPane` returns a single
machine-readable reason:

| Reason | Meaning |
|---|---|
| `no-agent` | The pane hosts no live pi agent. |
| `no-item-id` | The label has no parseable work-item id. |
| `kind-unknown` | The label carries no recognisable dispatch kind. |
| `item-terminal` | The item is completed/deleted or `in_review`/`done`. |
| `needs-producer-review` | The item is flagged `needsProducerReview === true` (hard exclusion). |
| `agent-working` | The agent is actively working. |
| `agent-blocked` | The agent status is `blocked` (never hijacked). |
| `kind-stale` | The item has already advanced past the pane's dispatched kind. |
| `cooldown-active` | The non-terminal pane-close cooldown holds the `(item, kind)`. |
| `model-cooldown-active` | A machine-wide model cooldown is still active (`cooldownUntil` in the future); the pane is never woken early. |
| `attempt-cap-exhausted` | The per-item/per-kind dispatch-attempt cap is reached. |
| `last-activity-unknown` | No parseable activity timestamp to measure a stall. |
| `stall-threshold-not-elapsed` | Not-`working` for less than the threshold. |

The dispatched kind is derived from the pane label convention
`<Downtime|Manually> triggered <kind> …` (the kind token immediately follows
`triggered`), recognising `implement`, `risk-effort`, `intake`, `audit` and
`plan`. Other labels — including a free-form `Manually triggered prompt …`
pane — have no kind and are skipped.

**Kind vs stage progression (`kind-stale`).** Stage ranks are `idea` 0,
`intake_complete` 1, `plan_complete`/`in_progress` 2, `in_review` 3, `done` 4;
kind ranks are `intake` 0, `plan` 1, `risk-effort`/`implement` 2, `audit` 3. A
pane whose item rank exceeds its kind rank (an `intake` pane on an
`intake_complete` item, an `implement` pane on an `in_review` item) is stale
and skipped. An unknown stage cannot prove advancement, so it fails open (not
stale).

**Stall anchor.** The not-working duration is measured from the **later** of
the item's `updatedAt` and its most recent non-`spawn-failed`,
non-`enrichment` dispatch marker for that kind, so a pane freshly dispatched
for an old item is not mistaken for a stall. No parseable anchor → skip
(`last-activity-unknown`).

#### Resume in place (parent AC2)

Each candidate is resumed **in place** — a new pane is never spawned for the
item; the resume always targets the candidate's `paneId`:

- a **live agent** receives the literal continuation prompt `continue`
  (`herdr agent prompt <paneId> continue`, `STALLED_RESUME_PROMPT`);
- a pane whose agent has **exited** (`agent_status` `done`/`exited`) has pi
  relaunched in the **same** pane continuing its session
  (`herdr agent start pi --kind pi --pane <paneId> -- --session <path>`, or
  `-- --continue` when the pane records no session path), after which the
  literal `continue` prompt is submitted.

A successful resume records a dispatch attempt for `(item, kind)` in the item
root's rolling dispatch log, so the existing per-item/per-kind attempt cap
applies to resumes too; the cap is enforced up front and escalates via
`needsProducerReview` when exhausted. Concurrent resumes of the same
`(paneId, itemId)` are prevented by an in-process in-flight guard (a second
attempt is the neutral `concurrent-resume` skip).

#### Model-cooldown wake (WL-0MV5639GG00085Q7; parent WL-0MV54ZP3Y00514Y9)

A pane whose in-pane recovery loop hit provider exhaustion writes a durable
machine-wide model-cooldown marker (`model-cooldowns.json` in the coordination
dir; `@worklog/shared/model-cooldown`). The scan reads **every** stored entry
once per cycle — active *and* expired/due — and matches it to a listed pane by
`paneId` (the recovery loop writes `HERDR_PANE_ID` when available; a
session-only entry cannot be mapped to a pane record and is ignored):

- **Active** (`cooldownUntil > now`) — the pane is known to be waiting on a
  throttled provider: it is **never** woken, and the active cooldown overrides
  even an elapsed generic stall threshold (reason `model-cooldown-active`).
  This is the strictness guarantee.
- **Due** (`cooldownUntil <= now`) — the marker is the WAKE TRIGGER: the pane
  becomes a candidate **without** waiting for the generic stall threshold (the
  `last-activity`/`stall-threshold` checks are bypassed). Every other safety
  gate still applies — the non-terminal pane-close cooldown, the
  per-item/per-kind attempt cap, the `needsProducerReview` flag and the
  kind-vs-stage (`kind-stale`) check.

A due cooldown candidate is ordered **before** generic stall candidates and is
resumed through the **unchanged** stalled-resume path (the literal `continue`
to a live pane, or a pi `--continue` relaunch in an exited pane) with the same
attempt accounting. The resume loop still resumes **at most one** candidate per
cycle, so at most one cooled-down job is woken per dispatcher cycle, and a
resumed pane makes the cycle short-circuit with `stalled-resume` rather than
opening a new pane.

A **successful** resume consumes the pane's marker (`clearModelCooldown`) so the
same pane is not re-woken on the next cycle; a **failed** resume does not clear
the marker and records no attempt, so it stays bounded by `cooldownUntil` and
the attempt cap. An unreadable/absent cooldown signal is fail-safe — the scan
simply has no cooldown candidates and the generic path is unchanged.

> **Must not regress — no client drain (WL-0MUWIHUL2000JEFR).** This wake is
> **not** a client-side drain design: there is **no** slot-count completion
> gate, **no** `drainPaused` dispatch pause and **no** unbounded latch. The
> scan is bounded by `cooldownUntil`, resumes at most one pane per cycle, and
> the proxy's own server-side bounded drain remains authoritative.

#### Neutral outcome vocabulary and fail-safety (parent AC2/AC6)

Every not-resumed outcome is neutral — never a strike, never a crash, never a
duplicate. The resume adds these reasons on top of the classifier reasons
above:

| Reason | Meaning |
|---|---|
| `concurrent-resume` | A resume of the same `(paneId, itemId)` is already in flight. |
| `agent-blocked` | `herdr agent prompt` refused because the agent is `blocked`. |
| `agent-prompt-stalled` | The submission was accepted but the agent did not reach `working`/`blocked` within the CLI's documented 5 s window (`agent_prompt_stalled`). |
| `pane-vanished` | The pane/agent disappeared (e.g. the pane-closure reaper closed it) between scan and resume. |
| `cli-error` | Any other herdr/CLI failure. |

Fail-safe degradation: an unreadable/unparseable `herdr pane list` yields no
candidates; a per-pane failure (unresolvable root, failed `wl show`, thrown log
read) skips that pane without aborting the scan; unwired `scanStalledPanes` /
`resumeStalledPane` deps and a disabled scan both fall through to normal
dispatch; a thrown resume is neutral and the scan tries the next candidate. A
code-frozen/ambiguous cycle skips `audit` and `implement` panes (freeze
split-by-skill), so a resume can never bypass the freeze.

#### Cross-root resume contract (parent AC5)

Each candidate carries the **item's own worklog root**, resolved from the
pane's `cwd` first and then from the pi session-log path in `agent_session`
(`defaultStalledPaneRootResolver`). The resume reads the item and its rolling
log, records the attempt and flags producer review against **that** root —
never the leader's ambient root. When neither `cwd` nor `agent_session`
resolves to a valid worklog root the pane is **skipped** (fail closed) rather
than resumed against the wrong database.

#### Settings

Both settings are re-read from the plugin settings on **every idle tick**
(never cached), so a change applies live:

| Setting | Default | Clamp |
|---|---|---|
| `downtimeStallScanEnabled` | `true` (`DEFAULT_DOWNTIME_STALL_SCAN_ENABLED`) | boolean; `false` disables the scan entirely and falls through to normal dispatch |
| `downtimeStallThresholdMs` | 5 min / `300000` ms (`DEFAULT_DOWNTIME_STALL_THRESHOLD_MS`) | `[60 s, 60 min]` / `[60000, 3600000]` ms (`clampDowntimeStallThresholdMs`); invalid/missing falls back to the default |
| `downtimeCapacityStarvationAlertMs` | **2 h** / `7200000` ms (`DEFAULT_DOWNTIME_CAPACITY_STARVATION_ALERT_MS`) | `[5 min, 24 h]` (`clampDowntimeCapacityStarvationAlertMs`); invalid/missing falls back to the default |
| `downtimeLongRunningThresholdMs` | **3 h** / `10800000` ms (`DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS`) | `[1 h, 48 h]` (`clampDowntimeLongRunningThresholdMs`); invalid/missing falls back to the default |

### Capacity-starvation signal &amp; long-running pane detection (WL-0MVKNC2N50025HXE)

A saturated local model NOPs the dispatcher **silently by design**: every capacity
refusal (`slots-unavailable`, `capacity-saturated`, `slot-owned`,
`proxy-contention`, `prefill-gate`/`prefill-cap`/`prefill-eta`) is a non-terminal
decision. When it lasts hours (the 2026-10-22/23 incident: four
`working` panes held every slot for 9.5–17.5 h, one dispatch in nine hours) the
fleet simply stops dispatching with no visible trace after the ~1 h rotating
decision log.

Two new pieces of observability make such a night diagnosable **while it is
happening**, with no change to dispatch behaviour:

- **Capacity-starvation signal (`capacity-starvation.ts`).** The worker's
decision-log path feeds a pure `CapacityStarvationTracker` with every blocking
refusal (including rate-limited repeats). Any **non-capacity** outcome
(`no-candidate`, `review-queue-hold`, `code-freeze`, `wl-error`, …) and any
successful dispatch **ends the episode**. Once a continuous refusal run has
outlasted `downtimeCapacityStarvationAlertMs` (default **2 h**), the tick writes
one extra `capacity-starved` **observation** to the coordination decision log
(`blocking: false` — the header blocking token and the underlying refusal
reason are unchanged), carrying `starvedSince`, `starvedMs`,
`consecutiveCapacityRefusals` and `lastCapacityReason`. It re-arms at most
once per window, so an all-night outage keeps producing evidence every window.
- **Long-running pane detector (`long-running-panes.ts`).** A pre-existing
recovery gap: the stalled-work scan, the non-terminal cooldown and the pane
reaper all key on a pane being NOT `working`, so a pane that stays `working`
for 12+ hours while its item never advances is invisible to all of them yet
monopolises every local slot. `classifyLongRunningPane` / `scanLongRunningPanes`
flag a live-agent pane whose **non-terminal** item has had **no observable
progress** (`updatedAt` bump or fresh dispatch marker) for at least
`downtimeLongRunningThresholdMs` (default **3 h**) — **including while the agent
is `working`**. It is **observation only**: nothing in this path may resume,
prompt, hijack or close a pane, and a code-freeze never applies (no dispatch
involved). When the starvation signal fires and the `scanLongRunningPanes` dep
is wired, the `capacity-starved` entry names the offending panes
(`longRunningPanes[]`: `paneId`, `itemId`, `cwd`, `kind`, `stalledForMs`,
`agentStatus`, `stage`, `title`), so an operator sees **who is holding the
model** without reading pane-by-pane.

**Prefill-serialisation interaction (LP-0MVGDUUV3001XFRJ):** with
`local_max_concurrent_prefills: 1` a single in-flight prefill collapses the
dispatcher's effective budget to `0` (`prefill-cap`); combined with multi-slot
long-running sessions the scheduler can hold zero dispatchable capacity for
hours even when one slot is technically free. Operational levers: raise prefill
concurrency, close/reap the long sessions, and/or enable the `pane-close`
reaper (`paneCloseEnabled`) so abandoned sessions are eventually settled.

### Host-CPU dispatch gate (WL-0MVK0UO3Q002TXW6)

The dispatcher gates on local-LLM slot capacity, prefill pacing, the code freeze
and pane state, but until this change it had **no host-CPU signal at all**: it
would happily launch *more* implement/audit panes while the machine was already
at or above 75 % CPU utilisation, slowing every agent (including the operator's
own session). The gate adds one host-local reading per dispatch tick.

**Metric (`packages/herdr/src/host-cpu.ts`).** Utilisation is a
`/proc/stat` delta between two samples:

- `parseProcStatCpu(text)` reads the aggregate `cpu` line
  (`user nice system idle iowait irq softirq steal`); `guest*` counters are
  excluded because they are already contained in `user`/`nice`. `busy` is
  `total − (idle + iowait)`; per-CPU lines (`cpu0`, …) are ignored — the gate
  measures the whole host.
- `cpuPercentFromSamples(prev, next)` = `busyΔ / totalΔ × 100`, clamped to
  `0–100`, `null` when the total counter did not advance.
- `createHostCpuSampler()` holds the **previous sample in memory only** (no disk
  state, no machine-wide marker, no cross-host coordination — the downtime
  leader is the single dispatcher per host). Degradation order:
  1. `/proc/stat` delta, when a previous sample exists **and** the window is at
     least `1 s` (`HOST_CPU_MIN_SAMPLE_WINDOW_MS`; two dispatches inside one
     tick would otherwise measure a misleading 0 %);
  2. `1-min load average ÷ core count × 100` (capped at 100) from
     `/proc/loadavg` — load is an upper-bound proxy, and the conservative
     direction is the intended one for a *dispatch* gate;
  3. `{ ok: false }` — **fail open**, dispatch unchanged.
  The whole module never throws: unreadable/unparseable input, thrown readers,
  `NaN`/non-finite values and an absent `/proc` all degrade to the next step.
  The production seam in `index.ts` reads only the whitelisted absolute paths
  `/proc/stat` and `/proc/loadavg` via `node:fs` and `os.cpus().length`.

**Gate.** `isCpuGateActive(percent, threshold)` is
`threshold > 0 && percent >= threshold` (equal blocks). While active it is
applied like the code-freeze **split-by-skill safety gate**, not like the
non-safety filters a critical item may bypass:

- **refused**: `audit` and `implement` dispatch — including a CRITICAL
  implement — on every path: the direct Herdr head (critical-first scan and
  normal scan), the coordination leader's offer dispatch, the own-backlog
  fallback and the audit-batch continuation;
- **allowed**: `intake`, `plan` and `risk-effort` dispatch, and every
  operator-initiated/manual dispatch;
- **stalled resume skipped**: a gated tick does not resume a stalled pane in
  place (that would wake an agent and add load). Once CPU falls below the
  threshold the next idle tick resumes normally, unchanged.
- **offers are NOT gated**: `computeMostImportantItem` still returns
  candidates (only its stalled-resume step is skipped). Suppressing offers
  would strip the leader's candidate list and, when everything is held, drive
  the 60-minute `no-candidate` cooldown — dispatch would then not resume
  promptly after CPU recovers.

**Neutral token.** A gated tick reports the distinct reason
**`cpu-saturated`** (header token of the same name) and records it in the
decision log with `hostCpuPercent`, `hostCpuSource` (`proc-stat` / `loadavg`)
and `cpuGatePercent`. It is never a CLI-error strike, never enters the
`no-candidate` cooldown, never removes a coordination entry, and never rolls
back or writes a dispatch marker. It is deliberately **NOT** counted as a
capacity refusal in `CAPACITY_REFUSAL_REASONS` (`capacity-starvation.ts`): the
local model may be perfectly idle while the host is busy, so a CPU-gated night
must never be reported as local-model capacity starvation. If the code freeze
and the CPU gate are both active, `code-freeze` keeps precedence.

**Configuration.** `downtimeCpuGatePercent` (default **75**, clamped to
`[0, 100]`, `0` disables) is re-read live on every dispatch tick and threaded
through `DowntimeWorkerConfig.config()` into both dispatch entry points.
`packages/herdr/README.md` documents the setting. No new dependency (`node:fs`
+ `node:os` only) and no persistent state: a worker restart simply re-seeds via
the load-average fallback on the first tick.

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
without disturbing active `Downtime triggered …` panes. `open-worklist` /
`open-pi-agent` flows are unaffected by the **automated** placement above
(they carry no work-item ID). The following sub-section documents the
**interactive** counterpart, which does place worklist-dispatched,
ID-carrying panes into an item-ID tab.

### Interactive dispatch pane placement (WL-0MUYI3JAO002BTNL)

The sections above describe the **automated downtime** dispatcher. An
operator-driven **interactive** dispatch (a worklist chord resolving to an
ID-carrying command) also routes its pane into a tab labelled with the exact
work-item ID, but it is a deliberately different path: it uses the invoking
pane's **current** workspace and is **fail-open**. It is the manual
counterpart of the automated placement (parent work item
WL-0MUKZGEQ2007FECS).

|  | Automated downtime (above) | Interactive dispatch (this sub-section) |
|---|---|---|
| Trigger | idle dispatcher, `dispatchClaimedTier` | operator chord / worklist command (`onCommand`) |
| Workspace | **project** workspace resolved via `resolveProjectWorkspace` (logical-root match) | **invoking pane's current** workspace (`HERDR_WORKSPACE_ID`) |
| Channels | agent panes (`send-to-pi.sh`) | agent panes (`send-to-pi.sh`) **and** shell/command-output panes (`run-in-pane.sh`) |
| No work-item id | scheduled prompts → `Dispatcher` anchor | current-pane split (legacy behaviour, unchanged) |
| Failure | **fail-closed** — `anchor-unavailable`, no pane | **fail-open** — falls back to the current-pane split, never dropped |

Lifecycle (`packages/herdr/src/index.ts`; shared anchor helper in
`packages/herdr/src/dispatcher-anchor.ts`):

1. **Workspace resolution** — `resolveInteractiveWorkspaceId(env)` reads
   `HERDR_WORKSPACE_ID` (present in the plugin pane environment); when it is
   absent/blank it derives the workspace from the invoking pane id
   `HERDR_PANE_ID` (`<workspace>:<pane>`), else returns `null` (→ fail-open).
   There is **no** `/proc`-based project resolution on this path (Q2a), and
   the pane is never placed in another project's workspace.
2. **Item-ID tab resolution** — `resolveInteractiveItemAnchor(cwd,
   workspaceId, itemId, deps?, onCreate?)` wraps the shared
   `getItemTabAnchor`, so the tab labelled exactly `<itemId>` is created on
   first use and reused thereafter under the coordination lock with the same
   double-check and CLI-shape tolerance as the automated path (the tab label
   is the key; no persistence file, no duplicate tab). `onCreate` fires only
   when this call actually provisioned the tab — the create-vs-reuse signal
   consumed by step 4. **Any** resolution/creation error returns `null`
   (fail-open).
3. **Anchor forwarding** — the item-tab anchor is resolved once per dispatch
   and forwarded to both channels by the arg builders:
   `buildSendToPiArgs(..., anchor)` and `buildRunInPaneArgs(..., anchor)`
   append `--anchor <paneId>` when it is a non-empty string.
   `send-to-pi.sh` already supported `--anchor`; `run-in-pane.sh` gained it —
   with `--anchor` it runs `herdr pane split --pane <paneId> --direction right
   --no-focus --cwd <cwd>` instead of the legacy `--current`, tolerating the
   `pane_id` / `paneId` / `id` split-output variants (raw output logged on
   parse failure, mirroring `send-to-pi.sh`). `--no-focus` is preserved by
   default, so the item tab never steals focus — **except** for shortcuts
   that opt in with `focus: true` (currently `r i`, the producer interview,
   WL-0MURJ0LFH002O95I): their dispatch passes `--focus`, and
   `run-in-pane.sh` focuses the new pane's item tab (`herdr pane get <pane>`
   → `herdr tab focus <tabId>`) **before** zooming the pane. Tab focus is
   required because the pane lives in a tab other than the caller's and
   `pane zoom` alone cannot switch tabs; it is best-effort/fail-open (an
   unresolvable tab id falls back to the zoom-only behaviour).
4. **Root-pane cleanup** — when this dispatch **created** the tab, the
   placeholder root pane (herdr's initial empty pane, used only as the first
   split anchor) is closed after the split is **confirmed**: the spawning
   script writes its new pane id via `--pane-id-file`, and only then does
   `closeInteractiveTabRootPane(anchorPaneId, { cwd }, deps)` run. Cleanup is
   **fail-safe** — the anchor is closed only when liveness POSITIVELY
   confirms it is not a live tracked pi/shell pane
   (`defaultInteractiveLiveTrackedPanesResolver` → `herdr pane list`; live =
   a non-terminal pi agent or a `Shell: …` label). Unknown liveness (probe
   absent, failed, or unparseable) leaves the anchor open, so a reused tab's
   live pane is never closed. Cleanup is also **fail-open** — any error is
   swallowed and the dispatch outcome never changes. A later dispatch for the
   same item reuses the surviving pane as the split anchor.

`getItemTabAnchor` is therefore the single shared create-or-reuse mechanism
for both placements; only the workspace choice, failure semantics and
root-pane liveness source differ. The automated path checks the running
**downtime** pane ids for its cleanup liveness; the interactive path checks
the live **tracked pi/shell** panes (step 4).


### Request priority (`X-Priority`) on dispatched panes

The llama-proxy retired its global fast/cheap operating mode. Cost and
urgency are expressed **per request** via the `X-Priority` request header
(`low` | `medium` | `high`; absent → the proxy applies its own `medium`
default, reported back in `X-Priority-Applied`). Herdr conveys the dispatched
item's priority to the launched pi session as the pane-launch environment
variable `HERDR_REQUEST_PRIORITY`; the Worklog pi extension turns it into the
header on every provider request (fail-open — unset/invalid leaves headers
untouched).

Two mapping tables (`packages/herdr/src/request-priority.ts`) are fixed by
the parent contract (WL-0MVE1NZ4J000H5NH):

| Work-item priority | Interactive | Downtime |
|---|---|---|
| `low` | `medium` | `low` |
| `medium` | `high` | `medium` |
| `high` | `high` | `high` |
| `critical` | `high` | `high` |
| absent / unknown | `high` | `medium` |

- **Downtime** — `dispatchClaimedTier` forwards the selected
  `DowntimeCandidate.priority` through `spawnAgentPane` to
  `buildDowntimeSpawnOptions`, which maps it with the downtime table and sets
  `HERDR_REQUEST_PRIORITY` beside `HERDR_RESOLVED_CWD`. Unattended work is
  therefore polite (`low` stays `low`) while `critical` work is served as
  `high`. Scheduled prompts have no work item and get the downtime default
  (`medium`).
- **Interactive** — the agent route resolves the dispatched item's priority
  with a bounded `wl show --json` lookup (2 s budget), maps it with the
  interactive table and passes it to `buildSendToPiArgs(...,
  requestPriority)` (`--request-priority <value>`) and to headless
  `spawnBackgroundPi` runs (direct spawn env). Resolution is fail-open: no
  id (`/prompt:`), a lookup failure or a timeout yields `high` and never
  blocks the dispatch.
- **Transport** — `send-to-pi.sh` accepts `--request-priority
  low|medium|high` and injects it into the pane process with `exec env
  HERDR_REQUEST_PRIORITY=<value> bash run-pi-agent.sh …` (a `pane run`
  environment set on the script itself does not reach pi). Nothing is
  forwarded when the flag is absent, so the proxy's `medium` default applies.
  Shell-command panes (`run-in-pane.sh`) intentionally carry no priority:
  they do not schedule agent work.
- **Audit Phase 2 is always serial** (`AUDIT_PHASE2_PARALLELISM=1`); the
  former mode-aware `'2'` selection and its `DowntimeSpawnConfig`
  (`mode`/`slotBudget`/`freeSlots`/`concurrentDispatchCap`) plumbing are
  gone. Free-slot dispatch gating is unchanged.

### Per-turn local preference and route log (WL-0MVLJTV03000KIQZ, parent WL-0MVIKRFP0005JDL8 AC4, slice C4)

**Problem.** A dispatched pane's turns were previously sent with no locality
claim: when the local slot was contended the proxy silently waited (up to
120 s) and only then fell back, so a turn could look stuck with no evidence of
which route it took. The reservation handshake (C2) claims capacity for a
pane's *first* request; this slice records the *per-turn* decision for every
request the pane makes.

**Wire contract** (pinned by C1, shared with the proxy change
`LP-0MVIKPCSG002B0NL`):

| Direction | Header | Meaning |
|---|---|---|
| request | `X-Local-Preference: local-only` | Work the operator marks local-first: the proxy refuses immediately when the local slot is contended instead of silently waiting |
| request | `X-Local-Preference: remote-ok` | Background work: may go remote without queuing local capacity |
| response | `X-Local-Route` | Route the proxy took (e.g. `local`, `remote:<provider>`) |
| response | `X-Local-Fallback-Reason` | Why the request left the local route |

**Policy knob.** `downtimeLocalPreference` (herdr setting, clamped to the two
values, default `remote-ok` since WL-0MVNUHWH500196K1; `local-only` is the
explicit per-deployment opt-in) is read live on every tick and threaded
through `DowntimeWorkerConfig.config()` → both dispatch paths →
`dispatchClaimedTier` → `spawnAgentPane` → `buildDowntimePaneArgs` /
`buildDowntimeSpawnOptions`:

- **Downtime backlog panes** carry the resolved value (see the priority rule
  below); with no persisted key a `medium`/`high`/`critical` item still
  forwards `remote-ok` — unattended work goes remote rather than stall on a
  contended local slot — while a `low`-priority item becomes `local-only`.
- **Scheduled-prompt panes** and **headless background dispatches**
  (`spawnBackgroundPi`) default to `remote-ok`: unattended work never queues
  local capacity the operator may need. They also *inherit the knob when it
  is present* — so an explicit `local-only` deployment also makes scheduled
  work local-only. For an unconfigured deployment the knob and the
  background fallback agree on `remote-ok`.
- **Interactive panes** carry no preference unless the operator exports
  `HERDR_LOCAL_PREFERENCE` — requests stay byte-identical to today.

Downtime-spawned panes take both pane-launch knobs (`HERDR_LOCAL_PREFERENCE`,
`PI_LOCAL_RESERVATION_TICKET`) from the **resolved dispatch decision only**:
`buildDowntimeSpawnOptions` strips them from the inherited environment before
re-adding an explicit value (WL-0MVP643Q4007BZJ8). A worker that itself runs
inside a `local-only` pane therefore cannot leak its own preference into every
child — that would bypass the priority rule and violate the fail-open contract
that an absent value omits the env var.

**Priority rule and precedence (WL-0MVNUIW77000VYAX).** The preference is
resolved **once** at the dispatch boundary (`dispatchClaimedTier`, from the
already-resolved candidate priority), so every dispatch path — coordination
offer, own-backlog fallback, audit-batch continuation, critical-first/normal
scan and the legacy tier chain — inherits the same decision. Precedence,
highest first:

1. **Explicit operator setting wins.** When `downtimeLocalPreference` is
   *persisted* with a valid value (`local-only` or `remote-ok`), that value is
   forwarded for every pane regardless of priority. Remove the key to opt into
   the priority rule.
2. **Priority rule.** With no persisted key, a `low`-priority candidate is
   dispatched `local-only` (cheap work absorbs contention on the local slot and
   fails fast instead of consuming remote capacity); `medium`, `high`,
   `critical` and an absent/unknown priority resolve to the deployment default
   `DOWNTIME_LOCAL_PREFERENCE` (`remote-ok`).
3. **Deployment default.** `remote-ok`, also used when no priority exists (a
   scheduled prompt has no work item).

Explicitness is a **derived, never-persisted** signal: `loadSettings` reports
`downtimeLocalPreferenceExplicit` `true` only when the settings file holds a
valid two-value preference (an absent key, a missing file and out-of-alphabet
values are not explicit). The persisted alphabet stays
`local-only | remote-ok`, the setting's `remote-ok` default is unchanged, and
the `X-Local-Preference` wire contract is unchanged — the rule only chooses
between the existing two values.

**Marker evidence.** The success marker in
`.worklog/downtime-dispatches.log` records the resolved `localPreference` and a
machine-readable `localPreferenceReason`:

| reason | meaning |
|---|---|
| `operator-setting` | a persisted `downtimeLocalPreference` decided the value |
| `priority-low` | the low-priority rule chose `local-only` |
| `default` | the deployment default was kept (non-low or absent priority) |

Scheduled-prompt markers record the same two fields (`default`, or
`operator-setting` when the operator persisted the knob). Legacy callers that
pass a preference without the new dispatch mode add no marker fields, and
marker readers ignore unknown/absent fields, so existing logs stay valid. The
route log's `preference` field therefore shows `local-only` for a low-priority
dispatch and the deployment default for a high-priority one.

> **Default flip (WL-0MVNUHWH500196K1).** The C4-AC1 downtime default of
> `local-only` (WL-0MVLJTV03000KIQZ) is superseded by `remote-ok`. The
> trade is deliberate: contended downtime work may now leave the box for a
> remote (possibly metered) provider rather than silently not run. Keep
> `local-only` where that spend/reach profile is unwanted; the route log
> makes the actual route visible either way.

**Transport.** `send-to-pi.sh --local-preference <local-only|remote-ok>`
injects the value into the pane process (`exec env
HERDR_LOCAL_PREFERENCE=<value> bash run-pi-agent.sh …`); anything else is
ignored with a warning and the launch proceeds unchanged (fail-open). An
absent flag omits the env var entirely.

**Header injection + route capture.** The Worklog pi extension
(`packages/tui/extensions/local-preference/`, loaded through the extension
package's `pi.extensions` list) reads `HERDR_LOCAL_PREFERENCE` on every
provider request (never cached) and sets `X-Local-Preference` via
`before_provider_headers`. On `after_provider_response` it parses
`X-Local-Route` / `X-Local-Fallback-Reason` and appends one JSONL line per
response to `<cwd>/.worklog/local-route.log` (bounded rolling log, capped at
`2000` entries, atomic temp+rename write): `{ at, sessionId, preference,
route, fallbackReason, model, ticket? }`.

**Dispatch correlation (AC4).** Each line carries the pi session id (the same
`herdr-<ts>-<pid>-<rand>` id `run-pi-agent.sh` passes as `--session-id`) and,
when one was forwarded, the reservation ticket (`PI_LOCAL_RESERVATION_TICKET`).
The dispatch marker in `.worklog/downtime-dispatches.log` records
`reservationTicketId` / `reservationGrantedAt`, so an operator can join the
decision to the turns it produced. No secrets/PII are recorded.

**Fail-open (AC3).** No knob → no header and no log; an older proxy with no
route headers → no entry; a capture/write failure (unwritable log, stale ctx,
malformed headers) never throws into the turn. There is no new polling loop —
logging is per response.

**Tests.** `packages/tui/extensions/local-preference/local-preference.test.ts`
(pure module and hooks: both values, the unset case, absent/malformed headers,
bounded log, session/ticket correlation, never-throw);
`packages/herdr/src/local-preference.test.ts` (defaults + clamp);
`packages/herdr/src/downtime-worker.reserve.test.ts` (pane args/env
forwarding and the dispatch → spawn thread);
`tests/herdr/send-to-pi.test.ts` (`--local-preference` passthrough and
fail-open) and `tests/herdr/settings.test.ts` (setting default + clamp).

### No-candidate cooldown & the empty offer file

The no-candidate cooldown (WL-0MSI7DQL10016QYX) pauses the worker entirely
(no poll, no idle tracking, no dispatch) for `downtimeNoCandidateCooldownMs`
(default 60 min) after a genuinely empty backlog, resetting the idle
tracker so a fresh full idle period is required after the pause. A
`no-candidate` outcome means the *sprint view* — the live `browseItemCount`
window (plus mandatory items) — held nothing dispatchable: the dispatcher does
not scan hidden backlog (WL-0MUNS8X97007C9H9; see *Sprint-view-only dispatch
window* above) **except** via the coordination leader's bounded own-backlog
fallback, which dispatches before this reason is returned and then hands off
leadership (WL-0MUU4XFU90008E24; see *Own-backlog fallback & leadership
hand-off* above). In
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
- **Peer offer suppresses the pause (WL-0MVP7QHUB003ZA2A AC2).** The probe
  answers only "is the **leader's own** root empty?". A peer entry in the
  offer list with a non-empty `workItemId` means the backlog is not empty —
  it is somebody else's root — so the pause must not arm: the pause is a full
  stop that does not poll the offer list at all, and arming it would starve
  that offer for up to the whole cooldown (the live 2026-10-26 incident: an
  idle leader paused for 60 min while ContextHub's offer sat undispatched).
  The arming check (`hasPeerOffer`, `coordination.ts`) is a cheap in-memory
  scan of the coordination entries **already read for that dispatch** — never
  a second worklog CLI probe. It is deliberately conservative/fail-open (a
  stale peer entry only costs an idle tick); an instance's own entry never
  counts, and neither does an entry with an empty `workItemId`. The cooldown
  duration (`downtimeNoCandidateCooldownMs`, 60 min) is unchanged and still
  arms when there is genuinely nothing anywhere. The empty-leader step-down
  still fires on that cycle (see *Own-backlog fallback & leadership hand-off*
  above) — the peer offer then dispatches after the hand-off instead of being
  starved.
- **Check-in is never suppressed:** the cooldown gate runs AFTER the
  leader-election/check-in block, so the coordination check-in
  (the only re-offer mechanism) still lands during a pause and the leader
  lease keeps refreshing (self-healing `refreshLease()` renews an
  owned-but-expired lease — the zombie can never lose its renewal path).
  A successful re-offer
  (`checkIn.updated && offered !== null`) cancels the pause immediately.
- **Coordination check-in cancels, peer presence cancels
  (WL-0MVP7QHUB003ZA2A AC3):** the same check-in tick also cancels an armed
  pause when the offer list holds a **peer** entry with a non-empty
  `workItemId` (`hasPeerOffer`). An offer that appears *during* a pause is
  therefore dispatchable on that very tick instead of waiting out the full
  cooldown — the pause is cleared before the cooldown gate below reads it.
  Fail-safe: an unreadable/corrupt coordination file resolves to an empty
  entry list, so no peer is detected and the pause is left exactly as it is
  today.
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
| **Proxy-slot gating** (per-slot availability / `contention_queue_depth` / per-slot `lease_state` / prefill gate) | the Local Proxy | live slot availability, queue depth, lease state (v2 distinguishes `generating` from `idle_leased`), `capacity_hint`, prefill in-flight/cap/waiters and prefill ETAs | ineligible/skip audit dispatch (per-tier minimum 2 free slots), `proxy-contention`, `capacity-saturated`, `prefill-gate` / `prefill-cap` / `prefill-eta`; unusable per-slot detail → `slots-unavailable` |
| **`AUDIT_PHASE2_PARALLELISM=1`** (always) | the audit skill's child fan-out | Phase 2 deep-analysis children | parent + one child = exactly 2 local slots (fully serial Phase 2) |

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

### Depth-aware audit batching (parent WL-0MVEDM8OT007WDRS)

**Problem.** The audit tier resets the idle tracker after every successful
dispatch, so a backlog of auditable `completed`/`in_review` items drains at
most one audit per full idle period — on a busy host the audit queue can sit
untouched for hours even though the proxy is free between audits.

**Contract.** When the queue is deep, one continuous idle window may issue up
to `downtimeAuditBatchMax` **sequential** audit dispatches. The audits stay
serialised globally: at most **one audit is active on the host at any
moment** (see *Host-wide audit serialisation* above) and the audit runner's
Phase 2 remains fully serial (`AUDIT_PHASE2_PARALLELISM=1`). Batching removes
only the *fresh full idle period* requirement **between** consecutive audits
of an already-deep queue.

**Setting.** `downtimeAuditBatchMax` (plugin settings,
`~/.config/herdr/worklog-plugin.json`) — default **`2`**, clamped to
**`[1, 5]`** (`DEFAULT_DOWNTIME_AUDIT_BATCH_MAX`,
`DOWNTIME_AUDIT_BATCH_MAX_MIN` / `DOWNTIME_AUDIT_BATCH_MAX_MAX`,
`clampDowntimeAuditBatchMax` in `downtime-worker.ts`);
non-finite/missing/invalid input falls back to the default. `1` means
**batching off** and restores the legacy single-dispatch-per-idle-window
behaviour. The setting is re-read every tick like
`browseItemCount` / `downtimeMaxAttempts`, so a change applies without a
plugin restart.

**Activation rule.** A batch is armed only when **both** hold:

1. the **audit-eligible depth** is at or above the live `browseItemCount`
   threshold (the same "deep review queue" signal the review-queue gate
   uses), and
2. the clamped `downtimeAuditBatchMax` is **greater than 1**.

The depth is derived from the **already-fetched Herdr head** — the count of
items where `classifyItemForDispatch(item, now) === 'audit'` (root
`completed`/`in_review`, excluding fresh-audited, producer-review,
assignee-held and soft-deleted items) via `computeAuditEligibleDepth`. No
second eligibility definition exists and no additional `wl` subprocess is
added to the common dispatch path. Below the threshold, or with the cap at
`1`, the worker behaves exactly as before: one dispatch followed by a full
idle-tracker reset (`tracker.record(false)` / `perSlotTracker.record([])`).

**Sequential single-audit safety invariants (nothing is relaxed).** Every
gate is still re-checked on **every** tick, including a continuation tick;
the **only** deferral is the dispatcher's own post-dispatch idle reset:

- the continuous idle-duration gate (`downtimeIdleThresholdMs`),
- `DOWNTIME_AUDIT_MIN_FREE_SLOTS = 2` (the audit tier's per-tier minimum),
- per-slot ownership (`slotOwned`) and proxy contention
  (`contention_queue_depth == 0`),
- code freeze, the host-wide `active-audit` marker and the per-worklog
  `audit-in-flight` single-flight marker,
- the dispatch-pipeline single-flight and the dispatched-marker exclusion —
  each continuation must select a **distinct** item, enforced by the existing
  marker guards plus an explicit batch-local exclusion set of ids already
  dispatched in the window.

A continuation that fails any gate is a **refusal that ends the batch** — it
never target-hops to a different item.

**Batch lifetime (in-memory per worker instance).** The budget is armed with
`auditBatchMax` dispatches and counts down. It is cleared — restoring the
legacy fresh-idle-period requirement — when any of the following happens:

- the cap is reached or the audit-eligible depth drops below
  `browseItemCount`;
- a **non-audit** dispatch occurs (critical/implement/plan/intake/
  risk-effort);
- an audit dispatch ends in any non-`dispatched` outcome (`claim-failed`,
  `claim-rolled-back`, `spawn-failed`, `marker-write-failed`,
  `anchor-unavailable`, `wl-error`, or a gate refusal);
- the worker pauses/cooldowns, leadership is lost, the proxy reports
  busy/ambiguous/stale per-slot data, or no owned slot can host a
  continuation.

The state is in-memory (like `lastDispatchAt` / `cooldownUntil`), so a plugin
restart starts a fresh batch.

**Coordination-mode continuation & deferred leadership hand-off.** The
production path is coordination mode, where the leader dispatches at most one
offer per tick. While a batch is armed, `dispatchFromCoordination` first runs
an **audit-only** continuation over the leader's own Herdr head **window
extension** (the bounded `fetchExtendedHerdrItems` tail of its own head — the
head itself is the already-considered ranking prefix) and
dispatches at most one continuation audit per invocation. The scan is factored
into `dispatchFromOwnHead`, so a continuation applies the **identical**
sequential filter chain as the own-backlog fallback (classify → dispatched
marker id-guard → attempt budget → non-terminal cooldown → code-freeze → audit
≥ 2 free slots → critical in-flight guard → review-queue hold) and only
`audit` items are eligible. If no audit candidate survives, the unchanged
all-kinds own-backlog fallback runs.

An own-backlog dispatch normally steps down leadership immediately
(WL-0MUU4XFU90008E24). During a batch the step-down is **deferred to batch
end**: mid-batch continuations do not call `releaseLeadership()`; the
step-down fires exactly once, on the continuation (or the batch-ending
dispatch) that reaches the cap or observes the depth drop. A failed
continuation never hands off.

**Trade-off — proxy-busy caveat.** Only the dispatcher's *own* post-dispatch
reset is deferred. The dispatched audit pane's own occupancy makes the proxy
busy, and a busy poll both resets the idle tracker through the normal per-tick
busy path **and ends the batch window** (a busy poll closes the continuous
idle window, so the budget is cleared and a fresh full idle period is
required). A continuation therefore only fires while the proxy stays idle at
the next poll — fast/quiet audit panes drain in sequence; a busy interlude
restarts the fresh-idle requirement and the next audit dispatch re-arms a
fresh batch while the queue is still deep. Batching is a queue-drain
optimisation, never a relaxation of the idle-duration gate.

**Observability.** Accepted continuations log the observation token
`audit-batch-continue`; a silently deactivated batch logs `audit-batch-end`
(cap/depth). Blocked/held continuations reuse the existing refusal token
(`audit-in-flight`, `audit-host-saturated`, `code-freeze`, `slot-owned`,
`proxy-contention`, `review-queue-hold`, `no-candidate`, `slots-unavailable`)
and gain the additive `auditBatchDepth` / `auditBatchCap` /
`auditBatchRemaining` metadata — see *Decision-log entries: audit-batch tokens
& metadata* under *Log schema*.

**Tests.** `downtime-worker.settings.test.ts` pins default/clamp/parse;
`downtime-worker.audit-tier.test.ts` pins the activation rule, the sequential
continuations and the gates that block them;
`downtime-worker.dispatch.test.ts` pins the shallow-depth legacy behaviour;
`coordination-dispatch.test.ts` and `downtime-worker.orchestrator.test.ts` pin
the continuation, the batch-local exclusion set, the failing-continuation
batch end and the deferred leadership hand-off.

#### Verification record (WL-0MVFE1IRB0004X1U, 2026-10-20)

The batch feature (parent WL-0MVEDM8OT007WDRS) was verified as one slice at
`dev` head **4bdc1201**:

| Command | Result |
| --- | --- |
| `npm --silent test -- packages/herdr/src` | **107 files / 3510 tests passed** (no failures, no unhandled rejections) |
| `python3 run_tests.py --scope full` (the configured dev-push gate: `tests/cli` + `tests/unit` at the time of this run; since WL-0MVG4FF9200346NR the canonical gate is the single `tests/` umbrella) | green |
| doc-consistency scan for stale "single-dispatch-only" claims | clean — the only `single-dispatch-per-window` mentions are the deliberate `1` = legacy/off descriptions |

**AC traceability.**

| AC | Implementation | Pinned by |
| --- | --- | --- |
| AC1 depth-aware batching | `computeAuditEligibleDepth`, `resolveAuditBatchStatus`, `clampDowntimeAuditBatchMax`, worker `activeAuditBatch` budget | `downtime-worker.settings.test.ts`, `downtime-worker.audit-tier.test.ts`, `downtime-worker.orchestrator.test.ts` |
| AC2 sequential single-audit safety | conditional reset in `tick()` (every gate re-checked); continuation runs through the unchanged filter chain | `downtime-worker.audit-tier.test.ts` (idle gate, ≥ 2 slots, markers), `coordination-dispatch.test.ts` |
| AC3 no duplicate / re-dispatched items | marker id-guard + `auditBatchDispatchedIds` batch-local exclusion; any non-`dispatched` continuation ends the batch | `coordination-dispatch.test.ts` (AC3, AC6f, batch-local exclusion), `downtime-worker.audit-tier.test.ts` |
| AC4 coordination-mode compatibility | `dispatchFromOwnHead` audit-only continuation from the leader's own head; deferred `ownBacklogDispatch` step-down | `coordination-dispatch.test.ts` (AC4) |
| AC5 observability | `audit-batch-continue` / `audit-batch-end` observation tokens with depth/cap/remaining; existing tokens unchanged | `downtime-worker.orchestrator.test.ts` (batch decisions + metadata), `downtime-log.test.ts` |
| AC6 herdr test coverage | (a)–(f) specs across the four suites named above | `downtime-worker.dispatch.test.ts`, `downtime-worker.audit-tier.test.ts`, `downtime-worker.orchestrator.test.ts`, `coordination-dispatch.test.ts`, `downtime-worker.settings.test.ts` |
| AC7 documentation | this document, `packages/herdr/README.md`, code comments | this verification record |
| AC8 full suite | herdr package suite + configured gate | table above |

Known gate gap (discovered, not fixed here): the configured dev-push gate ran
`tests/cli` + `tests/unit` only, so the herdr package suite is invoked
explicitly for herdr-touching items — tracked as WL-0MVGJ4WSS005BMSI. (Since
WL-0MVG4FF9200346NR the canonical gate is the `tests/` umbrella command, which
covers every `tests/` file but still not `packages/` — see the coverage table
in `docs/dev/test-suite-baseline.md`.)

### Soft-delete exclusion (SA-0MUJBLZC60085DI9)

Every dispatch path excludes soft-deleted items — those with a non-empty
`deletedBy` (set by `wl delete`, which may leave the item's `status`
untouched). `isSoftDeleted()` (trim-aware) is applied in
`classifyItemForDispatch` (the Herdr-head and coordination paths) and in every
`select*` helper (audit, implement, plan/intake, critical). The parse helpers
(`parseNextCandidatesOutput`, `parseImplementCandidatesOutput`,
`parseCriticalCandidatesOutput`, `parseAuditCandidatesOutput`,
`parseShowItemOutput`) carry `deletedBy` to those filters, and the fetcher's
`normalizeItem` preserves it so the live Herdr head carries the field. Before
this guard a deleted item whose status was not `deleted` could be re-selected
and worked a second time. The guard is a neutral sequential filter (never a
strike, never `no-candidate` metadata) and is a single-field check, so it has
negligible cost.

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
  `downtime-worker.gates.ts`): ONE bounded `wl list` per dispatch/offer computation, applied
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
ONE `freeSlots` snapshot **derived from the per-slot array** — the only
trusted availability source (fail-closed contract, WL-0MUXVPXAZ005RESW) —
forwarded to the sole
dispatch call — no per-worklog duplication (F5 WL-0MTII48OV008P2QU;
WL-0MT50LKAK001EF5Q single cap source). v1 scope is single-machine; a
multi-machine (real flock/NFS) extension is future work.

#### Cross-root `assignee` merge rule (WL-0MV85WBZ2004VDUQ)

`assignee` is a scheduling hold, not a protected data field: assigning an item
holds it from auto-dispatch and clearing the assignee releases it. Cross-root
sync therefore treats a cleared `assignee` (`''`) as **meaningful intent**
rather than an absent/default value:

- `assignee` is **not** a regression-guarded merge field (it is absent from
  `mergeParticipatingFields` in `src/sync.ts`). A newer remote `''` clears a
  local non-empty assignee and propagates **without** `--accept-regressions`.
- Empty-vs-non-empty assignee merges resolve **last-writer-wins** by
  `updatedAt` (deterministic lexicographic tie-break at equal timestamps) via
  `isEmptyMeaningfulField()` — so a stale local claim can never resurrect a
  released hold, and a newer local hold is not cleared by a stale remote `''`.
- `status`, `stage` and `priority` remain regression-guarded unchanged: a
  newer remote default is still refused and the local value kept.

Rationale and the accepted answer to the epic's Q1 live in the parent epic
appendix (Option A — status-neutral assignee CAS claim). Cross-root coverage:
`tests/cli/sync-assignee-clear.test.ts` (two worklog roots, real `wl sync`).

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
   block the OTHER free unowned slots. The lease is a **decision-log signal
   only** (`ownerPresent`): the ownership gate itself is derived from the
   trusted per-slot array (a slot with a live `owner_session_id` is never
   free). The maximum is pinned in code as
   `LOCAL_DISPATCH_LEASE_MAX_SECONDS`; if `llm-manager` changes the default,
   revisit that constant and this section so the assumption cannot drift
   silently again.
2. **Per-slot owner tracking (AC5)** — `LlamaSlot` carries an optional
   `owner_session_id`; `countFreeUnownedSlots` excludes owned slots from the
   free count and the per-slot idle tracker resets an owned slot's timer, so
   a slot with a live lease is never considered available for a new pane.

   **Fail closed on unusable per-slot detail (WL-0MUXVPXAZ005RESW).** The
   proxy serves `slots: []` together with `slots_stale: true` when its fresh
   `/slots` query fails: the slot COUNTS come from the last-known cache but
   the per-slot detail is unavailable. An empty array is **not** "zero free
   slots". Under the fail-closed contract, absent, empty, or stale per-slot
   detail is **unusable**: the worker refuses to dispatch and records the
   distinct reason `slots-unavailable` (header token `no-slots`), so a
   fail-closed stop is distinguishable from `slot-owned` / `proxy-contention`
   in the decision log and herdr header. The inaccurate count-based fallback
   (and its `countBasedFreeSlots` / `countBasedSpareCapacity` / `leaseReserve`
   / `ownerLeaseCount` helpers) has been **removed** — `available_slots` is
   never used as a dispatch budget. The proxy-side improvement (serve cached
   per-slot detail when stale) is tracked separately in `llm-manager`
   (LP-0MUFSVXID0039ZAQ).
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
  a `paneCloseIdleThresholdMinutes` idle threshold (default 0 — idle close
  disabled — clamped [0, 1440]) and a `paneCloseGracePeriodMinutes` grace
  period (default 5, clamped [1, 1440]).

The reaper classifies each Herdr pane via the shared `classifySession()`
module (`packages/herdr/src/pane-close.ts`): close when the final assistant
message ends with `</end_session>`, or (only when the idle threshold is
positive) when the agent is alive but idle beyond the threshold. It never
closes an `implement` pane, an item awaiting producer review, the invoking
pane, a pane with live children, or a pane still within its grace period. A
dead agent is **not** closed — the operator may still need to read the final
output. A close failure for one pane is recorded and the run continues; a
reaper throw is caught and logged so it can never crash the worker.

**Active-agent signals (parent AC3).** The production deps
(`pane-close-herdr.ts`) populate the classifier's activity signals so
long-running-but-silent agents are not reaped: the raw herdr `agent_status`
(a `work`-class status keeps the pane `active`), recent file modifications
in the pane's workspace (`dirHasRecentModifications`, 2-minute window,
bounded scan), and the count of spawned child processes from
`herdr pane process-info` (excluding the pane's own foreground
process-group leader, so an idle agent is not misclassified as having
children). The work-item stage and producer-review flag are fetched once
per pane (`getItemInfo`) and recorded in every
`CloseReasonSnapshot`/reaper-ledger row (parent AC6).

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
| Dispatch poll interval | **10 s** (`downtimePollIntervalMs`) | `DEFAULT_DOWNTIME_POLL_INTERVAL_MS`, floor 10 s (`downtime-worker.constants.ts`) |
| LLM continuous idle threshold | **75 s** (`downtimeIdleThresholdMs`) | `DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS`, floor 1 s (`downtime-worker.constants.ts`) |
| Proxy status refresh | 30 s (`refreshIntervalMs`) | `settings.ts` (unchanged, pre-refactor cadence) |
| Leader lease TTL | 5 min (`DEFAULT_LEASE_TTL_SECONDS = 300`) | `leader-election.ts` |
| Leader check-in | 4 min (`DEFAULT_LEADER_CHECK_IN_MS`) — leader re-offer + lease renew inside 5-min TTL | `downtime-worker.constants.ts`, `leader-election.ts` |
| Follower check-in | 5 min (`DEFAULT_COORDINATION_CHECK_IN_MS`, WL-0MTMPSCL8000O45H) — non-leader re-offer | `downtime-worker.constants.ts` |
| No-candidate cooldown | 60 min (`downtimeNoCandidateCooldownMs`; probe-before-pause in coordination mode, re-offer cancels) | `downtime-worker.constants.ts` |
| Success-marker staleness window | **24 h** (`downtimeMarkerStaleWindowMs`; clamped to 1 h – 7 d; releases a stranded success marker at an unchanged stage, WL-0MU6UL0RJ008IHGT) | `DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS` (`downtime-worker.constants.ts`), `clampDowntimeMarkerStaleWindowMs` (`downtime-worker.clamps.ts`) |
| Non-terminal pane-close cooldown | **30 min** (`downtimeNonTerminalCooldownMs`; clamped to 1 min – 24 h; holds same-kind re-dispatch after a non-terminal pane close, WL-0MUKYERLZ006ELL5) | `DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS` (`downtime-worker.constants.ts`), `clampDowntimeNonTerminalCooldownMs` (`downtime-worker.clamps.ts`) |
| Per-item/per-kind attempt cap | **3** (`downtimeMaxAttempts`; clamped to 1 – 10; flags `needsProducerReview` and stops re-dispatch of that kind once the cap is reached at the current stage, WL-0MUKYEXMK0033MFK) | `DEFAULT_DOWNTIME_MAX_ATTEMPTS` (`downtime-worker.constants.ts`), `clampDowntimeMaxAttempts` (`downtime-worker.clamps.ts`), `countAttempts` (`downtime-log.ts`) |
| Depth-aware audit-batch cap | **2** (`downtimeAuditBatchMax`; clamped to 1 – 5; `1` = batching off, legacy single-dispatch-per-window; allows sequential audit continuations in one idle window while the audit-eligible depth is at/above `browseItemCount`, WL-0MVEDM8OT007WDRS) | `DEFAULT_DOWNTIME_AUDIT_BATCH_MAX` (`downtime-worker.constants.ts`), `DOWNTIME_AUDIT_BATCH_MAX_MIN`/`MAX`, `clampDowntimeAuditBatchMax` (`downtime-worker.clamps.ts`) |
| Stalled-work scan | enabled (`downtimeStallScanEnabled`; re-read live; `false` disables the pre-dispatch scan and falls through to normal dispatch, WL-0MUYMBK6H005PY16) | `DEFAULT_DOWNTIME_STALL_SCAN_ENABLED` (`downtime-worker.constants.ts`) |
| Stalled-work threshold | **5 min** / `300000` ms (`downtimeStallThresholdMs`; minimum continuous not-`working` duration before an in-place resume; clamped to 60 s – 60 min; invalid/missing falls back to the default, WL-0MUYMBK6H005PY16) | `DEFAULT_DOWNTIME_STALL_THRESHOLD_MS` (`downtime-worker.constants.ts`), `clampDowntimeStallThresholdMs` (`downtime-worker.clamps.ts`) |
| Capacity-starvation alert window | **2 h** (`downtimeCapacityStarvationAlertMs`; clamped to 5 min – 24 h; continuous capacity-refusal run that triggers a `capacity-starved` observation, WL-0MVKNC2N50025HXE) | `DEFAULT_DOWNTIME_CAPACITY_STARVATION_ALERT_MS`, `clampDowntimeCapacityStarvationAlertMs` (`capacity-starvation.ts`) |
| Long-running pane window | **3 h** (`downtimeLongRunningThresholdMs`; clamped to 1 h – 48 h; progress window before a live `working` pane is reported on a starvation signal, WL-0MVKNC2N50025HXE) | `DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS`, `clampDowntimeLongRunningThresholdMs` (`long-running-panes.ts`) |
| Pane-closure reaper cadence | **60 s** (`PANE_CLOSE_REAPER_INTERVAL_MS`; gated by `paneCloseEnabled`, WL-0MUJL1NAH0042GOS) | `pane-close-scheduler.ts` |
| Pane-closure idle threshold | **0 min** — idle close disabled (`paneCloseIdleThresholdMinutes`; clamped to 0 min – 24 h) | `pane-close-scheduler.ts` |
| Pane-closure grace period | **5 min** (`paneCloseGracePeriodMinutes`; clamped to 1 min – 24 h; no pane is eligible for close within this window of first dispatch, WL-0MUMM5IUF003EVT8) | `pane-close-scheduler.ts` |
| (removed) Max running downtime panes | **none** — no client-side pane cap; the LLM idle / free-slot check is the concurrency limiter (WL-0MU2EP6JL006A1U3) | `downtime-worker.constants.ts` |

Both dispatch-poll and idle-threshold are configurable in the herdr plugin
settings file (`~/.config/herdr/worklog-plugin.json`,
`downtimePollIntervalMs` / `downtimeIdleThresholdMs`) and are clamped on
load (see `clampDowntimePollInterval` / `clampDowntimeIdleThresholdMs` in
`downtime-worker.clamps.ts`). The 75 s idle threshold exceeds the 1-minute
slot-exhaustion cooldown so that existing sessions have a chance to reclaim
the slot before a new work item is dispatched. The success-marker staleness
window (`downtimeMarkerStaleWindowMs`) is likewise configurable and clamped
on load
(`clampDowntimeMarkerStaleWindowMs`). The non-terminal pane-close cooldown
(`downtimeNonTerminalCooldownMs`) is likewise configurable and clamped on load
(`clampDowntimeNonTerminalCooldownMs`). The per-item/per-kind attempt cap
(`downtimeMaxAttempts`) is likewise configurable and clamped on load
(`clampDowntimeMaxAttempts`). The depth-aware audit-batch cap
(`downtimeAuditBatchMax`) is likewise configurable and clamped on load
(`clampDowntimeAuditBatchMax`); see *Depth-aware audit batching* above for its
activation rule and the sequential single-audit safety invariants. The stalled-work scan enable flag
(`downtimeStallScanEnabled`) and threshold (`downtimeStallThresholdMs`) are
likewise re-read live every tick and clamped on load
(`clampDowntimeStallThresholdMs`).

## Files & runtime artifacts

| Path | Purpose |
|---|---|
| `packages/herdr/src/dispatcher-anchor.ts` | Project-workspace resolver (`resolveProjectWorkspace`) + item-ID tab anchor (`getItemTabAnchor`) + retained Dispatcher fallback (`getDispatcherAnchor`): CLI parsers, coordination lock, aliveness |
| `packages/herdr/src/machine-coordination.ts` | Machine coordination dir resolver (`~/.herdr/downtime` / `HERDR_COORDINATION_DIR`) |
| `packages/herdr/src/leader-election.ts` | Lock acquisition, lease management, re-election (machine dir) |
| `packages/herdr/src/coordination.ts` | Coordination file read/write (entries, prune, upsert) — machine dir `downtime-coordination.json` |
| `packages/herdr/src/downtime-worker*.ts` | The downtime-worker module family: the barrel (`downtime-worker.ts`, re-exports only) over the sibling modules — worker tick orchestration (`downtime-worker.orchestrator*.ts`, `worker-contract.ts`, `launch-fence.ts`), dispatch (`dispatch.ts`, `dispatch-filter.ts`, `dispatch-claims.ts`, `dispatch-cpu-gate.ts`, `dispatch-contract.ts`), coordination (`coordination.ts`, `coordination-leader.ts`), gates/prompts/stalled-resume, pane, idle/poller, parsers/selection, constants/types/clamps (full layout: [Module layout](#module-layout)) |
| `packages/herdr/src/stalled-work.ts` | Stalled-pane classifier + machine-wide scan + in-place resume orchestrator (`classifyStalledPane`, `scanStalledPanes`, `resumeStalledPane`) |
| `packages/herdr/src/capacity-starvation.ts` | Capacity-refusal episode tracker + `capacity-starved` signal (`CapacityStarvationTracker`, `isCapacityRefusal`, clamp) — observation only (WL-0MVKNC2N50025HXE) |
| `packages/herdr/src/long-running-panes.ts` | Long-running pane detector (`classifyLongRunningPane`, `scanLongRunningPanes`, clamp) — observation only (WL-0MVKNC2N50025HXE) |
| `packages/herdr/src/downtime-log.ts` | Coordination/dispatch rolling logs (per worklog root, retained) |
| `packages/herdr/src/pane-close.ts` | Shared pane-closure classifier (`classifySession`, `extractFinalAssistantText`) consumed by the reaper and `pane-triage` (WL-0MUJL1NAH0042GOS) |
| `packages/herdr/src/pane-close-reaper.ts` | Closure reaper orchestration + CLI (`runReaper`, `runReaperCli`) |
| `packages/herdr/src/pane-close-scheduler.ts` | Periodic scheduling, settings clamps, enabled guard (`runScheduledPaneClose`) |
| `packages/herdr/src/pane-close-herdr.ts` | Production `ReaperDeps` over `herdr pane list` + `herdr pane process-info` + pi session logs (activity probes: agent status, recent file modifications, spawned child processes) |
| `packages/herdr/src/process-group.ts` | Session-scoped child-process teardown (SIGTERM → grace → SIGKILL) |
| `packages/herdr/shared/send-to-pi.sh` | `--anchor <paneId>` \u2192 `herdr pane split --pane <anchor>` (no `pane current` in anchor mode); forwards `--cwd`/`--model`/`AUDIT_PHASE2_PARALLELISM` and injects `HERDR_REQUEST_PRIORITY` from `--request-priority` |
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
| `<worklog-root>/.worklog/local-route.log` | Per-response local-preference route evidence written by the Worklog pi extension (bounded at 2000 lines; `at`/`sessionId`/`preference`/`route`/`fallbackReason`/`model`/`ticket`, WL-0MVLJTV03000KIQZ) |
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

### Decision-log entries: audit-batch tokens & metadata (parent WL-0MVEDM8OT007WDRS AC5)

The decision log (`<cwd>/.worklog/downtime-coordination.log`, entries with
`kind: 'decision'`) records audit-batch decisions alongside the existing
refusal reasons. Every entry keeps today's standard fields (`freeSlots`,
`totalSlots`, `ownerPresent`, `runningPanes`, `contentionDepth`) and the same
rate limit: an identical reason inside `DOWNTIME_DECISION_LOG_MIN_INTERVAL_MS`
(10 min) is suppressed, a reason change always writes. When the proxy serves
them, every entry also carries the capacity/prefill evidence
(`capacityHint`, `statusSchemaVersion`, `prefillsInFlight`,
`maxConcurrentPrefills`, `prefillGateWaiters`, `prefillBudgetSeconds`,
`queueEtaSeconds`, `slotPhases`, `slotPrefillEtaSeconds`); prefill pacing
refusals use the distinct reasons/tokens `prefill-gate`, `prefill-cap` and
`prefill-eta`. The reservation slices add two more distinct tokens:
`reservation-refused` (header token `reservation-lost`, with the proxy's own
reason in `reservationReason` plus `admit: false` / `retryAfterS` /
`projectedWaitS`) and `idle-window-spent` (header token `window-spent`, with
`pendingLaunches`) — see [One launch per idle
window](#one-launch-per-idle-window-parent-wl-0mvikrfp0005jdl8-ac3-slice-c3).
The header blocking
token is still updated on **every refusal** and never on the observation
tokens below.

| Token | Meaning | Batch metadata |
|---|---|---|
| `audit-batch-continue` | An **accepted** audit continuation (never the first dispatch of a batch). | `auditBatchDepth`, `auditBatchCap`, `auditBatchRemaining` — the budget still available **after** this dispatch (`0` on the dispatch that consumes the last continuation). |
| `audit-batch-end` | An armed batch ended **silently** after a successful audit dispatch (cap reached / depth dropped). Emitted at most once per batch-ending dispatch, never for a refusal. | Same three fields plus `auditBatchEndReason: 'cap' \| 'depth'`. |

**Blocked/held continuations reuse the existing tokens unchanged** —
`audit-in-flight` and `audit-host-saturated` (marker blocks), `slot-owned`,
`proxy-contention`, `code-freeze`, `review-queue-hold`, `no-candidate`,
`slots-unavailable` — and gain `auditBatchDepth` / `auditBatchCap` /
`auditBatchRemaining` (the budget still available when the continuation was
held) as **additive** fields whenever a batch was armed. A refusal ends the
batch, so no separate `audit-batch-end` line is written for it. Decisions
with no batch armed keep their existing shape: the metadata fields are
absent.

```json
{"kind":"decision","operation":"no-dispatch","instanceId":"…",
 "reason":"audit-batch-continue","freeSlots":2,"totalSlots":4,
 "ownerPresent":false,"runningPanes":1,"contentionDepth":0,
 "auditBatchDepth":7,"auditBatchCap":2,"auditBatchRemaining":1,
 "at":"2026-10-20T02:00:00.000Z"}
```

### Decision-log entries: reservation evidence (parent WL-0MVIKRFP0005JDL8 AC4, slice C2)

Every polled decision entry produced by a dispatch attempt that asked the
proxy for a capacity ticket carries the reservation evidence as **additive**
fields:

| Field | Meaning |
|---|---|
| `reservationTicket` | `{ id, grantedAt }` — the granted gate ticket (absent on a refusal). |
| `admit` | `true` when the proxy granted this poll, `false` on a `429` refusal. |
| `projectedWaitS` | The proxy's projected wait before local capacity: `0` on a grant, the refusal's `retry_after_s` on a refusal. |
| `retryAfterS` | The refusal's `retry_after_s` deferral advice (refusals only). |
| `reservationReleased` | `true` when a granted ticket could not be forwarded to a pane (marker/spawn failure) — the ticket is treated as released/expired and never reused. |

A refusal uses the proxy's own reason as the entry `reason` (and therefore as
the header blocking token): `reserved-fallback`, `prefill-gate` (shared with
the pacing stop — the same underlying gate), `queue-full`, or any future
reason the proxy introduces (the vocabulary is open and never branched on).
Fail-open dispatches (older proxy: 404/500/timeout) record none of these
fields, so the log shape is unchanged for a pre-feature proxy.

```json
{"kind":"decision","operation":"no-dispatch","instanceId":"…",
 "reason":"queue-full","freeSlots":2,"totalSlots":4,
 "ownerPresent":false,"runningPanes":1,"contentionDepth":0,
 "admit":false,"retryAfterS":12,"projectedWaitS":12,
 "at":"2026-10-24T02:00:00.000Z"}
```

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
| `selectionPath` | string | Which loop selected the candidate: `critical-first`, `normal-scan`, `coordination-offer`, `own-backlog` (coordination own-backlog fallback, WL-0MUU4XFU90008E24), `scheduled-prompt`, or `legacy-tier` |
| `selectionReason` | string | Machine-readable reason: e.g. `no-live-pane`, `marker-stale-escalation`, `in-flight-pane` (skip), `non-critical`, `leader-offer`, `own-backlog-fallback` (WL-0MUU4XFU90008E24), `scheduled-due`, `critical-tier` |
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
  idle dispatch)* and *Interactive pane placement (work-item-ID tabs)*
- Work item: **WL-0MUYI3JAO002BTNL** / **WL-0MUYI3K8H007MPKF** *Interactive
  item-ID-tab placement for worklist dispatch (both channels) and its
  fail-safe placeholder root-pane cleanup* (documented in *Interactive
  dispatch pane placement* above)
- Work item: **WL-0MUMA5OMH0024PN1** *When dispatching a new workload first
  scan all workspaces and panes for stalled work* (+ its children
  WL-0MUYMBK6H005PY16 settings / WL-0MUYMBMCG000Z4WP pane-record enrichment /
  WL-0MUYMBO9X000WDF6 classifier / WL-0MUYMBPZ5004LBFX resume orchestrator /
  WL-0MUYMBSA90092QV2 dispatch wiring / WL-0MUYMBUAK007H10J verification;
  documented in *Stalled-work scan and resume* above)
- Work item: **WL-0MUU4XFU90008E24** *Own-backlog dispatch fallback must
  relinquish leadership* (bounded own-root fallback + voluntary
  `releaseLeadership()` hand-off; documented in *Own-backlog fallback &
  leadership hand-off* above)
- Docs work item: **WL-0MT76H3Z900908TV** (this page)