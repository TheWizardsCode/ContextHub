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
| `downtime-worker.dispatch-claims.ts` | The claim → reservation → admission → placement → marker → spawn pipeline for one selected candidate | *(internal to the dispatch entry)* |
| `downtime-worker.dispatch-placement.ts` | Dispatch pane placement resolution (project workspace + item-ID tab, per-prefix tab, legacy anchor) and the fail-safe placeholder root-pane cleanup | *(internal to the dispatch entry)* |
| `downtime-worker.dispatch-contract.ts` | The dispatch pipeline's dependency boundary + event/outcome types | `DowntimeDispatchEvent`, `DowntimeErrorEvent`, … |
| `downtime-worker.dispatch.ts` | The dispatch entry point + the single `dispatchInFlightCount` (single-flight) | `dispatchDowntimeWork` |
| `downtime-worker.local-reservation.ts` | The local-capacity reservation handshake (wire contract, tolerant 429s) | `createLocalReserver`, `parseLocalReservationResponse` |
| `downtime-worker.audit-availability.contract.ts` | The proxy audit-availability read's WIRE types + fail-closed parser (provisional path, sibling proxy item `LP-0MW95FYMH006XYNK`) | `parseAuditAvailabilityResponse`, `AuditAvailability`, `AUDIT_BUDGET_SATURATED_REASON`, `AUDIT_BUDGET_UNKNOWN_REASON` |
| `downtime-worker.audit-availability.ts` | The fail-closed audit-availability `GET` client — one bounded call, one typed outcome; consumed by the audit pre-check and admission (WL-0MWAMSDNW000SL0E) | `createAuditAvailabilityClient` |
| `downtime-worker.stalled-resume.ts` | Prefer resuming a stalled pane in place over opening a new one | `resumeStalledWorkIfAble` |
| `downtime-worker.coordination.ts` | The coordination OFFER computation (one item per instance per check-in) | `computeMostImportantItem`, `coordinationTierRank` |
| `downtime-worker.coordination-leader.ts` | Leader-side coordination dispatch, own-head fallback, check-in | `dispatchFromCoordination`, `runCoordinationCheckIn` |
| `downtime-worker.head-scan.ts` | Bounded head/extension candidate scan over ONE root, plus the registered-root sweep that applies it per root in round-robin order | `dispatchFromOwnHead`, `dispatchFromRegisteredRoots` |
| `downtime-worker.worker-contract.ts` | The injected dependency boundary (`DowntimeWorkerDeps`) + config/result/handle types | `DowntimeWorker`, `DowntimeWorkerDeps` |
| `downtime-worker.launch-fence.ts` | One-per-idle-window launch fence (closes the stale-status launch window) | `createIdleWindowLaunchFence` |
| `downtime-worker.orchestrator-dispatch.ts` | Per-tick dispatch admission and the dispatch attempt (shared tick context) | *(internal to the orchestrator)* |
| `downtime-worker.orchestrator-tick.ts` | The per-tick state machine: markers, leader/check-in, cooldown/three-strike, decision log | *(internal to the orchestrator)* |
| `downtime-worker.orchestrator.ts` | The worker factory and returned handle | `createDowntimeWorker` |
| `host-dispatch-budget.ts` | Machine-scoped dispatch-budget ledger + machine configuration (`budget.json`, env overrides, clamps) and its pure decision helpers (F1) | `readBudget`, `reserve`, `release`, `reap`, `sweepClosedPanes`, `liveCount`, `freshCount`, `readBudgetConfig`, `computeOverQuota`, `reduceAuditDisplayCounts` |
| `host-dispatch-budget.admission.ts` | The dispatcher's single host-budget admission read for both tiers (proxy-derived audit admission, fail closed + self-heal repair) (F2/F3) | `admitHostDispatch`, `decideAuditAvailability`, `detectAuditDivergence`, `readAuditBudgetState` (legacy only), `confirmHostDispatch`, `releaseHostDispatch` |
| `host-dispatch-budget.interactive.ts` | User-fired over-quota gate half: tier detection and prompt-then-claim (F4) | `budgetKindForAgentCommand`, `prepareInteractiveAgentDispatch` |
| `host-budget-dialog.ts` | Pure bottom-anchored over-quota dialog + the renderer↔awaiter prompt host (F4) | `formatHostBudgetDialog`, `overlayHostBudgetDialog`, `createHostBudgetPromptHost` |
| `host-budget-status.ts` | Read-only host-budget status for the worklist `n/max` counter and the stderr skip line (F5) | `readHostBudgetStatus`, `hostBudgetStatusText`, `hostBudgetSkipLine` |

Layering: extracted modules import concrete siblings — never the barrel — so
the import graph stays acyclic (enforced by
`packages/herdr/test/split-guard/scan.ts`, suite
`downtime-worker.split-guard.test.ts`).

### dispatcher-anchor module layout (WL-0MVGKHCP9005SJPZ)

`packages/herdr/src/dispatcher-anchor.ts` is likewise a **thin barrel** — a
module-level doc comment plus re-export statements only, re-exporting exactly
the 32 symbols consumers import from `./dispatcher-anchor.js`. Every behaviour
lives in the sibling modules below; each carries a doc comment stating its
single responsibility, and no family module exceeds 1,000 lines (enforced by
`dispatcher-anchor.split-guard.test.ts`).

| Module | Single responsibility | Key exports (consumer-facing) |
|---|---|---|
| `dispatcher-anchor.contract.ts` | Constants and shared type declarations; a pure leaf with no imports | `DISPATCHER_ANCHOR_FILE`, `DISPATCHER_WORKSPACE_LABEL`, `PLUGIN_PANE_LABEL`, `DispatcherAnchor`, `DispatcherAnchorDeps`, … |
| `dispatcher-anchor.cli-parsers.ts` | Decode raw `herdr` JSON envelopes and `/proc/<pid>/environ` blobs into the contract types | `parseTabListOutput`, `parseTabCreateOutput`, `parsePaneListOutput`, `parseMachinePaneListOutput`, `parsePaneProcessInfoOutput`, `parseProcEnviron` |
| `dispatcher-anchor.herdr-cli.ts` | Run the `herdr` binary, read pane process environments, and build the production deps object | `createDispatcherAnchorDeps`, `listMachinePanes`, `getPaneProcessInfo`, `readProcEnvironFile`, `listTabsInWorkspace`, `listPanesInWorkspace`, `createTabInWorkspace` |
| `dispatcher-anchor.persistence.ts` | Atomic anchor and per-prefix tab-anchor file persistence (fail-closed reads) | *(internal to the family — not re-exported by the barrel)* |
| `dispatcher-anchor.tab-anchors.ts` | Strategies 2 and 3: per-prefix tabs and the machine-wide Dispatcher anchor, including the coordination lock and stale-pane re-provision | `getDispatcherAnchor`, `getDispatcherTabAnchor` |
| `dispatcher-anchor.placement.ts` | Strategy 1: project-workspace resolution and the item-ID tab anchor (ambiguity rules, create-vs-reuse) | `resolveProjectWorkspace`, `getItemTabAnchor` |

Layering: extracted modules import concrete siblings (and the coordination
primitives), never the `dispatcher-anchor.js` barrel at runtime, so the import
graph stays acyclic.

### downtime-log module layout (WL-0MVGKHFT4003X6JW)

`packages/herdr/src/downtime-log.ts` is likewise a **thin barrel** — a
module-level doc comment plus re-export statements only, re-exporting exactly
the 54 symbols the pre-split module exported from `./downtime-log.js` (44 of
them are actually consumed). Every behaviour lives in the sibling modules
below; each carries a doc comment stating its single responsibility, and no
family module exceeds 1,000 lines (enforced by
`downtime-log.split-guard.test.ts` over the frozen surface recorded in
`downtime-log.split-baseline.json`).

| Module | Single responsibility | Key exports (consumer-facing) |
|---|---|---|
| `downtime-log-storage.ts` | File names, retention/rotation policy, atomic bounded JSONL append, tolerant line parsing | `DOWNTIME_LOG_FILE`, `COORDINATION_LOG_FILE`, `DOWNTIME_LOG_MAX_ENTRIES`, `COORDINATION_LOG_MAX_ENTRIES`, `resolveCoordinationLogPolicy`, `coordinationLogPolicyFromConfig`, `CoordinationLogPolicy` |
| `downtime-log-budget.ts` | Host-budget refusal vocabulary + evidence shape (pure leaf, no imports) | `HOST_BUDGET_IMPLEMENT_REASON`, `HOST_BUDGET_AUDIT_REASON`, `HOST_BUDGET_UNKNOWN_REASON`, `HOST_BUDGET_DECISION_REASONS`, `isHostBudgetDecisionReason`, `HostBudgetEvidence` |
| `downtime-log-coordination.ts` | Coordination/decision entry shape, its fail-closed append, the readers (current file and rotated history) and the per-hour reason tally | `CoordinationLogEntry`, `appendCoordinationLogEntry`, `readCoordinationLogEntries`, `readCoordinationLogAllEntries`, `hourlyReasonTally`, `HourlyReasonCount` |
| `downtime-log-entries.ts` | Dispatch-log entry shapes, pane-close lifecycle entries, fail-closed appends, fail-safe reader, and the marker-vs-lifecycle predicate | `DowntimeLogEntry`, `PaneCloseLogEntry`, `PaneLifecycleOutcome`, `PaneLifecycleKind`, `appendDowntimeLogEntry`, `appendPaneCloseLogEntry`, `readDowntimeLogEntries` |
| `downtime-log-markers.ts` | Dispatched-marker readers, staleness/stage guards, per-item attempt budget, non-terminal pane-close cooldown | `auditDispatchedItemIds`, `implementDispatchedItemIds`, `recentAuditDispatchedItemIds`, `dispatchedItemMarkers`, `markerStillExcludes`, `countAttempts`, `isNonTerminalCooldownActive`, `planDispatchedItemStages`, `intakeDispatchedItemStages` |
| `downtime-log-recent.ts` | Read-only "recent dispatches" projection and its 4-hour UTC time blocks | `recentDispatchedItems`, `RecentDispatchRow`, `groupRecentDispatchesByTimeBlock`, `DispatchTimeBlock`, `dispatchTimeBlockLabel`, `DISPATCH_TIME_BLOCK_HOURS` |

Layering: `downtime-log-storage.ts` and `downtime-log-budget.ts` are leaves;
`downtime-log-entries.ts` builds on storage; `downtime-log-markers.ts` and
`downtime-log-recent.ts` build on entries. No family module imports the
`downtime-log.js` barrel, so the import graph is acyclic (asserted by
`downtime-log.split-guard.test.ts`).

## Ranking contract (WL-0MTK1ILM2009QYB2) — dispatcher == Herdr list head

The downtime dispatcher does **not** maintain its own ranking. The Herdr selection list
(`packages/herdr/src/fetcher.api.ts:fetchNextItems` → `smart-selection.ts:selectWorkItems` →
`grouping.ts:regroupWorkItems`) is the **sole** ranking path (mandatory-always for critical +
`completed`/`in_review`, `browseItemCount` windowing of "other" items, grouping logic,
`reSort`/`computeScore` as used by the fetcher). The dispatcher (`dispatchDowntimeWork`,
and the coordination leader path `dispatchFromCoordination`) derives
its candidate from the **Herdr list head** (first ordered item) and applies every remaining
safety gate as a **sequential filter** on that ordered sequence (scheduled-prompt → code-freeze
→ producer-review gate (WL-0MTIAL65N004T22F) → dispatched-marker → free-slot minimums →
host-wide dispatch budget → freshness/recency → CAS claim → spawn). **Critical escalation
(WL-0MU6UL3XY001M3VT):** before the normal sequence walk, open critical items in the head are
escalated by `selectCriticalFirstCandidates` — a blocked critical item bypasses the NON-safety
filters (dispatched-marker, review-queue hold) while the safety gates above still apply — so
critical work is never starved by lower-priority items occupying the window (see the
*Critical-first tier* section). If no head item passes the filters, the dispatcher reports
"no candidate" rather than falling back to a second ranking.
No `wl next`/database scoring change is required; the observable contract is
"dispatcher == Herdr list head". The head is fetched with the **live per-root
`browseItemCount`** limit (clamped 1–50) as its *initial* window — see
*Whole-backlog dispatch window* below.

### Whole-backlog dispatch window (WL-0MW9XS0XR007K1TH)

> **Supersedes the sprint-view-only restriction of WL-0MUNS8X97007C9H9.** That
> item bounded the whole dispatch candidate universe to the rendered view. This
> contract restores WL-0MU6UL3GQ0015AA5's whole-backlog reach **without**
> reintroducing its unbounded-read cost: every ranked work item is a dispatch
> candidate, in the canonical prioritisation order, still bounded by every
> budget and safety gate.

**Any work item is dispatchable.** Both selection paths pass the live per-root
`browseItemCount` setting — clamped to `1`–`50` by `resolveSprintViewWindow`
(`packages/herdr/src/browse-window.ts`), the same clamp the TUI applies — as
the **initial** `getHerdrListHead` window, then walk the rest of the ranked
backlog:

- `dispatchDowntimeWork` (direct dispatch), and
- `computeMostImportantItem` (the coordination check-in offer).

When the initial window yields no candidate, `fetchExtendedHerdrItems` re-reads
the **same ranking path** with a larger window — a window extension, never a
second ranking — and returns the newly visible items. The window grows
**geometrically** (`max(current.length + DOWNTIME_DISPATCH_EXTEND_MAX,
current.length * 2)`), so a deep item costs O(log n) reads rather than one read
per 30 items. The walk stops as soon as a candidate dispatches, so the extra
reads are paid only when the visible window yields nothing, and it is bounded
by `DOWNTIME_DISPATCH_EXTEND_MAX_ROUNDS` (20) as a defensive stop against a
pathological provider.

**Both critical and non-critical items are eligible** — there is no
critical-only filter on the extension. The leader-side paths (own-backlog
fallback, audit-batch continuation, registered-root sweep) use
`fetchWholeBacklogTail`, which loops the same primitive until the backlog is
exhausted.

**The TUI worklist is unchanged**: it keeps rendering exactly
`browseItemCount` items (plus the mandatory set). The window bounds only
*rendering*; it no longer bounds *dispatch*.

**Prioritisation is unchanged.** Ordering remains
`fetchNextItems` → `selectWorkItems` → `regroupWorkItems`: priority
(high → medium → low), then the established stage sub-order, then id. The
annexed extension is the same ranking with more items included.

**Every budget and safety gate still applies** to out-of-window candidates,
unchanged and as sequential filters: the host dispatch budget (the
proxy-owned audit budget / `GET {proxyUrl}/llama/local/audit/status` for the
audit tier; `maxImplement` / the legacy `maxAudit` for the implement/legacy
paths), the per-item/per-kind attempt budget, free-slot minimums, the
code-freeze split-by-skill, the host-CPU gate, the review-queue depth hold,
active-audit single-flight and host saturation, freshness/recency, the
producer-review flag, the `assignee` hold, soft-delete, dispatched-marker
exclusion, the non-terminal pane-close cooldown and the CAS claim.

**Fail-open preserved.** A failed head lookup still resolves `{ok:false}` (the
caller keeps its entry / reports `wl-error`); a failed or empty extended read
stops the walk and degrades to the original terminal reason, so the walk can
never convert a defined outcome into a new failure.

**Relationship to the own-backlog fallback.** Because an instance now offers its
whole ranked backlog at check-in, out-of-view work arrives as a normal
fleet-visible *offer*; the own-backlog fallback below is reached only when no
offer is dispatchable. It remains wired, and its leadership step-down still
fires when it is the path that dispatches.

### Own-backlog fallback & leadership hand-off (WL-0MUU4XFU90008E24)

With the whole-backlog window above, an instance offers its **entire ranked
backlog** at check-in, so out-of-view work normally arrives as a fleet-visible
offer and dispatch needs no special case. The own-backlog fallback below
remains wired for the case where the offer scan yields nothing dispatchable —
with a fairness guard so no instance can monopolise leadership.

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
`leaderManager === null`, `leaderState` hard-coded `true`) has no manager and
no peer to hand off to; its direct path dispatches the whole ranked backlog
(see *Whole-backlog dispatch window*). The TUI worklist is unchanged.

**Relationship to WL-0MUNS8X97007C9H9 (superseded).** That item's
sprint-view-only contract is gone: the dispatcher now considers the whole
ranked backlog on every path, so non-critical out-of-view work is dispatched
directly rather than only through this fallback. Because that work is offered
fleet-wide (not read from a privileged view of a *hidden* backlog), the
step-down guard's original monopolisation premise no longer applies to it —
cross-root fairness is owned by the `selectLeastRecentlyServed` round-robin
cursor. The fallback and both of its step-downs stay wired and tested for the
no-dispatchable-offer case.

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

### Registered-root discovery — sweeping roots with no running instance (parent WL-0MVR8GDJ3008WY3Y, option O1)

**Problem (parent AC1).** The candidate universe above is
`offers ∪ ownBacklog(opts.cwd)`. A worklog root that holds dispatchable work
but has **no running herdr instance** never writes a coordination entry, so the
leader has no path to it: its work is never dispatched even when the leader has
idle capacity and every safety gate would admit the item. The empty-leader
hand-off does not help — there is no peer in that root to hand off to.

**Candidate universe (AC1/AC3).**

```
candidates = offers ∪ sweep(downtimeWorklogRoots) ∪ ownBacklog(opts.cwd)
```

The sweep is **strictly additive and ordered**: it runs only when the offer
list yielded nothing dispatchable, and it runs **before** the leader's own
out-of-view backlog, so a busy leader root can never starve a registered root
(AC4). It lives on the **coordination leader path** (`dispatchFromCoordination`)
only — legacy mode (no coordination directory) is unchanged. When no registry
is configured nothing changes (AC6, below).

**The registry (`downtimeWorklogRoots`, AC6).** An explicit, operator-managed
list of worklog **roots** — the parent of `.worklog/`, matching the
`worklogRoot`/`opts.cwd` semantics, *not* the `.worklog` directory itself.
`loadSettings` clamps then validates it every tick
(`clampDowntimeWorklogRoots` → `resolveDowntimeWorklogRoots`,
`packages/herdr/src/settings.ts`, bound `MAX_DOWNTIME_WORKLOG_ROOTS = 32`):

- a non-array value (including a single-string shorthand) → `[]`;
- non-string entries are dropped, entries are trimmed, blank entries dropped;
- duplicates collapse (first-seen order preserved) and the list is bounded
  **after** filtering, so junk never consumes a slot;
- an entry survives only when it is an **absolute** path that realpath-resolves
  to a directory containing `.worklog/worklog.db`; the stored value is that
  **realpath**, so a symlinked root can never dispatch into an unexpected
  workspace;
- validation is **per entry**: an invalid/unreadable root is dropped on its
  own and never invalidates a good neighbour, and never crashes settings load.

**Fail-safe (AC6).** An absent, empty, or wholly unresolvable registry is a
no-op: `dispatchFromRegisteredRoots` returns immediately on a normalised-empty
list, with no cursor read/write and no extra `wl` spawn. The candidate
universe stays `offers ∪ ownBacklog(opts.cwd)` **byte-for-byte** — today's
behaviour is unchanged for every deployment that does not opt in.

**Canonical ranking, not a second ranking (AC3).** Each registered root is
read through `readOwnHeadWindow` — the same
`getHerdrListHead(root, browseItemCount)` path and the same bounded extension
(`DOWNTIME_DISPATCH_EXTEND_MAX`, 30 items) the own-backlog fallback uses — and
the first eligible item in that canonical order wins. A registered root has no
owner offering its head, so the sweep scans the **whole** window (head plus
extension); the own-backlog fallback still scans only the extension, because
in-view items belong to the offer path.

**Round-robin fairness (AC4).** The sweep starts at the least-recently-served
registry root, selected with the existing `selectLeastRecentlyServed` cursor
from `downtime-round-robin-by-root.ts` (WL-0MTJDX4M4007YH5U) — the same cursor
the offer path uses for cross-root ordering; it advances atomically for the
selected root. The remaining roots follow in **registry order** (the cursor is
a tie break, never a re-ranking). A root with nothing dispatchable does not
end the sweep: the next root is tried, and a dispatch anywhere in the sweep
ends the tick.

**No gate bypass (AC2).** Every swept candidate passes the **full sequential
filter chain** in `dispatchFromOwnHead`, evaluated against **its own root's**
state: classify → dispatched-marker exclusion (id/stage guard) → attempt
budget → non-terminal cooldown → per-root code freeze → host-CPU gate →
leaf-aware audit slot minimum/pin → critical in-flight guard → review-queue
hold → CAS claim. No gate was added, removed or reordered for the sweep, and
the claim/comment/dispatch target resolves to the swept root's own
`--worklog-dir`, so a swept item is claimed and dispatched in its own database.
A gate that holds the only swept candidate surfaces its **neutral** terminal
reason (`code-freeze`, `review-queue-hold`, `in-flight-pane`,
`attempt-budget-exhausted`, `non-terminal-cooldown`, `cpu-saturated`, …) —
never `no-candidate` — so the no-candidate cooldown does not arm on a held
sweep.

**Freeze is per root.** The leader's own tick-level freeze read is reused for
`opts.cwd`; every other registered root gets a fresh
`readCodeFreezeStatus(root)` so its freeze cannot be bypassed (and the
leader's freeze cannot wrongly block it).

**Fail-open (AC5).** A root whose head read throws or resolves `{ok:false}`
(missing/unreadable/not-a-worklog) is skipped without a strike and never
crashes the tick; when every registered root fails, the caller's original
terminal reason is unchanged.

**No leadership hand-off on a sweep.** A swept dispatch is recorded with
`selectionPath: 'registered-root-sweep'` and
`selectionReason: 'registered-root-sweep'`, and deliberately leaves
`ownBacklogDispatch` unset — the leader is serving a *registered* root, not
its own backlog, so it must not step down (stepping down on every sweep would
flap the machine-wide election). The own-backlog hand-off and the empty-leader
step-down are unchanged.

**Composition summary.**

| Order | Source | Scope |
|---|---|---|
| 1 | Scheduled prompts | a due prompt dispatches immediately |
| 2 | Offer list (`downtime-coordination.json`) | live peer offers, file order |
| 3 | **Registered roots (`downtimeWorklogRoots`)** | **round-robin sweep, per-root gates** |
| 4 | Own backlog (`opts.cwd`) | bounded extension, own root only, then hand off |

**Liveness-aware peer predicate (AC7).** Independent of the registry, the
`no-candidate` pause-arm/cancel predicate `hasPeerOffer`
(`packages/herdr/src/coordination.ts`) ignores entries whose `lastUpdated` is
older than `DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS` (24 h) — a crashed
instance can no longer masquerade as a live peer. Treating a stale entry as an
**absent** peer makes the leader *more* willing to sweep/arm the probe, never
less, so the worst case is one extra idle tick polling the offer list. Entry
expiry remains a deliberate no-op (`pruneStaleEntries` returns `0` and never
mutates the file, WL-0MTMPIQBE001J41P); liveness lives only in the read
predicate. See *No-candidate cooldown & the empty offer file* for the full
pause contract.

**Constraints preserved.** The sweep remains a **bounded window over an
explicit registry** (the `downtimeWorklogRoots` setting), not an unbounded scan
of the filesystem, and it never requires a running pane or instance per root —
that is precisely the bug it fixes. Note that the whole-backlog window
(WL-0MW9XS0XR007K1TH) now lets any path reach deep work; the sweep's distinctive
job is *cross-root reach* into roots that have no running instance to offer
work.

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
  are ignored (no double-election; a stable instanceId keeps at most one
  `entries` offer in the machine file).
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
WL-0MTF0KLO10043YAN) stores one offer per herdr instance — `directory` + `worklogRoot`
(the worklog root the item belongs to, so the single leader dispatches across roots),
and no offer at all for an instance whose window is empty:

```json
{"version":1,"entries":[
  {"instanceId":"<uuid>","workItemId":"<wl-id>","directory":"<worklog-root>","worklogRoot":"<worklog-root>",
   "assignedAt":"<iso>","lastUpdated":"<iso>"}
],
 "leader":{"instanceId":"<uuid>","worklogRoot":"<worklog-root>",
           "lastDecisionReason":"slots-unavailable","lastDecisionAt":"<iso>","lastUpdated":"<iso>"}}
```

**The leader block (WL-0MW1VINII003IL7R).** The `entries` array is an OFFER list,
and a check-in removes the instance's own entry whenever its window is empty
("no dead offers"). That left the one instance permitted to dispatch — the
elected leader — absent from the file entirely, so a machine-wide stop was
invisible: during the 2026-11-04 overnight outage the file listed five healthy
offers while nothing dispatched anywhere for eight hours, and the refusals
existed only in one project's per-root `downtime-coordination.log`.

The top-level `leader` block fixes that. It is written by the lease holder on
election, on every leader check-in (4-minute heartbeat) and whenever a decision
token changes, and it records:

| Field | Meaning |
|---|---|
| `instanceId` | the instance holding the lease — the only one that may dispatch |
| `worklogRoot` | the root the leader dispatches for (its own cwd) |
| `lastDecisionReason` | its most recent recorded no-dispatch reason (`slots-unavailable`, `capacity-saturated`, `no-candidate`, …), or `null` |
| `lastDecisionAt` | when that reason was first recorded, or `null` |
| `lastUpdated` | heartbeat, refreshed on every leader check-in |

Read rule: `getLeader()` returns `null` for an absent, malformed or **stale**
block — older than `DEFAULT_LEADER_BLOCK_STALE_MS` (600 s, two lease
generations, tolerating one missed 240 s check-in). A crashed leader therefore
never reads as live.

**It is evidence, never an offer.** No dispatch path reads the block:
`hasPeerOffer`, offer selection, the own-backlog fallback and every gate
consume `entries` only, and writing the block never creates or resurrects an
entry. It is additive and cross-version safe — a pre-feature instance ignores
the key, a new instance reads a legacy file (no `leader`) exactly as before, and
a malformed block is dropped rather than costing the reader its offer list.

Legacy per-worklog `<worklog-root>/.worklog/downtime-coordination.json` is retired
(F6 WL-0MTII4CWT00452HU): once the machine dir is authoritative, stale per-worklog
files are orphaned and ignored, so the leader never double-dispatches from legacy
data and a stale legacy file can never resurrect an offer.

The machine file does **not** carry "exactly one entry per instance": `entries`
is an OFFER list, so an `instanceId` holds **at most one** offer (upsert, never a
duplicate) and **no** entry at all while its window is empty or its offer was just
dispatched — the top-level `leader` block, not an entry, is what records the lease
holder's liveness. Unreadable/missing machine files degrade to "no dispatch this
cycle" (fail-safe).

Lifecycle (`packages/herdr/src/coordination.ts`, WL-0MTMPIQBE001J41P non-expiring contract):

1. **Check-in** — every instance reads the file on startup; leaders re-offer every ~4 minutes
   (`DEFAULT_LEADER_CHECK_IN_MS = 4 min`) and followers every 5 minutes
   (`DEFAULT_COORDINATION_CHECK_IN_MS`, WL-0MTMPSCL8000O45H — was 30 min, clamped ≥ 60 s),
   recomputing their worklog's **most-important item** (or removing their entry on a genuinely empty backlog / `wl` error fail-open — entry retained) and upserting (`add` if absent, `update` if changed). A **dispatch-disabled** instance with `downtimeOfferOnly: true`
   also checks in on the follower cadence (WL-0MWDDHOK6009GJCC — see *Offer-only mode*
   below), so a passive root still contributes an offer to the leader. When the leader removes an entry on dispatch, the owning instance re-offers **immediately** on its next tick (observed missing-own-entry, no extra poll loop; fail-open on unreadable file degrades to next interval — WL-0MTMPSCL8000O45H AC2). The leader also renews the lease inside its 5-min TTL (`DEFAULT_LEASE_TTL_SECONDS = 300`) on the same cadence. Leadership is re-derived every tick from the lease file; a missing/unreadable coordination or lease file is fail-safe (no dispatch that cycle, never a crash, check-in cadence does not spin-loop on errors).
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
   **no** offer passes, the leader first sweeps the registered worklog roots
   (`downtimeWorklogRoots`) in round-robin order through the same ranking and
   the same sequential gates (see *Registered-root discovery* above). If that
   sweep finds nothing dispatchable, it then performs one bounded own-backlog
   fallback against its **own** root (`opts.cwd`) and, on a successful fallback
   dispatch, voluntarily steps down via `releaseLeadership()` so another
   instance can take over (WL-0MUU4XFU90008E24; see *Own-backlog fallback &
   leadership hand-off* above).
4. The dispatched entry is **removed** from the coordination file. The
   existing dispatched-marker exclusion and CAS claim mechanisms are
   preserved unchanged.
5. **Non-leaders** skip proxy polling and dispatch entirely — they only
   refresh their lease check (a cheap local file read) and their
   coordination entry. Dispatch-disabled instances with `downtimeOfferOnly`
   contribute an entry exactly like a follower (never pooling, never
   leading) — see *Offer-only mode* above.

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
| `slots_detail_stale`, `slot_counts_stale`, `local_abandoned_slots` | **evidence only** — see *Attributing a stale slot snapshot* below |
| `slots[].prefill_eta_seconds`, `prefill_budget_seconds` | not availability gates; they feed the calibration-gated, occupancy-only prefill-ETA deferral (`prefill-eta`, see *Prefill serialisation pacing* below) |

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

#### Attributing a stale slot snapshot (WL-0MW1VITA8009RLHQ)

The proxy serves **three independent** staleness flags, and `slots_stale`
alone cannot say *which* part of the payload is untrustworthy:

| Flag | Meaning |
|---|---|
| `slots_stale` | the per-slot detail cannot be paired with the counts (the **availability** flag) |
| `slots_detail_stale` | the per-slot `slots` detail is a last-known snapshot |
| `slot_counts_stale` | the served counts (`available_slots`/`total_slots`) are last-known |

All three (plus `local_abandoned_slots`) are parsed with the same optional
contract as `slots_stale`: absent on a pre-feature proxy (behaviour and log
shape unchanged); a malformed value rejects the poll (fail-closed); present →
recorded on the decision entry as `slotsStale`, `slotsDetailStale`,
`slotCountsStale` and `localAbandonedSlots`.

They are **evidence, never a budget.** `slots_stale` remains the availability
flag and `available_slots` is still never used as a dispatch budget
(WL-0MUXVPXAZ005RESW), so "counts fresh, detail stale" is still a
`slots-unavailable` stop — reading it as usable capacity is precisely what
starved dispatch through the 2026-11-04 night, when the proxy served an
8-hour-old detail snapshot with fresh counts while both cached slots were
frozen `is_processing: true`. Before this change that whole distinction
collapsed into one opaque refusal; now the decision entry names the stale
signal (and `localAbandonedSlots` exposes the self-contradictory snapshot), so
"the proxy's `/slots` query is failing" is distinguishable from "only the
counts are cached" using the decision log alone.

#### Why the header keeps a single `no-slots` token (WL-0MW2F2B5W004V57W)

**Decision: the header blocking token is NOT split.**
`decisionHeaderToken('slots-unavailable')` returns `no-slots` for a
stale-detail snapshot and for a plainly unusable payload alike
(WL-0MW1VITA8009RLHQ AC4). This is deliberate, for three reasons:

1. **The header answers one question.** `no-slots` is displayed as
   `[downtime held: no-slots]` in the herdr worklist and answers only *can this
   worker dispatch right now?* The answer is `no` in both cases, and so is the
   operator's action (fix or wait out the proxy's `/slots` path).
2. **The *why* is multi-valued and per-tick.** Three independent staleness
   flags plus the proxy's abandoned-slot count would each need a header
   segment, overflowing a short, stable blocking label and drifting the header
   away from the decision log's vocabulary of record.
3. **The distinction is already recorded elsewhere, on the same entry.** The
   `slots-unavailable` decision entry carries `slotsStale`,
   `slotsDetailStale`, `slotCountsStale` and `localAbandonedSlots` (table
   above), so "frozen detail / fresh counts" is attributable from the decision
   log alone. Splitting the header token would duplicate that evidence and
   change the worklist's blocking display for no diagnostic gain.

The retained-single-token decision is pinned by a test in
`packages/herdr/src/downtime-worker.stale-detail.test.ts` ("keeps one
`no-slots` header token"): a frozen-detail payload and a plain unusable
payload both report `blockReason === 'no-slots'`, while only the stale one
records `slotsDetailStale` / `slotCountsStale` on its decision entry.

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
| `queue_eta_seconds` / `prefill_budget_seconds` | the proxy's projected wait (own prefill + occupancy) and admission budget (LP-0MVGDUV5E005UWBQ); advisory evidence — the ETA alone is never a deferral trigger (see the calibration/occupancy rules below) |
| `queue_eta_occupancy_seconds` / `queue_eta_busy_slots` | the wait behind OTHER in-flight prefills and the slots they occupy (LP-0MVGDUV5E005UWBQ); advisory — the only ETA term that can pace dispatch |
| `prefill_eta_calibrated` | enough samples for the estimate to be actionable (`false` below the proxy's `MIN_CALIBRATION_SAMPLES`); advisory — `false` disables ETA deferral (fail open, see below) |
| `slots[].phase` / `slots[].prefill_eta_seconds` | per-slot prefill phase and calibrated prefill cost (only busy slots count for pacing) |

**Concurrency-budget contract.** On every poll the dispatcher computes an
**effective local dispatch budget** and passes it to the tier chain (and to
`dispatchFromCoordination`):

```
effectiveBudget      = min(freeSlotBudget, prefillCapacityBudget)   # single-pane tiers only
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
- **ETA deferral is calibration-gated and paces on occupancy only.**
  `prefill_eta_calibrated === false` → **no ETA deferral** (fail open): an
  estimate below the proxy's calibration floor (`MIN_CALIBRATION_SAMPLES`)
  mirrors the proxy's own admission guard, which is inert
  (`insufficient_samples`) until then — deferring on an uncalibrated idle
  pool would livelock it (never dispatch ⇒ never calibrate ⇒ stay
  pessimistic). The paced queue term is the **occupancy wait**
  (`queue_eta_occupancy_seconds` — the wait behind OTHER in-flight prefills),
  never the newcomer's own prefill; a per-slot `prefill_eta_seconds` counts
  only for slots that are actually busy (an idle pool has no in-flight slot
  ETA to respect). When the occupancy term (or a busy slot's ETA) exceeds
  `prefill_budget_seconds` → defer, reason `prefill-eta`, header token
  `prefill-eta`. Both values must be present and finite; a missing ETA **or**
  budget never blocks dispatch. Fallbacks (parent AC4): a legacy proxy (no
  calibration signal) keeps today's total-`queue_eta_seconds` behaviour; a
  calibration-aware proxy that did not serve the split uses the total only
  when occupancy evidence exists (`local_prefills_in_flight > 0` or a busy
  slot); any other shape is zero occupancy — an absent occupancy ETA never
  means "unknown ⇒ defer".

**The effective budget paces only the single-pane tiers**
(WL-0MVR8FI4Q0007CGR): `effectiveFreeSlots` is passed alongside the raw
`freeSlots` slot budget, and the two are never conflated again.

- The **audit tier's ≥ 2 slot minimum** is a *slot-count* requirement
  (parent pane + Phase 2 child at `AUDIT_PHASE2_PARALLELISM=1`) and is
  evaluated against `freeSlotBudget` (the raw free-slot count) — **never**
  against `effectiveFreeSlots`. A serialised prefill gate (`cap 1`) reduces
  prefill concurrency, not slot count: two panes can still run, their
  prefills simply queue serially on the proxy's gate. Capping a slot-count
  requirement with a prefill-concurrency number made the audit tier
  permanently unreachable at the documented default (`freeSlots 2`, `cap 1`,
  `inFlight 0` → `effectiveFreeSlots 1 < 2` → audit always skipped).
  **Reversed:** with a prefill headroom of `1` and two genuinely free slots
  the **audit tier dispatches** and the implement tier is not consulted.
- The **single-pane tier minimums** (≥ 1 slot) keep `effectiveFreeSlots` as
  their input, so the reduced headroom still reduces single-pane concurrency
  exactly as before.
- When the audit tier is skipped because its slot minimum is unmet, the tick
  emits a distinct **`audit-tier-budget-skipped`** observation token carrying
  `freeSlots`, `capacityBudget`, `effectiveFreeSlots` and `skippedTier:
  'audit'` — the skip is never collapsed into a bare `no-candidate`
  (WL-0MVR8FI4Q0007CGR AC5). The token is emitted for **both** the direct and
  the coordination dispatch path (the leader evaluates the same raw slot
  budget the tick admitted), see [Empty-offer & skipped-tier
  attribution](#empty-offer--skipped-tier-attribution-wl-0mvr8f-kmu009xted).

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
`queueEtaSeconds`, the occupancy/calibration evidence
`queueEtaOccupancySeconds`, `queueEtaBusySlots` and `prefillEtaCalibrated`
(and the per-slot `slotPrefillEtaSeconds`) alongside the existing
`capacityHint` / `contentionDepth` evidence, and the paced refusal carries
its own `reason` (`prefill-gate` / `prefill-cap` / `prefill-eta`) — so an
operator can tell *waiting behind other prefills* from *waiting on my own
cold prefill* straight from the coordination log.

**Tests.** `downtime-worker.parse.test.ts` pins the parser (gate counters
fail-closed, ETA advisory, absent fields unchanged) and the new
occupancy/calibration advisories (present / absent / malformed →
`undefined`, a malformed advisory never rejects the poll and never masks a
fail-closed gate counter); `downtime-worker.idle.test.ts` pins
`evaluatePrefillPacing` (budget 0 at the cap, headroom recovery, gate
waiters, ETA deferral, missing budget/ETA non-blocking, cap absent/0
unbounded) plus the calibration/occupancy contract (the idle-uncalibrated
and idle-zero-occupancy fixtures never defer, an idle slot's stale per-slot
ETA never defers, gate waiters and a saturated cap still defer while
uncalibrated, and a real occupancy ETA above the budget still defers with
`prefill-eta`); `downtime-worker.test.ts` pins the tick reason/token,
decision-log evidence including the occupancy/calibration record fields,
ETA deferral, the slot-budget audit contract (the audit tier's ≥ 2 minimum
is evaluated against the raw `freeSlots` slot budget, not the prefill-paced
`effectiveFreeSlots` — pinned at cap 1 and at cap 0, with the
`audit-tier-budget-skipped` observation token) and the tick-level dispatch
proof (an idle-uncalibrated poll now selects and dispatches a candidate,
with the busy-occupancy twin still pacing).

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

### Proxy audit availability (provisional wire contract, parent WL-0MW95GBEG005ERHS, child WL-0MWAMS1PW000O3OS)

**Why.** The audit tier used to assert a **per-host** `budget.json` cap
(`maxAudit`, default `1`). The resource an audit actually contends for is the
single local `llama-server` GPU, which every ContextHub host shares — so two
hosts each enforcing "one audit" produced two concurrent audits on one GPU (the
2026-11-03 incident). The fix is to let the **proxy** own the audit budget and
have herdr **query** it (parent AC1), which makes the audit tier
**cross-machine** rather than per-host. This section pins the client-side wire
contract, exactly as the reserve-handshake slice C1 pinned its shape
(`downtime-worker.local-reservation.ts`); the admission mapping built on it is
in *Proxy-derived audit admission* below.

**The proxy side is sibling llm item `LP-0MW95FYMH006XYNK` and has not
shipped.** Probed **2026-11-10** against the live proxy
(`http://192.168.0.199:8000`): `/openapi.json` lists only
`/llama/local/status` and `/llama/local/reserve`, and `/llama/local/audit`,
`/llama/local/budget` and `/llama/local/audit/status` all answer **`404`**.
The contract is therefore **provisional**; the final path is one constant
(`AUDIT_AVAILABILITY_PATH`) and a field rename on either side is a one-line
change because the parser reads documented aliases.

**Provisional wire contract** (`packages/herdr/src/downtime-worker.audit-availability.contract.ts`):

```
GET {proxyUrl}/llama/local/audit/status

200 -> { "cap": <n>, "live": <n>, "available": <bool>,
         "leases": [ { "id": "<id>", "expires_at": <epoch ms> } ],
         "reclaimed": <n>, "reason": "<open vocabulary>" }
```

| Field | Aliases read | Rule |
|---|---|---|
| audit cap | `cap`, `max`, `max_audit` | finite, `>= 0` |
| live leases | `live`, `in_flight`, `live_leases` | finite, `>= 0` |
| availability verdict | `available`, `can_admit` | must be a real boolean — **never derived** from cap/live |
| lease expiry | `expires_at`, `expires_at_ms`, `expiry`, `expiresAt` | positive epoch-ms number or a `Date.parse`-able ISO-8601 string |
| lease identity | `id`, `lease_id`, `ticket_id`, `owner` | optional non-empty string |
| reclaimed leases | `reclaimed` | finite, `>= 0` |
| refusal reason | `reason`, `refusal_reason` | open vocabulary; the canonical saturated token is `AUDIT_BUDGET_SATURATED_REASON` (`audit-budget-saturated`, parent AC2) |

**Fail-closed parse.** `parseAuditAvailabilityResponse(raw, httpStatus)` returns
`null` for **every** unusable payload — a non-2xx status, a non-object body, a
missing/non-finite/negative `cap` or `live`, a missing/non-boolean availability
verdict, a `leases` value that is not an array, a malformed lease entry, or a
malformed `reclaimed` count. A garbage payload can therefore never be read as
"available". `available` is copied from the proxy's own field and never derived
locally: two sides reading the same verdict is what keeps a dispatcher
admission and a proxy refusal from disagreeing (parent AC2). Additive proxy
fields are ignored, so the contract can evolve without breaking this reader.

**Behaviour now consumed.** The contract was pinned before the proxy existed;
the client (`WL-0MWAMSCOP003R837`) was its first consumer and the audit gate
(`WL-0MWAMSDNW000SL0E`) is the client's — see *Proxy-derived audit admission*.
The contract test still pins the allowed reader set, so widening the
dispatch-path consumers is a deliberate, reviewed change.
`AUDIT_AVAILABILITY_PATH` lives in `downtime-worker.constants.ts`; the contract
module, the client and their key symbols are re-exported from the
`downtime-worker.ts` barrel.

**The client** (`packages/herdr/src/downtime-worker.audit-availability.ts`,
child `WL-0MWAMSCOP003R837`) is the counterpart of `createLocalReserver` and
`createDowntimePoller`:

```
createAuditAvailabilityClient(proxyUrl, fetcher = globalThis.fetch, timeoutMs = DEFAULT_DOWNTIME_POLL_TIMEOUT_MS)
  -> () => Promise<AuditAvailabilityOutcome>
```

One call = one `GET {proxyUrl}{AUDIT_AVAILABILITY_PATH}` (URL normalised with
the reserve client's trailing-slash convention, `accept: application/json`),
bounded by the poller's timeout. It **never throws** and resolves exactly one
typed outcome:

| Outcome | Cause |
|---|---|
| `{ status: 'ok', availability }` | 2xx **and** the pinned parser accepts the body |
| `{ status: 'endpoint-absent', reason: 'http-404' }` | the proxy predates the endpoint (the sibling proxy item has not shipped) |
| `{ status: 'unreachable', reason: 'timeout' }` | the timeout expired — the request is **aborted**, not merely ignored |
| `{ status: 'unreachable', reason: 'network' }` | connection refused / DNS failure / the fetcher threw |
| `{ status: 'unreachable', reason: 'http-<status>' }` | any other non-2xx status (a contract-break `400` is distinct from `404`) |
| `{ status: 'unparsable', reason: 'bad-body' }` | 2xx with a non-JSON body or a body the parser rejects (never `ok` with partial data) |

The `404` check precedes the general non-2xx case, so a rollout gap can never
be mistaken for an outage or a contract break. The abort timer is cleared on
every path (no open handle after a call). The audit gate maps `endpoint-absent`,
`unreachable` and `unparsable` to the fail-closed `audit-budget-unknown` reason
(parent AC3).

### Proxy-derived audit admission — gate, vocabulary and the one-release flag
### (WL-0MWAMSDNW000SL0E, WL-0MWAMSK9H005BOHD, parent WL-0MW95GBEG005ERHS)

**The contract.** For the **audit tier only**, the capacity decision is the
**proxy's** audit-availability verdict — not the per-host `budget.json`
`maxAudit` cap. The proxy owns the audit budget and the live audit-lease
registry (sibling llm item `LP-0MW95FYMH006XYNK`), and every ContextHub host
already talks to the proxy for model traffic, so
`GET {proxyUrl}/llama/local/audit/status` is the single **cross-machine**
serialisation of the resource an audit actually contends for (the one local
`llama-server` GPU). Two hosts can no longer independently believe they are
under their own cap while contending for the same GPU — the 2026-11-03
incident. The **implement tier is untouched** and keeps its per-host
`budget.json` cap + local ledger.

**The decision mapping.** Both the dispatcher's pre-check (`getActiveAudit`)
and `admitHostDispatch` map one availability read through the SAME helper
(`decideAuditAvailability`), so a refusal before selection and a refusal at
admission agree and quote the SAME token. The proxy always wins:

| Availability read | Audit decision | Decision-log reason | Header token |
|---|---|---|---|
| proxy `available: true` | admit (reserve locally for observability only) | — | — |
| proxy `available: false` | skip that audit candidate and keep scanning (neutral — no claim, no pane, no `no-candidate` cooldown) | `audit-budget-saturated` (the proxy's own token) | `budget-audit` |
| `endpoint-absent` (`404`, the proxy predates the endpoint) | **fail closed** — skip that audit candidate and keep scanning | `audit-budget-unknown` + `detail: 'http-404'` | `budget-unknown` |
| `unreachable` (`timeout` / `network` / `http-<status>`) | **fail closed** — skip that audit candidate and keep scanning | `audit-budget-unknown` + the failing exchange as `detail` | `budget-unknown` |
| `unparsable` (`bad-body`) | **fail closed** — skip that audit candidate and keep scanning | `audit-budget-unknown` + `detail: 'bad-body'` | `budget-unknown` |
| seam absent (no availability client wired) | **fail closed** — skip that audit candidate and keep scanning | `audit-budget-unknown` + `detail: 'seam-absent'` | `budget-unknown` |

The two fail-closed tokens are the proxy's own vocabulary, so a dispatcher
admission and a proxy refusal cannot disagree about *why* an audit was
refused (AC2). Every non-`ok` outcome stops audit dispatch with a named
reason (AC3) rather than silently reverting to the per-host cap; a missing
seam fails closed too, never open, because the audit tier cannot prove
availability without it.

**Divergence log (AC2).** The local `dispatch-budget.json` ledger keeps
recording the audit entry, but it is **observability only** for admission. When
the proxy and the local ledger disagree about audit capacity (the proxy admits
while the local fresh audit count is at/over `maxAudit`, or the proxy refuses
while the local count is below it) ONE decision entry with reason
`audit-budget-divergence` is written, carrying both sides' evidence
(`{ proxy: { live, cap, available }, local: { live, maxAudit } }`). An agreeing
state emits nothing (no log noise), and the entry never changes the admission
answer — the proxy always wins. The pre-check logs the "proxy refuses / local
not at cap" half (admission never runs, because the tier is skipped before
selection), and admission logs the "proxy admits / local at cap" half.

**Local ledger is observability-only for the audit tier.** Audit entries are
still reserved (and confirmed/released on the existing paths — pane close,
dispatch/spawn failure, claim rollback, the 2 h stale window) so the worklist
header, the interactive over-quota dialog, the dead-pane sweep and every
release path keep working unchanged. But a local entry can never cause an
audit refusal, and a reservation failure never turns a proxy admission into a
refusal. The header/dialog still read the pane-aware display count
(`auditDisplayCount`), which is unaffected.

**One-release legacy flag (AC3).** `HERDR_AUDIT_LOCAL_BUDGET=1` restores the
pre-change **pre-proxy** decision for the audit tier — `budget.json`
`maxAudit` + the local `dispatch-budget.json` ledger, with the legacy tokens
`audit-host-saturated` (cap `1`) / `host-budget-audit` (any other cap) /
`host-budget-unknown` (unreadable ledger) — and never consults the proxy. It is
read per tick, and the legacy path writes an `audit-budget-legacy` decision
entry so a host still running the escape hatch is visible in the log. It is an
environment variable (not a persisted setting) so it can be reverted without
editing a file, matching the `HERDR_HOST_MAX_*` precedent.

> **Removal release.** `HERDR_AUDIT_LOCAL_BUDGET`, the legacy audit branch it
> selects and the `audit-budget-legacy` token are removed in the release
> **after** the proxy side (`LP-0MW95FYMH006XYNK`) is deployed everywhere.
> Until then a host whose proxy predates the endpoint must either run with the
> flag or accept `audit-budget-unknown` (the fail-closed default).

**Tests.** `downtime-worker.audit-tier.test.ts` pins the pre-check mapping;
`host-dispatch-budget.machine.test.ts` and
`host-dispatch-budget.acceptance.test.ts` pin the admission mapping, the
divergence entry, the legacy flag and the observability-only reservation;
`audit-availability.cross-host.test.ts` proves two hosts against one stub
proxy admit exactly one audit.

**Tests.** `downtime-worker.audit-availability.contract.test.ts` is table-driven
and pins grant / saturated / alias spellings / absent and empty lease arrays /
additive extra fields / non-derived `available` / every malformed shape
(non-object, missing or non-finite or negative numbers, non-boolean verdict,
non-array `leases`, malformed lease entries) / non-2xx statuses, plus the
barrel re-export and the allowed-reader-set guard.
`downtime-worker.audit-availability.test.ts` drives the client through an
injected fetcher: the GET URL/method/header, the trailing-slash normalisation,
the typed success (including `leases`/`reclaimed`/`reason`), `404` →
`endpoint-absent`, `400`/`5xx` → `unreachable`/`http-<status>`, a network
rejection and a synchronous throw → `unreachable`/`network`, an expired timeout
→ `unreachable`/`timeout` with the signal **asserted aborted**, non-JSON and
parser-rejected bodies → `unparsable`/`bad-body`, and the abort timer cleared
(`vi.getTimerCount() === 0`) on both the success and failure paths.

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
instead of falling through to the registered-root sweep or the own-backlog
fallback (which would retry other
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
  `select*` helper exclude items with a non-empty assignee **other than the
  dispatcher's own `dispatcher` claim** (see [Dispatcher claim
  identity](#dispatcher-claim-identity-wl-0mw51ob1y0073tlg)), and the parse
  helpers (`parseShowItemOutput`, `parseAuditCandidatesOutput`,
  `parseNextCandidatesOutput`, `parseImplementCandidatesOutput`,
  `parseCriticalCandidatesOutput`) carry the field so the exclusion holds at
  every selection path.

Every OTHER tier keeps the legacy status-flip claim
(`--status in_progress` + the tier's status/stage CAS), and its rollback
keeps the legacy status restore guarded by `--if-status in_progress`.

### Dispatcher claim identity (WL-0MW51OB1Y0073TLG)

The downtime dispatcher claims every item it auto-dispatches — at every tier
(audit, implement, plan, intake, risk-effort) — with its own identity,
**`dispatcher`** (`DISPATCHER_ASSIGNEE`), never with the producer sentinel
`Map` (`AGENT_ASSIGNEE`). Both constants are defined once in
`packages/herdr/src/assignee-identities.ts`; the interactive agent-command
claim (`claimItemForAgentCommand`) keeps claiming `Map`.

Why the two must differ:

- `Map` is the producer's **scheduling hold**: sessions preserve it at exit,
  `wl next` skips it, and the shared Python release predicate
  (`skill/shared/claim_release.py` → `should_release_assignee`) never releases
  it. A dispatcher claim parked on `Map` is therefore indistinguishable from a
  deliberate producer hold, so an auto-dispatched item whose session ends
  without completing it is stranded forever (observed on WL-0MVR8GDJ3008WY3Y).
- `dispatcher` is an **agent claim**: it means "an agent is on it". It is
  released on every terminal outcome, the TTL stale-claim reaper
  (`reap_stale_claims`) reaps it when the session dies, and it is **not** a
  scheduling hold.

Consequences (each covered by a test):

| Surface | Behaviour for a `dispatcher` claim |
|---|---|
| `isAssigneeHeld` (`downtime-worker.selection.ts`) | `false` — the item stays a dispatch candidate |
| `classifyItemForDispatch` (`downtime-worker.gates.ts`) | no `assignee-hold` gate |
| `classifyWindowHold` / `heldAssigneesOf` | never counted, never named |
| all-held banner / coordination `all-window-items-held` | not triggered by a dispatcher claim |
| `[<assignee>]` title prefix | still shown (a fact about the item, not a hold) |

Double dispatch is still impossible: the claim flips the item to
`in_progress` (or, on the audit tier, is CAS-guarded on `--if-assignee ""`) and
the tier's dispatched marker excludes it for the marker lifetime.

### Producer-hold sentinel (WL-0MV85WDOM007BKF8)

The **scheduling-hold convention**: a non-empty `assignee` means the item is
intentionally held from auto-dispatch — `classifyItemForDispatch` and every
tier's `select*` helper exclude it, and the audit claim's `--if-assignee ""`
CAS fails stale on it. Assigning an item therefore *pauses its automatic
scheduling*, with no magic DB flag involved.

The one non-empty assignee that is **not** a hold is the downtime dispatcher's
own claim, `dispatcher` (see below).

The per-item **producer pause switch** is assigning the item to the
producer's wl identity. The reserved sentinel is `AGENT_ASSIGNEE` (`'Map'`,
the producer's wl identity, defined once next to `DISPATCHER_ASSIGNEE` in
`packages/herdr/src/assignee-identities.ts`). Because the value is
self-describing, the ship release gate can key on it: an item assigned to the
producer means "the producer owns it" and is not shippable until it has a
passing audit (epic WL-0MV82CHGQ000HAZZ Q2; re-homed ship gate — SA-tracked).

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
- **Surfaced to the operator (WL-0MVR8FN1D002SCIR).** An all-held dispatch
  window used to be indistinguishable from an empty or broken backlog: the
  refusal is silent by design, so a root whose whole window was parked
  produced a bare `no-candidate` for hours. The Herdr worklist now reports it:
  the header names how many window items are held and by which sentinel(s)
  (`[held: 30 by Map]`), and a banner warns when **zero** items in the window
  are dispatchable *solely* because of assignee holds —
  `Assignee hold — all 30 of 30 dispatch-window item(s) held by Map; no
  downtime dispatch possible`. The surface is **strictly read-only**: it never
  clears, demotes or mutates an `assignee`, and it cannot change a dispatch
  decision (the dispatched-item set is byte-identical with and without it).
  The window classification is the SHARED helper
  (`classifyWindowHold` / `summariseDispatchWindowHold`) that also produces the
  coordination log's `all-window-items-held` token, so the TUI and the log can
  never diverge — see
  [Empty-offer & skipped-tier
  attribution](#empty-offer--skipped-tier-attribution-wl-0mvr8f-kmu009xted).

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

> **Placement runs late in the pipeline (WL-0MW5JE0SZ0057K30).** The order is
> CAS claim → local-capacity reservation gate → host-budget admission →
> **placement resolution / item-ID tab provisioning** → marker write → spawn.
> Provisioning a tab is what creates herdr's empty placeholder root pane, so
> it must happen only once the dispatch is admitted: a refused tick (claim
> lost, reservation refusal, host-budget refusal) must leave **no** pane on
> screen. The F3 contract is unchanged — host-budget admission still happens
> once, after the CAS claim and before the marker/spawn.

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
placement). An empty/unparseable per-prefix likewise fails closed. Because
placement now runs after the CAS claim, an `anchor-unavailable` abort also
**rolls the claim back** and releases the host-budget entry/ticket (see
[no orphaned pane](#no-orphaned-placeholder-pane-wl-0mw5je0sz0057k30)) — the
item is never left stranded `in_progress`. The
resolved anchor is forwarded as `--anchor <rootPaneId>` to `send-to-pi.sh`
(`herdr pane split --pane <anchor>`), `--no-focus` preserved; the new pane's
`workspace_id` is the project workspace (or `Dispatcher` fallback) and its
`tab_id` equals the item-ID (or prefix) tab.

#### Project workspace + item-ID tab (primary path, WL-0MU321YK70035AYT)

Invariant: for a `dispatchClaimedTier` spawn of `<PREFIX>-<hash>` whose
worklog root is `R` (steps 1–2 run after the CAS claim, the reservation gate
and the host-budget admission, immediately before the marker write —
WL-0MW5JE0SZ0057K30):

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

#### No orphaned placeholder pane (WL-0MW5JE0SZ0057K30)

**Guarantee:** a dispatch that never runs a command leaves no pane behind.
The defect this closes: the item-ID tab (and herdr's empty placeholder root
pane) used to be provisioned *before* the host-budget admission, while the
root-pane cleanup only ran *after* a confirmed spawn — so a refused tick left
an empty pane in a fresh item tab (the 2026-11-06 evidence `w3G:p1BK` in tab
`MS-0MW3LTMHT001PRDT` and `w57:pCV` in tab `SA-0MVXUGXS5006M3HF`, both
completed/in_review audit candidates refused by the audit cap).

Two mechanisms, in this order of preference:

1. **Never provision before admission.** `resolveDispatchPlacement` (in
   `downtime-worker.dispatch-placement.ts`) runs after the CAS claim, the
   reservation gate and the host-budget admission, and immediately before the
   marker write. A claim loss, a reservation refusal or a host-budget refusal
   therefore returns **before any tab is created** — there is no pane to leak.
   A TTL-below-bound reservation is the one gate that does *not* abort: it
   fails open (no ticket forwarded, recorded `reservationUnavailable:
   'ttl-below-bound'`) and the pipeline continues to provision, so the tab
   that is created is the one the dispatch pane lands in — never an orphan.
   This covers the automated dispatcher's `implement` and `audit` tiers alike.
2. **Defence in depth on the aborts that DID provision.** Once the item tab
   exists, every remaining pre-spawn abort closes the placeholder root pane via
   `closePlaceholderRootPaneBestEffort`: marker-write failure
   (`marker-write-failed` / `claim-rolled-back`), spawn failure
   (`spawn-failed`), and the `anchor-unavailable` rollback path. The same
   cleanup also runs after a successful spawn (the original
   WL-0MU2EOHK900425VU behaviour).

The cleanup is **fail-safe** and **fail-open**:

- the anchor is closed only when liveness POSITIVELY confirms it is not a live
  **downtime** pane (`paneIds`, or `records` filtered through
  `countRunningDowntimePanes`) — a reused tab's live dispatch pane is never
  closed, and unavailable liveness (query failed/absent) leaves the anchor
  open;
- a failed liveness query or a throwing `closePane` is swallowed: cleanup never
  changes the dispatch outcome, never throws, and never turns a neutral refusal
  into a strike;
- the retained single `Dispatcher` anchor is deliberately exempt (`anchorIsTabRoot
  = false`): closing it would trigger the stale-detection re-provision loop.

Because placement now happens on an already-claimed item, an
`anchor-unavailable` failure rolls the claim back to its pre-claim
status+stage, releases the host-budget entry and records a granted
reservation ticket as released/expired (`abortForAnchorUnavailable`) — the same
invariants as the marker/spawn abort paths.

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

Lifecycle (project workspace and item-ID tab:
`packages/herdr/src/dispatcher-anchor.placement.ts`; per-prefix tab and
fallback anchor: `packages/herdr/src/dispatcher-anchor.tab-anchors.ts`):

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
`packages/herdr/src/dispatcher-anchor.placement.ts`):

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
   **Ordering (WL-0MW5JE0SZ0057K30):** on the **agent** route the anchor is
   resolved only after `prepareInteractiveAgentDispatch` has decided (via
   `resolveInteractiveItemAnchorAfterAdmission`, which is a hard no-op when the
   dispatch was refused/cancelled), so cancelling the host-budget dialog can
   never leave an empty item tab behind; the shell/command-output routes have
   no admission gate and resolve the anchor directly in their branch.
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

**No orphaned pane on a refused dispatch (WL-0MW5JE0SZ0057K30).** Because the
item tab is provisioned only after the host-budget gate admits an agent
dispatch, a dialog **cancel** (or an over-quota refusal) leaves **no** pane:
`resolveInteractiveItemAnchorAfterAdmission(false, …)` returns before touching
`herdr tab list`/`herdr tab create`. The cancel return still calls the
fail-safe root-pane cleanup as defence in depth — a harmless no-op while no
anchor was created. Background (`open_pane: false`) dispatches never provision
a tab either: they carry no pane to place.

**Tab placement — left of the Worklog/extensions tab
(WL-0MVZ88G51004IYHW).** herdr's `tab create` always appends a new tab at the
**right end** of the workspace tab row, so a freshly provisioned interactive
item tab would otherwise appear far from the Worklog/extensions tab it
belongs beside. After a **fresh** interactive tab is created (the
create-vs-reuse `onCreate` signal), the plugin repositions it immediately to
the **left of the extensions/Worklog tab**:

- **Extensions-tab resolution** (`resolveExtensionsTab`) is deterministic and
  fail-open: it first looks for a tab hosting a pane labelled `Work Items`
  (`PLUGIN_PANE_LABEL`, read from the machine-wide `herdr pane list`, which
  is the only output carrying pane labels), then falls back to a tab labelled
  exactly `Worklog`. A single match wins; **none** or **multiple** ambiguous
  matches resolve to `null`.
- **Repositioning** uses the herdr **socket API** `tab.move`
  (`{ tab_id, insert_index }`) — herdr 0.9.5 exposes no `tab move` CLI
  subcommand — with `insert_index` = the extensions tab's index
  (`moveTabInWorkspace` → `sendHerdrSocketRequest`). The newline-delimited
  JSON-RPC Unix socket is `HERDR_SOCKET_PATH` (default
  `~/.config/herdr/herdr.sock`).
- **Fail-open at every boundary** (`applyPlacementMode`): unresolved or
  ambiguous extensions tab, an absent transport, a socket error, a JSON-RPC
  `error` payload or a timeout all leave the tab at its default right-side
  position. The dispatch is never blocked, dropped or placed in a wrong
  workspace.
- **Only fresh tabs move.** Adopted/reused tabs are never repositioned —
  their position is the operator's own arrangement.
- **The automated downtime dispatcher is unchanged** — its tabs (project
  item-ID tabs and the per-prefix `Dispatcher` workspace tabs) keep today's
  right-side placement; the `placement` mode defaults to `right` and only the
  interactive call sites (`index.ts` → `resolveInteractiveItemAnchor*`) pass
  `'left-of-extensions'`.


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
  `high`. Scheduled prompts have no work item, so they carry their own
  per-entry `priority` field instead (WL-0MVIDWJ090090J3Q AC3):
  `dispatchScheduledPrompt` forwards `prompt.priority` (normalized by
  `parseScheduledPrompt`, `resolveScheduledPromptPriority`) through the same
  `spawnAgentPane` → `buildDowntimeSpawnOptions` chain. **An absent
  `priority` defaults to `high` for scheduled prompts** — deliberately
  different from the downtime default (`medium`): the canonical daily
  maintenance routines (`/skill:test` 07:00, `/skill:standup` 08:00,
  `/skill/refactor` 09:00) must be served even during peak periods. An entry
  that should be polite declares `low`/`medium` explicitly; `critical` is
  mapped to `high` by the downtime table. An invalid value skips the whole
  entry (fail-closed, logged warning), like an invalid `time`. The
  `/skill:maintenance-routines` skill
  ([SKILL.md](../../skill/maintenance-routines/SKILL.md)) creates and
  reconciles those three entries (ids, `intervalDays`, `time` and `priority`)
  in each project's `.worklog/scheduled-prompts.json`.
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
| request | `X-Local-Preference: local-preferred` | Work the operator marks local-first: the prompt stays local while it fits and is deferred with a retryable 429 (`Retry-After`) when the local slot is contended, instead of being silently sent remote |
| request | `X-Local-Preference: remote-ok` | Background work: may go remote without queuing local capacity |
| response | `X-Local-Route` | Route the proxy took (e.g. `local`, `remote:<provider>`) |
| response | `X-Local-Fallback-Reason` | Why the request left the local route |

**Policy knob.** `downtimeLocalPreference` (herdr setting, clamped to the two
values, default `remote-ok` since WL-0MVNUHWH500196K1; `local-preferred` is the
explicit per-deployment opt-in) is read live on every tick and threaded
through `DowntimeWorkerConfig.config()` → both dispatch paths →
`dispatchClaimedTier` → `spawnAgentPane` → `buildDowntimePaneArgs` /
`buildDowntimeSpawnOptions`:

- **Downtime backlog panes** carry the resolved value (see the priority rule
  below); with no persisted key a `medium`/`high`/`critical` item still
  forwards `remote-ok` — unattended work goes remote rather than stall on a
  contended local slot — while a `low`-priority item becomes `local-preferred`.
- **Scheduled-prompt panes** and **headless background dispatches**
  (`spawnBackgroundPi`) default to `remote-ok`: unattended work never queues
  local capacity the operator may need. They also *inherit the knob when it
  is present* — so an explicit `local-preferred` deployment also makes scheduled
  work local-preferred. For an unconfigured deployment the knob and the
  background fallback agree on `remote-ok`.
- **Interactive panes** carry no preference unless the operator exports
  `HERDR_LOCAL_PREFERENCE` — requests stay byte-identical to today.

Downtime-spawned panes take both pane-launch knobs (`HERDR_LOCAL_PREFERENCE`,
`PI_LOCAL_RESERVATION_TICKET`) from the **resolved dispatch decision only**:
`buildDowntimeSpawnOptions` strips them from the inherited environment before
re-adding an explicit value (WL-0MVP643Q4007BZJ8). A worker that itself runs
inside a `local-preferred` pane therefore cannot leak its own preference into
every child — that would bypass the priority rule and violate the fail-open
contract that an absent value omits the env var.

**Priority rule and precedence (WL-0MVNUIW77000VYAX).** The preference is
resolved **once** at the dispatch boundary (`dispatchClaimedTier`, from the
already-resolved candidate priority), so every dispatch path — coordination
offer, registered-root sweep, own-backlog fallback, audit-batch continuation,
critical-first/normal scan and the legacy tier chain — inherits the same
decision. Precedence,
highest first:

1. **Explicit operator setting wins.** When `downtimeLocalPreference` is
   *persisted* with a valid value (`local-preferred` or `remote-ok`), that value
   is forwarded for every pane regardless of priority. Remove the key to opt
   into the priority rule.
2. **Priority rule.** With no persisted key, a `low`-priority candidate is
   dispatched `local-preferred` (cheap work absorbs contention on the local slot
   instead of consuming remote capacity); `medium`, `high`, `critical` and an
   absent/unknown priority resolve to the deployment default
   `DOWNTIME_LOCAL_PREFERENCE` (`remote-ok`).
3. **Deployment default.** `remote-ok`, also used when no priority exists (a
   scheduled prompt has no work item).

Explicitness is a **derived, never-persisted** signal: `loadSettings` reports
`downtimeLocalPreferenceExplicit` `true` only when the settings file holds a
valid two-value preference (an absent key, a missing file and out-of-alphabet
values are not explicit). The persisted alphabet is
`local-preferred | remote-ok`, the setting's `remote-ok` default is unchanged,
and the `X-Local-Preference` wire contract emits the same two values — the
rule only chooses between them.

> **`local-only` removed (WL-0MVSI1RX2005O9NE).** The retired value is not a
> deprecated alias: it is rejected on every input surface. A settings file
> still holding `local-only` loads as `downtimeLocalPreference: 'remote-ok'`
> with `downtimeLocalPreferenceExplicit: false` (the low-priority rule applies
> again) and a save round-trip drops the key; `send-to-pi.sh` warns and drops
> `--local-preference local-only` while still exiting successfully (fail-open).
> Migration: rewrite the setting to `local-preferred`.

**Marker evidence.** The success marker in
`.worklog/downtime-dispatches.log` records the resolved `localPreference` and a
machine-readable `localPreferenceReason`:

| reason | meaning |
|---|---|
| `operator-setting` | a persisted `downtimeLocalPreference` decided the value |
| `priority-low` | the low-priority rule chose `local-preferred` |
| `default` | the deployment default was kept (non-low or absent priority) |

Scheduled-prompt markers record the same two fields (`default`, or
`operator-setting` when the operator persisted the knob). Legacy callers that
pass a preference without the new dispatch mode add no marker fields, and
marker readers ignore unknown/absent fields, so existing logs stay valid. The
route log's `preference` field therefore shows `local-preferred` for a low-priority
dispatch and the deployment default for a high-priority one.

> **Default flip (WL-0MVNUHWH500196K1).** The C4-AC1 downtime default of
> `local-only` (WL-0MVLJTV03000KIQZ) is superseded by `remote-ok`. The
> trade is deliberate: contended downtime work may now leave the box for a
> remote (possibly metered) provider rather than silently not run. Persist
> `local-preferred` where that spend/reach profile is unwanted; the route log
> makes the actual route visible either way.

**Transport.** `send-to-pi.sh --local-preference <local-preferred|remote-ok>`
injects the value into the pane process (`exec env
HERDR_LOCAL_PREFERENCE=<value> bash run-pi-agent.sh …`); anything else —
including the removed `local-only` — is ignored with a warning and the launch
proceeds unchanged (fail-open). An absent flag omits the env var entirely.

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

**Observing a deferral (operator reproduction, WL-0MVSNHCSM004JYEY).** A
*deferred* pane and a *stalled* pane both look idle, so confirm the former from
the proxy's deferral records rather than the pane's appearance. Two proxy gates
produce the same client-visible refusal class, `429 "Local admission refused"`:

- the **dispatch/lease gate** — `local_dispatch_denied … owner=<session>` while
  another session holds the slot. The request queues for up to 60 s and then
  `contention_queue_fallback_after_queue … queued_duration=… preference=…
  reason=local_lease_active` plus
  `local_preference_resolved … outcome=deferred reason=local_lease_active`;
- the **prefill-ETA admission guard** —
  `local_admission_guard decision=reject … projected_wait_s=… budget_s=…`
  (`eta_prefill_s` / `eta_occupancy_s` are its inputs), or the pre-coalesced
  `local_only_refused … verdict=deferrable`. This one is calibration-gated:
  while `prefill_eta_calibrated: false` (`insufficient_samples`, below the
  proxy's `MIN_CALIBRATION_SAMPLES: 5`) the guard admits rather than defers, so
  a young proxy shows no ETA deferrals.

A direct request that meets the lease gate **without** queueing gets
`503 no_slots_available` (`local_lease_active`) instead; the queued path is
what surfaces the `429` class to the pane. To reproduce a deferral:

1. **Send a prompt that only the local route can serve**, sized to fit the
   local token budget but large enough to be a real prefill (≈ 18 k tokens on
   the reference pool), and keep other local traffic running so the slot is
   contended — a dispatched audit pane or a concurrent local generation is
   enough. Prefills are serialised by default
   (`local_max_concurrent_prefills: 1`).
2. **Read the proxy.** `GET /llama/local/status` carries the inputs
   (`prefill_eta_seconds`, `queue_eta_seconds`, `prefill_budget_seconds`,
   `prefill_gate_waiters`, `prefill_eta_calibrated`, `slots[].owner_session_id`).
   The proxy log path is deployment-specific — do not assume
   `/var/log/llama-proxy/proxy.log`; the `llama-proxy` exposes
   `GET /logs/tail?lines=N` (SSE, `data: {"initial": …}`, optionally
   `&session=<pi-session-id>`).
3. **Read the pane.** Every refused attempt prints
   `Error: 429 "Local admission refused"` followed by
   `Retry attempt N (backoff <d>s — server-requested)`; it must **never** print
   `Non-retryable error: 429 "Local admission refused"`. The hinted delay is
   honoured (upward jitter ≤ 25 %, ceiling 6 h), so consecutive attempts are
   spaced by the advertised wait. The admitted turn then logs
   `local_preference_resolved … outcome=local` and
   `Stream finished: … provider=local model=<local model>`, and writes a
   `<cwd>/.worklog/local-route.log` line carrying
   `"preference":"local-preferred"` and `"route":"local"` with no
   `fallbackReason`.

The refused attempts have **no** route-log line — `after_provider_response`
does not fire when the provider throws on a non-2xx — so the proxy log is the
only record of the deferral itself; the route log records the admitted turn.

> **Headless is not exempt.** The route log is written from the extension's
> `after_provider_response` hook in whichever pi mode is running: a headless
> `pi -p` turn whose provider response is admitted writes exactly the same line
> as an interactive pane (verified 2026-10-31 with a mock provider in text
> mode, in `--mode json` — the `spawnBackgroundPi` shape — and with a
> `.worklog/worktrees/…` session cwd; WL-0MVTN5M3E007DU9Z). Two absences are
> expected and must **not** be read as a headless limitation: a run whose
> attempts were all refused writes no line (no admitted response, so the hook
> never fires — see the paragraph above), and a run terminated during its
> deferral wait writes none for the abandoned turn. When a dispatched
> (headless) turn shows no line, check its session JSONL: a last message with
> `stopReason: "error"` / `429` means the turn never completed, rather than
> the route log having failed to record an admitted turn.

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
`no-candidate` outcome means the **whole ranked backlog** held nothing
dispatchable: the dispatcher walks every ranked work item beyond the initial
`browseItemCount` window (see *Whole-backlog dispatch window* above), so this
reason now implies a genuinely empty-or-fully-gated backlog rather than a
narrow view (WL-0MW9XS0XR007K1TH supersedes WL-0MUNS8X97007C9H9's
sprint-view-only reading). In
coordination mode (WL-0MTEZ4XZJ006Y9U7) the shared runtime file
(`.worklog/downtime-coordination.json`) is an **offer list, not the
backlog**: the leader removes each entry after dispatching (see step 4
above), so an empty file right after a dispatch is a *transient gap* while
the worklog still holds dispatchable work. Its top-level `leader` block
(WL-0MW1VINII003IL7R) is a separate, non-offer record — "no peer offer" and
"the leader block names a leader" are independent facts, and nothing here
reads the block as work. Therefore:

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
  counts, and neither does an entry with an empty `workItemId`.
- **Liveness-aware peer predicate (WL-0MVR8GDJ3008WY3Y AC7).** `hasPeerOffer`
  rejects entries whose `lastUpdated` is older than
  `DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS` (24 h) — a crashed instance whose
  entry lingers can no longer masquerade as a live peer. The rationale is
  deliberately conservative: treating a stale entry as an **absent** peer
  makes the leader *more* willing to sweep/arm the cooldown probe, never less,
  so the worst case is one extra idle tick polling the offer list — never a
  starved offer. Both orchestrator call sites (the tick-time pause-cancel and
  the dispatch-time pause-arm) pass an explicit `nowMs`, and the default
  window applies to callers that omit the options object. Entry expiry remains
  a deliberate no-op (`pruneStaleEntries` still returns 0 and never mutates
  the file, WL-0MTMPIQBE001J41P); liveness lives only in the read predicate.
  The cooldown
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

### Host-wide dispatch budget — gate table, defaults and scope
### (F6 WL-0MVXY10QH0020V7S, parent WL-0MVXWQFGV000D2AB)

This section is the consolidated reference for the machine-scoped dispatch
budget that F1–F5 built. The per-feature contracts stay with their feature
sections below (*Host-wide audit admission*, *Interactive over-quota
confirmation*, *Unified budget observability*); this one records the gate
table, the fail-direction rationale, the default figures and what v1
deliberately does not cover.

**Why machine-scoped.** The budget is one record per **host**, not per herdr
instance and not per project: `~/.herdr/downtime/dispatch-budget.json` (or
`HERDR_COORDINATION_DIR`). One elected leader already dispatches for every
root, so a machine file is both cheap and authoritative — and adding
instances or projects can never multiply the recorded in-flight work. A
per-instance `settings.json` key (the shape `downtimeRequiredFreeSlots` has)
was rejected deliberately: a "host" cap that each instance stores itself
drifts by construction, which is exactly why the existing free-slot setting
cannot express this ask. See *Configuration* in F1's module contract
(`host-dispatch-budget.ts`) and the machine-dir file table under *Files &
runtime artifacts*.

**Gate table (both tiers, one reader).** Admission is consulted exactly once
per dispatch, in the claim→marker→spawn choke point, so both dispatcher paths
(`dispatchDowntimeWork` and `dispatchFromCoordination`) and every tier share
the same decision. All budget refusals are **neutral skips** — never a CLI
error strike, never `no-candidate`, so the no-candidate cooldown is not
entered and the next idle tick re-checks (as with `audit-budget-saturated`).

| Tier | Condition (evaluated at admission) | Decision | Decision-log reason | Header token |
|---|---|---|---|---|
| implement | entries whose pane is in the live pane list **<** `maxImplement` (a confirmed implement with a live pane counts regardless of heartbeat age — pane-derived freshness, WL-0MW9VQ08W000SN63) | admit + reserve | — | — |
| implement | pane list UNKNOWN (failed/unparseable `hostBudgetLivePanes` read, WL-0MW9VQX5T001GCUP) | count fresh entries by the **freshness rule** (no pane requirement) — never reaps, never deletes, still decides (fail-open: a broken herdr read does not refuse a tick on its own) | — | — |
| implement | at/over `maxImplement` (including `maxImplement: 0`) | skip that candidate and keep scanning — no claim, no pane | `host-budget-implement` | `budget-implement` |
| audit | proxy availability read `available: true` | admit + reserve (the local entry is observability only) | — | — |
| audit | proxy availability read `available: false` | skip that audit candidate and keep scanning (neutral) | `audit-budget-saturated` | `budget-audit` |
| audit | proxy read not `ok` — `endpoint-absent` / `unreachable` / `unparsable`, or the seam is absent | **fail closed** — skip that audit candidate and keep scanning, recording the failing exchange as `detail` | `audit-budget-unknown` | `budget-unknown` |
| audit (one-release legacy path, `HERDR_AUDIT_LOCAL_BUDGET=1`) | fresh entries (no live-pane requirement) **<** `maxAudit` | admit + reserve (pre-proxy behaviour) | `audit-budget-legacy` (warning entry, once per tick) | — |
| audit (legacy path) | at cap with `maxAudit: 1` (default) | skip that candidate and keep scanning | `audit-host-saturated` (byte-identical to the retired marker) | `budget-audit` |
| audit (legacy path) | at cap with any other `maxAudit` (including `0`) | skip that candidate and keep scanning | `host-budget-audit` | `budget-audit` |
| audit (either path) | the proxy verdict and the local (observability-only) ledger disagree about capacity | decision unchanged — the proxy wins; ONE evidence entry with both sides' figures | `audit-budget-divergence` | — |
| implement | ledger exists but cannot be trusted (corrupt/unreadable bytes, or the reservation lock/I/O failed) | **fail closed** — skip that candidate and keep scanning, then rewrite the ledger from the live pane list **when the pane read succeeded**; an unknown pane read (failed `hostBudgetLivePanes`) skips the rewrite so the corrupt ledger is never replaced by an empty one (WL-0MW9VQX5T001GCUP) | `host-budget-unknown` | `budget-unknown` |
| audit (legacy path) | ledger exists but cannot be trusted | **fail closed** — skip that candidate and keep scanning (pre-proxy semantics) | `host-budget-unknown` | `budget-unknown` |
| audit (proxy path) | local ledger unreadable | **no effect on admission** — the proxy is authoritative, the local entry is observability only; the local ledger is never read to refuse an audit | — | — |
| either | coordination dir unresolvable | admit — no ledger, no new failure mode; the audit tier still consults the proxy (degrades exactly as before the budget existed) | — | — |

Beneath the table, existing capacity gates remain the inner limiter: free-slot
minimums, the local reservation/prefill pacing, contention and the host-CPU
gate all still apply, in their existing order.

#### Continuable vs terminal outcomes (WL-0MWBT76WY00298AY)

A head scan (`dispatchFromOwnHead`, and both loops of `dispatchFromHerdrList`)
never treats "not dispatched" as sufficient reason to keep scanning. It steps
to the next candidate ONLY for an allow-listed **continuable hold**:

- **lost claim** — `claim-failed`, `claim-rolled-back`: the CAS race was lost
  or a marker write was rolled back; the candidate is neutral, so the scan
  steps on (the audit-batch continuation ends instead — see below).
- **neutral budget refusal** — `host-budget-implement`, `host-budget-audit`,
  `host-budget-unknown`, `audit-budget-saturated`, `audit-budget-unknown`,
  `audit-host-saturated`: the candidate is budgeted, but a prep candidate
  ranked behind it (`plan` / `intake` / `risk-effort`) is not, so the scan
  records the hold (reason + `{live, max}`) and keeps scanning. The hold is
  recorded on TWO rungs (WL-0MWDDHVF2004PTYX): an **audit** refusal
  (`audit-budget-*`, or the legacy `host-budget-audit` /
  `audit-host-saturated`) lands on `HeadScanHolds.auditBudget` (carrying the
  failing exchange as `detail` when the proxy read failed closed), an
  **implement/host** refusal on `HeadScanHolds.hostBudget` — so the leader's
  terminal chain can rank an audit refusal ABOVE an implement one: a tick
  whose audit budget refused (`audit-budget-unknown` + `detail: 'http-404'`)
  must say so, never `host-budget-implement` (a broken proxy contract is not
  an ambient implement-cap statement).

Everything else is **terminal/strike-worthy** and returns immediately, ending
the tick exactly as before: `wl-error`, `spawn-failed`, `marker-write-failed`,
`anchor-unavailable`, … The rule lives in ONE allow-list predicate
(`isContinuableHoldOutcome`, `downtime-worker.dispatch-contract.ts`) used
identically by `dispatchFromOwnHead` and both `dispatchFromHerdrList` loops. It
is deliberately an allow-list, not a deny-list, so a new refusal class must be
added explicitly and can never be swallowed into a silent retry loop.

The audit-batch continuation is the one exception to "keep scanning": while a
batch is armed, a budget refusal records the hold and **ends the batch** — it
does not hop to another audit target — so the "a batch never hops to another
target" contract holds while the batch's terminal reason stays the neutral
refusal.

**Fail directions are deliberately different per path.** This is a design
decision, not an inconsistency:

| Path | Unreadable/corrupt ledger | Rationale |
|---|---|---|
| Dispatcher (admission) | **fail closed** — reason `host-budget-unknown`, plus a self-healing rewrite from the live pane list | nobody is watching an automated tick; a dropped/ignored unknown read would under-count and admit work the operator capped, and over-admitting is unbounded |
| Interactive (`/skill:implement` / `/skill:audit` fired by a human) | **fail open with a visible notice** — `Host dispatch budget ledger unreadable — proceeding without the quota check.` (the corrupt bytes are never rewritten here) | a human is present and owns the decision; a corrupt ledger must not block their shortcut |

The fail-closed arm is deliberately self-healing rather than sticky: the
rewrite rebuilds the ledger from the leader's live pane list, so one corrupt
read costs at most one tick — a crashed leader cannot wedge the host. The
rewrite is gated on a **known** pane list: a failed/unparseable pane read is
UNKNOWN and must never rewrite a corrupt ledger as empty (WL-0MW9VQX5T001GCUP),
so the next pane-carrying tick self-heals instead.

**Empty vs unknown pane list (WL-0MW9VQX5T001GCUP).** The machine-wide pane
read (`hostBudgetLivePanes`) is **tri-state**, mirroring the `InFlightPanes`
precedent: `{ok:true, panes}` carries an **authoritative** list (an empty
list genuinely means "no downtime panes"), while `{ok:false}` means pane
liveness is **UNKNOWN** (a failed, unparseable or unwired read). The two must
never be conflated — they fail in opposite directions:

| State | Counting rule | Reap | Repair |
|---|---|---|---|
| pane list **known** (successful read) | fresh AND pane in list (implement) / pane-aware display (audit) | stale, pane-less entries reaped | unreadable ledger repaired from the list |
| pane list **empty but known** (successful read, no panes) | zero in-flight | stale entries reaped (existing behaviour, pinned by AC2) | — |
| pane list **UNKNOWN** (failed read) | fresh entries, no pane requirement (the freshness rule) | **never** — reaping on unknown would delete live entries (heartbeats are only written at reserve/confirm, so a reaped live entry never comes back) | skipped — a corrupt ledger stays corrupt until a pane-carrying tick |

This is why the same value cannot serve both directions: admission is
**fail-open** on unknown (a herdr hiccup never silently wedges dispatch — the
existing rationale is preserved), while reap is **fail-safe** (never delete
on unknown). When unknown, the implement tier's admission read is a **pure
read** — no write at all — and the count is deliberately conservative
(fresh entries count without the pane requirement, so a broken herdr
over-counts rather than under-counts and cannot over-admit).

**Audit tier fail direction (proxy-derived).** For the audit tier the
fail-closed decision is the **proxy read**, not the ledger: any non-`ok`
availability outcome (`endpoint-absent` / `unreachable` / `unparsable`, or a
missing seam) stops audit dispatch as `audit-budget-unknown`. An unreadable
local ledger has **no effect** on audit admission — it is observability only.
The one-release `HERDR_AUDIT_LOCAL_BUDGET=1` flag restores the ledger
fail-direction table above for the audit tier.

**Why `maxImplement` defaults to 2.** The default is **conservative** and it
bounds **host work-in-flight**, not LLM capacity: it is a statement of
operator intent ("at most this much agent work on this box at once"), which
is a different question from "how many proxy slots are free". Two concurrent
implements leave a slot for the operator's own interactive session and for
one audit. `maxAudit: 1` is retained as the **one-release legacy default** and
as the local observability figure; the authoritative audit cap is the
**proxy's** (see *Proxy-derived audit admission* above).

**Boundary statement (WL-0MU2EP6JL006A1U3).** That item removed the
client-side *running-pane* cap in favour of LLM-idle gating, and this budget
deliberately reintroduces a host-scoped, **operator-owned** limit — a
different thing. It must never resurrect the "7 panes queued on 1 slot"
behaviour: the free-slot/reservation and prefill gates remain the inner
limiter, and the budget can only ever *reduce* concurrency below what those
gates would admit. A budget refusal is also not capacity starvation
(`capacity-starvation.ts` stays untouched), because an operator-imposed stop
is not a saturated model.

**Release points and the dead-pane sweep (WL-0MW5KC8J300942EA).** A
ledger entry is released (removed) at every point the dispatch it represents
ends:

- **dispatch abort paths** — claim rollback, local-capacity reservation
  refusal, host-budget refusal itself, marker-write failure and spawn failure
  all release the entry immediately (`releaseHostDispatch` in
  `downtime-worker.dispatch-claims.ts`);
- **pane close** — the reaper releases the item's entry right after it closes
  that pane (`ReaperDeps.releasePaneBudget`), for both `implement` and
  `audit`;
- **staleness** — the ledger's own 2 h heartbeat-staleness reap remains the
  final backstop. Since WL-0MW9VQ08W000SN63 this reap is **pane-derived** for
  the implement tier: a stale heartbeat alone never releases a confirmed
  implement entry whose pane is still in the trusted live list (the pane is
  conclusive evidence of in-flight work, and `heartbeatAt` is only written at
  reserve/confirm — there is no refresh path). The entry is released by
  staleness only once its pane is also gone.

A pane can still be closed *outside* those paths (the operator closes it in
herdr, a session crashes, the window is torn down). Because the audit tier
counts fresh entries **without** a live-pane requirement, such a dead entry
would otherwise hold `maxAudit` until the 2 h window expired — the 2026-11-06
incident. The reaper therefore runs one **dead-pane sweep** per pass
(`sweepClosedPanes`) with the pane list it already read: any **confirmed**
entry (non-empty `paneId`) whose pane is absent from that trusted list is
reaped regardless of heartbeat freshness (and, since WL-0MW9VQ08W000SN63, an
IMPLEMENT entry whose pane IS in the trusted list is never swept by staleness
alone — the sweep applies the same pane-derived freshness as the count).
Entries with no `paneId` (the reserve→spawn window) are retained, and a
failed/unparseable pane read never sweeps (a synthetic empty list would
over-reap and over-admit).

**The header's audit count is pane-aware (WL-0MW8D4UQH002TWJV).** Admission
keeps the marker's liveness-free rule on purpose (a slot is held from dispatch
until a release point or staleness). The **display** does not: the worklist
header's `audit n/max` uses `reduceAuditDisplayCounts` (through the single
read-only `readHostBudgetStatus` reader), which excludes a fresh **confirmed**
entry whose `paneId` is absent from the trusted live pane list. A pane closed
outside the release paths therefore stops being reported immediately — the
header shows `audit 0/1` as soon as the audit pane is gone, instead of a
phantom slot for the remainder of the 2 h window.

- Unconfirmed entries (no `paneId`, the reserve→spawn window) still count while
  fresh, so a just-reserved audit is not hidden.
- An absent live-pane list falls back to the marker-compatible freshness rule
  (the display cannot distinguish "gone" from "unknown", and it never invents
  a zero). Since WL-0MW9VQX5T001GCUP **both** figures — the implement count
  and the audit count — fall back to the freshness rule on an unknown pane
  read, so a broken herdr read no longer reports zero implements either.
  An **authoritative empty** list still reads as zero in-flight for both
  tiers (empty ≠ unknown).
- The display path remains strictly read-only: it never reaps or rewrites the
  ledger (the sweep/staleness release owns cleanup).
- This deliberately diverges from **admission**, which continues to count a
  dead entry until it is released or reaped; the divergence is display-only and
  cannot admit work.

**The interactive over-quota dialog follows the same display rule
(WL-0MW8IQNY7003JIOL).** When an operator fires `/skill:audit` by hand and the
audit tier is at its cap, the confirmation dialog quotes the **pane-aware
display count** the header shows — not the admission count — so the two
operator-facing surfaces never disagree. Both go through the same shared
helper (`auditDisplayCount`, used by `readHostBudgetStatus` and
`prepareInteractiveAgentDispatch`):

- A dead (confirmed, pane-gone) audit entry neither triggers the dialog nor
  appears in its `live` figure.
- An unconfirmed audit entry (no `paneId`) and a confirmed entry whose pane is
  live still count, and stale entries stay excluded.
- With no trusted live-pane list the dialog falls back to the freshness rule —
  the same fallback the header uses — rather than inventing a zero.
- Admission is untouched: the dispatcher still counts marker-compatibly
  (`freshCount` / `readAuditBudgetState`, fail-closed). The consequence is
  deliberate and documented: after the fix the dialog may not prompt when only
  dead-pane entries exist, so the operator can hand-fire an audit that
  admission would refuse — they are choosing from the count they just saw in
  the header.
- The dialog read stays read-only: it never reaps or rewrites the ledger.

**Audit-cap unification (the choice, recorded).** The hard-coded host-wide
audit cap of 1 — the `active-audit` marker in `machine-coordination.ts` — is
**retired in favour of the ledger** with `maxAudit` as its cap. The marker was
single-flight by construction; the ledger is count-aware, so one mechanism now
serves `maxAudit: 1` (identical behaviour) and `maxAudit: 2…N`.

- **One release of read-compatibility.** A non-stale `active-audit` file
  written by an OLDER herdr instance is read as **one synthetic audit entry**
  by `freshCount('audit')`. This version **never creates and never removes**
  the file — its writers were deleted with the change, so no code path can
  resurrect the marker or mask a ledger bug.
- **Mixed-version safety argument.** During a rolling upgrade some instances
  on the host still run the marker-based version. Without the legacy read, an
  old instance's live audit would be invisible to a new instance's ledger
  count, and the host could run two audits against a `maxAudit: 1`
  configuration — the duplicate-dispatch failure the original marker existed
  to prevent. Counting the marker as one entry keeps the union of both
  mechanisms conservative (at most `maxAudit`), at the cost of an old-instance
  audit being counted but never ledger-released (bounded by the 2 h staleness
  window, the same lease the marker always had).
- **Removal schedule.** The legacy readers (`readActiveAuditMarker`,
  `isHostAuditActive`) and the synthetic-entry count are removed in the
  release **after** the host-wide budget generalisation ships — once every
  instance on the host is expected to run a budget-aware version. The
  authoritative wording lives in the `machine-coordination.ts` module comment;
  this schedule is the operator-facing record.

**Superseded for the audit tier: the proxy owns the audit budget
(WL-0MW95GBEG005ERHS).** The ledger unification above superseded the marker,
but the ledger's `maxAudit` is **not** the current audit-admission authority
either. Once admission became proxy-derived, the per-host `budget.json`
`maxAudit` cap and the local ledger's audit entries were demoted to
**observability only** for admission (the header, dialog and dead-pane sweep
still read them), and the proxy's verdict decides. `maxAudit` is now the
one-release legacy cap (`HERDR_AUDIT_LOCAL_BUDGET=1`) and the local evidence
the divergence log compares against. `budget.json` `maxAudit` must therefore
never be documented — or defaulted — as the audit-admission authority; see
*Proxy-derived audit admission — gate, vocabulary and the one-release flag*.

**Out of scope for v1 — the future `window` field.** A total cap over a
rolling window ("≤ 20 dispatches per 24 h") is explicitly **not** implemented.
The ledger shape was chosen to make it additive: every entry already carries
`startedAt`/`heartbeatAt`, so a future `window` field would slot into the same
`{ version: 1, entries: [...] }` document (a config-side `window` alongside
`maxImplement`/`maxAudit`, plus a time-filtered reduction beside
`reduceLedgerCounts`) without a new file, a new lock or a second counting
path. Capping the `plan` / `intake` / `risk-effort` tiers is likewise out of
scope (`kind` is recorded, so extending is trivial). **Multi-machine
coordination is no longer out of scope for the audit budget:** the local
ledger remains single-machine, and the **proxy-owned audit budget queried over
HTTP** (`GET {proxyUrl}/llama/local/audit/status`) is the cross-machine
serialisation that supersedes the old `machine-coordination.ts` note. See
*Proxy-derived audit admission* above.

**Release window interaction — code-freeze, not a budget slot
(WL-0MW7YIBG70021YI3).** The budget ledger counts **dispatched agent panes**;
neither the release process's subprocesses (`audit_runner.py`, `run_tests.py`,
`git`/`gh`) nor the `/skill:ship` command itself pass through
`admitHostDispatch`, so a release **bypasses the ledger entirely** — it neither
consumes nor is limited by `maxImplement`/`maxAudit`. While a release runs, the
**per-root code-freeze gate** (evaluated *before* budget admission) skips all
new implement and audit dispatch for the releasing root, still allows
plan/intake prep (including critical prep), and lets in-progress panes finish.
A dedicated "release budget" slot is **not recommended**: it would reserve
ledger capacity as a declaration rather than measure the release's actual
subprocess load. The real residual gap is scope — the freeze is per root while
the ledger is host-wide, so a release in one project does not pause another
project's implement/audit dispatch; that is tracked separately
(WL-0MWAM5N75004ROSW). Full rationale, the tier table and the subprocess
inventory: [release-dispatch-budget-evaluation.md](release-dispatch-budget-evaluation.md).

### Unified budget observability (F5 WL-0MVXY0ZYW009NEJD)

The budget's numbers are surfaced through the existing observability tools —
no new log sink, no poller, and **one reader** so the surfaces cannot
disagree:

| Surface | What it shows | Source |
|---|---|---|
| Decision log (`.worklog/downtime-coordination.log`) | the refusal token (`host-budget-implement` for implement; `audit-budget-saturated` / `audit-budget-unknown` for the proxy-derived audit tier; the legacy `host-budget-audit` / `host-budget-unknown` / `audit-host-saturated` under `HERDR_AUDIT_LOCAL_BUDGET=1`) plus a `budget` evidence figure (`live`/`max` for the tier) and, on a fail-closed audit read, the failing exchange as `detail` (`http-404` / `timeout` / `network` / `bad-body` / `seam-absent`) — the decision entry names the broken proxy contract without reading code (WL-0MWDDHVF2004PTYX AC3); plus the `audit-budget-divergence` / `audit-budget-legacy` evidence entries | `downtime-log.ts` + `downtime-log-budget.ts` vocabulary, written by the tick |
| Herdr header token | `budget-implement` / `budget-audit` / `budget-unknown`, from the shared `decisionHeaderToken` mapping, so the header says *why* the tick stopped — consistent with `contention` / `slot-owner` / `saturated` | `downtime-worker.constants.ts` |
| stderr skip line | `[worklog-plugin] Downtime <tier> tier skipped: <reason> (live=n, max=m)` (`tier` is `budget` for `audit-budget-unknown` / `host-budget-unknown`) | `hostBudgetSkipLine` (`host-budget-status.ts`) |
| Worklist header counter | read-only `[budget: implement n/max · audit n/max]`, rendered from already-available state; it never spawns `wl`, never mutates and never changes a dispatch decision, and renders nothing when the budget is unavailable (no chrome in the common case) | `readHostBudgetStatus` (`host-budget-status.ts`) |

`readHostBudgetStatus` counts with the **same pure reductions admission
uses** (`reduceLedgerCounts` for the implement pane-derived live-pane rule,
`reduceMarkerCounts` + `legacyActiveAuditCount` for the audit rule), so the
counter, the header token, the stderr line and the decision entry quote the
same ledger and the same caps. The display read is deliberately non-mutating
(it excludes stale entries without reaping them — a TUI render must never
write machine state). A budget refusal is an **operator-imposed** stop, so it
never starts or extends a capacity-starvation episode
(`capacity-starvation.ts` is untouched).

A refusal token is a **hold on one candidate**, not a whole-tick stop: the
tick records it (with `{live, max}` evidence) and keeps scanning, so prep work
ranked behind the refused candidate still dispatches. The neutral reason is
reported only when nothing else dispatches, and no cooldown/strike is
recorded.

### Host-wide audit admission — budget ledger, `active-audit` marker retired
### (WL-0MUIVE0YG000UVIA → WL-0MVXY0XPF006YUHA F2)

> **Current state (WL-0MW95GBEG005ERHS).** The per-host ledger cap described
> below is **no longer the audit-admission authority**. Audit admission is
> proxy-derived: `getActiveAudit` and `admitHostDispatch` read the proxy's
> `GET {proxyUrl}/llama/local/audit/status` verdict and fail closed as
> `audit-budget-unknown` when it cannot answer. The ledger's audit entries and
> `budget.json` `maxAudit` are **observability only** for admission
> (header/dialog/sweep) and the **one-release legacy path**
> (`HERDR_AUDIT_LOCAL_BUDGET=1`). Everything in this section remains true only
> under that flag; see *Proxy-derived audit admission — gate, vocabulary and
> the one-release flag* for the current contract.

**Problem.** On 2026-09-26 four downtime audits ran concurrently on a single host —
dispatched by *different projects' dispatchers*. The existing per-instance
active-audit single-flight (WL-0MT3PHW4I002SNOV) only reads the per-worklog
`<cwd>/.worklog/downtime-dispatches.log`, so it cannot see an audit dispatched
by another project on the same host. Both the shared Local Proxy slots and the
audit runner's host-wide slot (`AUDIT_MAX_CONCURRENCY=1` in cheap-proxy mode)
were saturated; the audit for `SA-0MUG0WFP8008WN63` failed on every Pi call
after 90 s and was aborted with no usable verdict.

**Contract (pre-proxy; now the one-release legacy path).** Under
`HERDR_AUDIT_LOCAL_BUDGET=1`, at most **`maxAudit` audit-tier `/skill:audit`
runs (default 1) are actively executing per host**, across herdr instances and
projects, tracked in the machine-scoped dispatch-budget ledger
(`~/.herdr/downtime/dispatch-budget.json`, entries with `kind: "audit"`) with
the cap in `~/.herdr/downtime/budget.json` (`{"maxAudit": 2}`; `0` is the
kill switch). The retired `active-audit` marker file is replaced by the ledger
(WL-0MVXY0XPF006YUHA F2):

- **Reserved** in `dispatchClaimedTier` immediately before the dispatch marker
is written, so BOTH dispatcher paths (`dispatchDowntimeWork` and
`dispatchFromCoordination`) funnel through one admission read.
- **Released** on every abort path and outcome — audit pane close, dispatch/
spawn failure, marker-write/claim rollback — and by the 2 h stale window; the
same release points the marker had.
- **Read first** by `getActiveAudit` before the per-worklog check. It counts
fresh `kind: "audit"` entries (no live-pane requirement — the marker's
semantics, so `maxAudit: 1` behaves exactly as before) against `maxAudit` and
returns `{ ok: true, active: true, source: 'host-wide', reason, budget }`
without any `wl` call, so the audit tier is skipped host-wide. The reported
reason token is:
  - **`audit-host-saturated`** at `maxAudit: 1` (default) — unchanged for
    existing consumers and decision-log tooling;
  - **`host-budget-audit`** at every other cap, including `maxAudit: 0`
    (live/max `0/0`);
  - **`host-budget-unknown`** when an unreadable ledger had to be rewritten
    from the live pane list (fail-closed; the next tick can decide again).
  All three are neutral **holds on one candidate** — never `no-candidate`, so
  the no-candidate cooldown is not entered and the next idle tick re-checks.
  The head scan records the hold and keeps scanning, so a `plan`/`intake`
  candidate behind the refused audit can still dispatch this tick.
- **Legacy read-compatibility (exactly one release).** A non-stale
`active-audit` file written by an OLDER herdr instance is counted as ONE
synthetic audit entry, so a mixed-version host can never double-dispatch.
This version never creates and never removes the file. The decision, the
mixed-version rationale and the removal schedule are recorded in the
`machine-coordination.ts` module comment; the consolidated gate table,
machine-dir file table, default rationale, fail directions and removal
schedule live in *Host-wide dispatch budget — gate table, defaults and scope*
above (**F6**, WL-0MVXY10QH0020V7S).
- **Staleness:** an entry whose `heartbeatAt` is at/older than
`DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS` (default **2 h**, the same constant) is
reaped on read, so a crashed audit pane can never block the host indefinitely.

**Relationship to the existing guards** (defence in depth — the host-wide
gate is the *outermost* audit-concurrency guard, never a replacement):

| Guard | Scope | Sees | Action |
|---|---|---|---|
| **Proxy-owned audit budget** (default, WL-0MW95GBEG005ERHS) | cross-machine, every ContextHub host sharing the one local GPU | the proxy's audit cap and live audit leases (`GET {proxyUrl}/llama/local/audit/status`) | skip that audit candidate and keep scanning; reason `audit-budget-saturated`; a non-`ok` read fails closed as `audit-budget-unknown` |
| **Host-wide ledger** (one-release legacy path) | machine-wide, all projects/instances | `maxAudit` fresh audit reservations from ANY project on this host | skip that audit candidate and keep scanning; reason `audit-host-saturated` (`maxAudit: 1`) / `host-budget-audit` / `host-budget-unknown` |
| **Per-worklog single-flight** (WL-0MT3PHW4I002SNOV) | one project's dispatch log | a non-stale `kind=audit` marker mapping to an `in_progress` item in THIS worklog | skip audit tier; reason `audit-in-flight` |
| **Proxy-slot gating** (per-slot availability / `contention_queue_depth` / per-slot `lease_state` / prefill gate) | the Local Proxy | live slot availability, queue depth, lease state (v2 distinguishes `generating` from `idle_leased`), `capacity_hint`, prefill in-flight/cap/waiters and prefill ETAs | ineligible/skip audit dispatch (per-tier minimum 2 free slots), `proxy-contention`, `capacity-saturated`, `prefill-gate` / `prefill-cap` / `prefill-eta`; unusable per-slot detail → `slots-unavailable` |
| **`AUDIT_PHASE2_PARALLELISM=1`** (always) | the audit skill's child fan-out | Phase 2 deep-analysis children | parent + one child = exactly 2 local slots (fully serial Phase 2) |

**Observability.** The skip is logged to stderr as
`Downtime audit tier skipped: <reason> (concurrentAudits=<live>,
[maxAudit=<cap>,] freeSlots=…, contentionQueueDepth=…)`. For the default
proxy path the reason is `audit-budget-saturated` (or `audit-budget-unknown`)
and `concurrentAudits` is the **proxy's** live-lease count against its cap; for
the one-release legacy path it is `audit-host-saturated` / `host-budget-audit`
/ `host-budget-unknown` and the count is the ledger's observed live audit
count. The skip is recorded (rate-limited) in
`.worklog/downtime-coordination.log` via the shared no-dispatch decision log
under the reported reason token, with the poll's `freeSlots`/`totalSlots`/
`contentionDepth`; a proxy/local disagreement adds the
`audit-budget-divergence` evidence entry (above). The free-slot and contention
figures distinguish infrastructure saturation from a content problem.

**Scope.** The **local ledger** is single-machine v1 (the dir resolves
per-user; ledger writes run under the existing coordination lock with an
atomic tmp+rename, so the audit tier adds no read-modify-write contention on
the shared `downtime-coordination.json`). **Cross-machine serialisation** of
the audit resource is the **proxy-owned audit budget queried over HTTP** —
`GET {proxyUrl}/llama/local/audit/status` — not flock/NFS. This supersedes the
old single-machine note in `machine-coordination.ts`; see *Proxy-derived audit
admission* above.

**Tests.** `host-dispatch-budget.machine.test.ts` pins the audit matrix
(`maxAudit` 0/1/2), the legacy-marker synthetic entry, the release points and
the fail-closed self-heal; `host-dispatch-budget.test.ts` pins the
marker-semantics counting (`freshCount`, `reduceMarkerCounts`); `index.test.ts`
exercises the real `createDowntimeDeps` wiring (`getActiveAudit` reads the
ledger cap, `recordDispatch` no longer writes the marker, `recordPaneClose`
releases the audit reservation); `downtime-worker.dispatch.test.ts` pins the
claim-pipeline admission and its release paths; `machine-coordination.test.ts`
pins the retired marker's read-only compatibility surface.

### Interactive over-quota confirmation — user-fired dispatches
### (WL-0MVXY0Z93002HKCZ F4, parent WL-0MVXWQFGV000D2AB)

**Problem.** The budget refused *dispatcher-fired* work at admission, but an
operator firing `/skill:implement` or `/skill:audit` by hand walked straight
past it — the pane opened and the ledger was never consulted, so hand-fired
work could take the host over the cap the operator had configured.

**Contract.** A hand-fired `/skill:implement` / `/skill:audit` dispatch consults
the SAME machine-scoped ledger and caps as the dispatcher, and — when the tier
is at or over its cap — asks first, in the worklist pane, before anything
observable happens. The gate lives in `index.ts`'s `route === 'agent'` block,
BEFORE the claim and before any spawn, so it covers **both** branches of that
route with one enforcement point: the interactive pane and the headless
`open_pane: false` background dispatch. Dispatcher-fired work never prompts —
it refuses that candidate, logs the reason and keeps scanning (above).

| State | Behaviour |
|---|---|
| **below cap** | No dialog, no extra keypress (the common path is unchanged). The ledger entry is reserved best-effort, so hand-fired work counts against the budget like dispatcher-fired work. |
| **at / over cap** | The bottom-anchored dialog opens over the still-visible selection list. `Enter`/`y` = proceed anyway, `Esc`/`n` = cancel; **cancel is the state on open**, and every other key leaves it there (a stray keypress can never dispatch over quota). |
| **cancel** | Nothing happens: no claim, no pane/background spawn, **no ledger entry**. The work item is untouched. |
| **proceed** | Dispatch continues exactly as before and the ledger entry is reserved with `override: { by: "user" }`, so the decision log and the hold/counter surfaces can distinguish a deliberate human override from drift. |
| **ledger unreadable** | **Fails OPEN** with a visible notice on stderr — `Host dispatch budget ledger unreadable — proceeding without the quota check.` — and the dispatch proceeds without a reservation. The corrupt bytes are never rewritten from this path (the dispatcher's repair owns that). |
| **coordination dir unresolvable** | Proceeds silently: no machine dir means no ledger and no new failure mode (parent AC11). |

**Copy (AC3/AC4).** The dialog names the tier, the live count, the cap and the
overshoot, e.g. `Implement dispatch would exceed the host quota (2 running, max 2) — over by 1.`
The overshoot is the shared `computeOverQuota` figure — at cap ⇒ over by 1;
already `n` over cap ⇒ over by `n + 1`; a disabled tier (`max 0`) quotes the
documented `0/0` evidence and is over by 1 — so the dialog and the
dispatcher's log can never disagree.

**Fail directions are deliberately different** (parent design):

| Path | Unreadable ledger | Rationale |
|---|---|---|
| Dispatcher (admission) | **fail closed** — skip that candidate and keep scanning, reason `host-budget-unknown`, self-healing rewrite from the live pane list | nobody is watching; over-admitting is unbounded |
| Interactive (this gate) | **fail open + visible notice** | a human is present and owns the decision; a corrupt ledger must never block their shortcut |

**Modules.** `host-budget-dialog.ts` is the pure dialog half — the copy helper,
`HostBudgetDialogState` key handling (cancel-first), the bordered box and the
bottom-anchored overlay (same composition rules as `ship-it-dialog.ts`), plus
`createHostBudgetPromptHost()`, the renderer↔awaiter bridge: the worklist
registers the renderer, the dispatch path awaits `ask()`. With no renderer
registered — or a TUI torn down while a prompt is pending — an `ask()` resolves
`cancel`, so a dispatch can never silently proceed over quota and can never
hang. `host-dispatch-budget.interactive.ts` is the decision half:
`budgetKindForAgentCommand()` (implement family / audit; everything else is
outside the budget) and `prepareInteractiveAgentDispatch()`, which reads the
cap, counts with the ledger's own per-tier semantics (`liveCount` for implement;
the pane-aware `auditDisplayCount`/`reduceAuditDisplayCounts` for the audit
dialog, matching the header — WL-0MW8IQNY7003JIOL), prompts only at/over cap,
then claims.

**Known limitation.** The implement tier counts an entry whenever its
`paneId` is in the machine-wide live pane list (the F1 liveness table) —
including stale-but-live entries: since WL-0MW9VQ08W000SN63 a confirmed
implement whose pane is in the trusted live list counts regardless of
heartbeat age (pane-derived freshness), so a >2 h run is never silently
dropped from the counter or the cap. The pane branch confirms the
reservation with the captured pane id once `send-to-pi.sh` reports the
split; a headless `open_pane: false` dispatch never gains a pane, so its
entry is recorded (and carries the override) but never counts toward the
implement cap. The audit dialog's count is pane-aware (the header's display
rule, WL-0MW8IQNY7003JIOL) while its **admission** stays marker-compatible —
the two rules differ only by dead (pane-gone) confirmed entries.

**Tests.** `host-budget-dialog.test.ts` pins the copy/overshoot arithmetic and
every key path; `host-dispatch-budget.interactive.test.ts` pins the gate
against the isolated machine-dir fixture (under-quota no-op, cancel with no
claim/ledger entry, proceed with `override: { by: 'user' }`, the fail-open
notice, both agent branches, and — for WL-0MW8IQNY7003JIOL — dialog-vs-header
agreement for dead / live / unconfirmed / stale audit entries plus the
unchanged implement-tier counting);
`host-budget-dialog-tui.test.ts` drives the REAL worklist with the REAL
shortcut registry and prompt host, proving the dialog renders over the list and
that `y`/`Enter`/`Esc` resolve the dispatch path.

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
- code freeze, the host-wide dispatch-budget gate and the per-worklog
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
sequential filter chain as the registered-root sweep and the own-backlog
fallback (classify → dispatched
marker id-guard → attempt budget → non-terminal cooldown → code-freeze → audit
≥ 2 free slots → critical in-flight guard → review-queue hold) and only
`audit` items are eligible. If no audit candidate survives, the registered-root
sweep runs and then the unchanged all-kinds own-backlog fallback.

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

### Leaf-aware audit dispatch (parent WL-0MSORQ8Y4004YT63)

**What changed.** The audit tier's slot requirement used to be a single
number: ≥ `DOWNTIME_AUDIT_MIN_FREE_SLOTS` (= 2) free slots, because a parent
audit's Phase 2 fan-out (parent pane + one child at
`AUDIT_PHASE2_PARALLELISM=1`) needs two local slots. But most audit
candidates are **leaf** items (no children) whose audit is a single Pi
session needing exactly **one** slot. Leaf-aware dispatch makes the audit
minimum per-**candidate**: `DOWNTIME_LEAF_AUDIT_MIN_FREE_SLOTS` (= 1) for a
trusted leaf, the unchanged `DOWNTIME_AUDIT_MIN_FREE_SLOTS` (= 2) for a
parent — so a pool with only one spare slot can still run leaf audits.

**Admission sequence (band → scope lookup → pin).** A leaf audit can only
dispatch through the leaf slot band:

1. **Band detection** — `isLeafAuditSlotBand(freeSlots)`: the tick is in the
   band when `DOWNTIME_LEAF_AUDIT_MIN_FREE_SLOTS <= freeSlots <
   DOWNTIME_AUDIT_MIN_FREE_SLOTS` (with the shipped constants exactly one
   free slot). At/above the parent minimum every audit candidate is
   admissible **without** a scope lookup (AC1: zero extra `wl` calls in the
   normal case); below the leaf minimum no audit can run.
2. **Scope lookup** — only inside the band the worker classifies the
   candidate via `getAuditCandidateScope` (`wl show <id> --children
   --json`) → `classifyAuditScope`. **Fail-closed (AC1/AC2):** anything
   other than an explicit, trusted `'leaf'` — `{ok:false}`, a missing
   `scope`, an unexpected token, a thrown/absent lookup, a
   `needsProducerReview` candidate, or a non-root candidate — is a
   `'parent'`, restoring the full `DOWNTIME_AUDIT_MIN_FREE_SLOTS` gate. The
   same per-item predicate `auditItemEligible` is the single definition the
   Herdr-head filter, the critical-first scan and the legacy tier chain
   share, so every path decides identically for the same
   candidate/free-slot pair (AC3).
3. **Pin** — a positively classified leaf in the band still has to wait
   for the **same single slot** to be continuously free for the full idle
   threshold (per-slot identity, WL-0MSG7P9N8009PCKG), then the tick
   admits the band as a **pin** (`probeLeafAuditAdmission` →
   `LeafAuditAdmission` → `ctx.leafAuditAdmission` →
   `pinnedAuditItemId`). The pin reserves the relaxed slot for THAT item
   alone (`auditPinAdmits`): every non-audit tier is ineligible
   (implement/plan/intake, critical, scheduled prompts, stalled-resume),
   and the audit tier admits no other candidate. A relaxed tick whose
   pinned item cannot dispatch ends neutrally (`LEAF_AUDIT_PIN_HOLD_REASON`,
   header token `leaf-audit-pin-hold`) — never `no-candidate`, so no
   no-candidate cooldown and no strike.

   Only the **threshold-tracker** branch relaxes on this path: the
   proxy-idle-age branch (`local_idle_seconds`) deliberately keeps the
   configured capacity. The opt-in `downtimeLeafAuditImmediate` toggle is
   the documented exception (see the next subsection).

**Coordination path (leader) — identical semantics, offered pin.** The
leader dispatches from the shared coordination offer file, so its relaxed
slot must be pinned to an item that is actually **offered**
(WL-0MVV1F130009VZ1P). `probeCoordinationLeafAuditAdmission` scans the
offers in file order with the leader's own dispatch-time re-validation
seams (`fetchItem` → `classifyItemForDispatchDetail` → host-budget audit
admission (`getActiveAudit`) → `getAuditCandidateScope` → `classifyAuditScope`) and
admits the first offer that is an eligible root audit candidate with a
trusted `'leaf'` scope. No new ranking, no second eligibility definition.
**Parity requirement:** for an identical payload/candidate set the direct
and coordination paths must decide identically — same classifier, same
single-flight, same scope lookup, same pin — and emit the same
`leaf-audit-admission` evidence. Pinned by the *parity — the direct and
coordination paths decide identically* group and *records the same
`leaf-audit-admission` evidence as the direct path* in
`coordination-dispatch.test.ts`.

**Fail-closed rules (never relax past a refusal).** The band admission and
both per-item gates return `false`/no-admission — restoring today's
behaviour exactly — for every case below; each is also pinned in
`downtime-worker.leaf-audit.test.ts`:

| Case | Outcome |
| --- | --- |
| `freeSlots >= DOWNTIME_AUDIT_MIN_FREE_SLOTS` | eligible, **no** scope lookup (AC1) |
| `freeSlots < DOWNTIME_LEAF_AUDIT_MIN_FREE_SLOTS` | ineligible, no lookup |
| leaf band, trusted `'leaf'` scope | eligible via the band |
| leaf band, `'parent'` scope | skipped (fail-closed; `audit-tier-budget-skipped` token) |
| leaf band, `{ok:false}`/thrown/absent scope lookup | skipped (fail-closed — treated as parent) |
| active audit in flight (single-flight) | no admission |
| live contention / prefill-gate waiters / prefill pacing deferral | no admission |
| `needsProducerReview === true` candidate | no admission (never relax a budget-exhausted item) |

**Decision-log tokens.** The relaxed band emits **non-blocking**
observations (never a blocking header token, never a strike):

| Token | Meaning | Key fields |
| --- | --- | --- |
| `leaf-audit-admission` | The tick relaxed its required-free-slots gate for ONE pinned leaf audit. | `freeSlots`, `thresholdMetCount`, `requiredFreeSlots`, `leafAuditItemId`, `leafAuditScope: 'leaf'`, `leafAuditImmediate` |
| `audit-tier-budget-skipped` | The audit tier was skipped for a slot-budget reason — in the leaf band because the only candidate is a `parent`/unclassifiable (the audit tier's 2-slot minimum is exactly why). | `skippedTier: 'audit'`, plus the same slot/threshold fields and `leafAuditItemId` / `leafAuditScope` |

Both tokens are emitted on **both** the direct and the coordination path;
the coordination path additionally attributes per-offer rejections with the
`audit-slot-min` gate on the terminal decision entry (see *Empty-offer &
skipped-tier attribution*).

**Dependency status.** The per-slot identity dependency LP-0MSORPUMX002LLIA
is **resolved** — the proxy serves `slots: [{slot_id, is_processing}]` and
herdr trusts that payload per the fail-closed contract WL-0MUXVPXAZ005RESW;
same-slot stability is guaranteed by the per-slot idle tracker
(WL-0MSG7P9N8009PCKG) that the band evidence (`thresholdMetCount`) reads.

**Tests.** `downtime-worker.leaf-audit.test.ts` pins the classifier and its
fail-closed defaults, the leaf-band budget, `auditItemEligible` across the
three selection paths (AC3 agreement group), the pin semantics, the tick
admission with the single-tier pin (AC1/AC2), same-slot identity (AC5),
the non-blocking observation tokens (AC4) and the full fail-closed matrix
(AC3); `coordination-dispatch.test.ts` pins the leader-path probe and the
direct/coordination parity (C5). The closing verification slice (C8,
WL-0MVV1F2W5001883R) adds three end-to-end gates to the leaf-audit suite: the
**pre-change baseline parity** group (AC2 — parent-audit and non-audit
action+reason unchanged on the 2-of-3-free and all-free fixtures), the
**parent AC6 traceability** group (AC5 — one targeted assertion per listed test
obligation: classification, children-query failure → parent gate, per-slot
tracker integration, race-accepting toggle) and the test that pins the
**scripted decision-log scenario**
(`packages/herdr/scripts/leaf-audit-decision-log-scenario.ts`, AC3). The
scenario drives the real worker tick against fixed payloads and prints the
decision-log excerpts reported on the parent work item:

```bash
npx tsx packages/herdr/scripts/leaf-audit-decision-log-scenario.ts
```

**Waiting for the fire-and-forget log is event-driven, never a fixed sleep
(WL-0MW0YD2T6004FRDJ).** The worker writes decision entries with
`void recordDecision(...)`, so `tick()` can resolve before an append lands.
The scenario used to read the log back after a fixed 25 ms sleep; on a
saturated host (load avg 14–23 from a concurrent full suite) the append
sometimes landed later, the captures came back empty, and the suite went red
on the same tree that passed on `--rerun-failures`. The scenario now injects
`deps.recordDecision` — delegating to the same production
`appendCoordinationLogEntry` path, only with an optional simulated delay —
tracks every append the tick starts and awaits them all
(`settleDecisionWrites`, re-checking for appends queued behind an in-flight
write) before reading the log back. A slow append only makes the run slower.
`downtime-worker.leaf-audit.test.ts` pins it with a scenario run under a
150 ms per-append delay: the same three reason tokens (`leaf-audit-admission`,
`audit-tier-budget-skipped`, `slots-unavailable`) are still captured with the
same dispatch outcomes.

**AC traceability (parent WL-0MSORQ8Y4004YT63).**

| AC | Implementation | Pinned by |
| --- | --- | --- |
| AC1 children-query fetch, fail-closed | `getAuditCandidateScope` dep + `classifyAuditScope` (fail-closed `'parent'`) | `downtime-worker.leaf-audit.test.ts` (classifier + fail-closed defaults) |
| AC2 leaf = ≥ 1 slot | `DOWNTIME_LEAF_AUDIT_MIN_FREE_SLOTS = 1`, `isLeafAuditSlotBand`, `auditItemEligible` | leaf-audit tests (1-free leaf dispatch, parent/unknown skip) |
| AC3 parent = all/2-slot gate unchanged | `DOWNTIME_AUDIT_MIN_FREE_SLOTS` unchanged; per-item gate stops doing lookups at/above it | selection-paths-agree tests |
| AC4 same-slot stability | per-slot idle tracker (WL-0MSG7P9N8009PCKG) + band evidence | same-slot-identity worker tests |
| AC5 opt-in race-accepting variant | `downtimeLeafAuditImmediate` (default OFF) | `settings.test.ts` + `downtime-worker.leaf-audit.test.ts` ON/OFF matrix |
| AC6 tests | classification, fail-closed, per-slot tracker integration, toggle | the suites named above + the closing C8 traceability group |
| AC7 documentation | this subsection, `packages/herdr/README.md` (*Leaf-aware audit minimum*), code comments | this document |

### Leaf-audit admission: the opt-in race-accepting toggle (WL-0MVV1F1P1005PO5M)

**Context.** A leaf audit candidate (an item with **no children**, classified
by `classifyAuditScope` from `wl show <id> --children --json`) is audited by a
single Pi session, so one free slot suffices
(`DOWNTIME_LEAF_AUDIT_MIN_FREE_SLOTS = 1`, C3). By default (C4,
WL-0MVV1F0HK009JQAP) the tick still requires that
slot to have been **continuously free for the full `downtimeIdleThresholdMs`**
(same-slot identity from the per-slot idle tracker) before it admits the tick
for that one pinned leaf audit.

**Setting.** `downtimeLeafAuditImmediate` (plugin settings,
`~/.config/herdr/worklog-plugin.json`) — boolean, default **`false`**
(`DEFAULT_DOWNTIME_LEAF_AUDIT_IMMEDIATE`); absent or malformed (a string, a
number, `null`) resolves to `false`. Re-read live on **every** tick, so turning
it on/off applies without a plugin restart.

**Race trade-off (opt-in only).** With the toggle **ON** a positively
classified leaf audit dispatches on **one trusted free unowned slot
immediately** — it does not wait the idle threshold, and therefore races any
interactive request for that slot: the request may take it, and the audit's
first call then falls back to the remote model. The default stays OFF so the
fail-closed policy (parent AC5) is unchanged; onboarding this variant is an
explicit operator decision, never a default.

**Nothing else is relaxed.** The toggle bypasses the threshold **wait** only.
Every refusal still applies on both settings: unusable per-slot detail
(`slots: []` / `slots_stale: true` → `slots-unavailable`),
`capacity_hint: "saturated"` (→ `capacity-saturated`), live contention
(`contention_queue_depth > 0` / `prefill_gate_waiters > 0`), the prefill
serialisation gate (`evaluatePrefillPacing`), owned slots
(`countFreeUnownedSlots` excludes them), the proxy-owned audit budget
(`GET {proxyUrl}/llama/local/audit/status`; the legacy `maxAudit` cap only
under `HERDR_AUDIT_LOCAL_BUDGET=1`) and a
`parent`/unclassifiable candidate. The relaxed slot stays **pinned** to that
one leaf audit (`ctx.leafAuditAdmission`, the C4 single-tier pin), so no
implement/plan/intake pane can consume it.

**Observability.** The `leaf-audit-admission` decision-log token carries
`leafAuditImmediate` next to `freeSlots` / `thresholdMetCount` /
`requiredFreeSlots` / `leafAuditItemId` / `leafAuditScope`, so a relaxed tick
is attributable to the toggle from the log alone; when the band holds only a
parent candidate the `audit-tier-budget-skipped` observation carries the same
field.

**Tests.** `settings.test.ts` pins default/parse/round-trip and the
absent/malformed → `false` fallback;
`downtime-worker.leaf-audit.test.ts` pins OFF parity with C4, the immediate
ON admission (including under proxy idle-age authority), the live per-tick
read and the full fail-closed matrix under ON.

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

#### Offer-only mode (downtimeOfferOnly) - WL-0MWDDHOK6009GJCC

A herdr instance whose downtime dispatch is deliberately switched off
(`downtimeEnabled: false` or a live manual `d` disable marker) normally produces **no
coordination offer at all**: the enabled/disable gate returns before the leader
election/check-in, so the fleet leader cannot see that root's backlog. The only
workaround used to be hand-registering the root in `downtimeWorklogRoots`, which
duplicates a source of truth the instance already knows. Typical deployments: a
desktop instance that must not run agents locally (no local model capacity, contested
GPU, machine in use) and a laptop kept only as a viewer.

`downtimeOfferOnly` (default `false`) closes the gap. When dispatch is disabled AND
`downtimeOfferOnly: true`, the tick performs the **coordination check-in only**: it
computes and writes/refreshes this instance's `entries` offer via the same
`computeMostImportantItem` computation, filters and staleness semantics as an active
instance (`runCoordinationCheckIn`, unchanged cadence — the non-leader 5-min default,
WL-0MTMPSCL8000O45H; AC6), then stops. A passive instance **never** polls the llama
proxy, takes the leader lease, runs a CAS claim, writes a dispatch marker, reserves
capacity or spawns a pane — the gate routes these ticks through
`runOfferOnlyCheckIn` *before* the election/poll/dispatch phases are reachable (fail
closed in code, not by convention; AC3). The knob is re-read every tick, so a settings
change applies without a plugin restart (AC1).

Composition notes:

- **Fail-open (AC5).** A failed offer computation (`{ok:false}`) or coordination write
  keeps the previous entry intact, never throws out of the tick and never removes
  another instance's entry.
- **Leader-side compatibility (AC6).** The elected leader's dispatch-time re-validation
  (`fetchItem` → `classifyItemForDispatch` → gates) and its 24 h `hasPeerOffer`
  liveness predicate are unchanged — an offer from a passive instance is
  indistinguishable from an active one at dispatch time, so no leader change is
  required and no second selection path exists.
- **Transient quiescence.** Offer-only never renews or takes the lease. An instance
  that already HELD the lease when the mode was switched on keeps it until the 5-min
  TTL expires (nothing renews it), so dispatch may pause for up to one TTL before a
  new election — automatic, safe, and inherent to "the passive instance must not
  dispatch or lead".
- **Prefer over `downtimeWorklogRoots` when the root's instance is running but
  passive.** `downtimeOfferOnly` removes the operational need to maintain the registry
  for such roots: the instance advertises the work it can see itself. The two
  mechanisms are independent and compose — see the registered-root discovery section
  above for when the registry is still the right tool (roots with **no** running herdr
  instance at all).

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
   per-process single-flight guards are unchanged. The proxy-owned audit
   budget gate remains audit-tier scoped (an open
   critical item is never audit-kind, so matching the legacy tier ordering
   it escalates even while an audit is in flight).
3. **No second ranking is introduced (AC3).** Scanning never re-ranks
   against a separate `wl list` lookup — candidates come only from the
   Herdr head, and only the critical group is re-ordered (by `sortIndex`).
   `computeMostImportantItem` returns the critical item as the instance's
   offer, so the coordination leader (which validates offers at
   dispatch-time without a marker check) dispatches it.
4. **A critical `completed`/`in_review` (audit-kind) item is out of the
   scan's scope** — it is handled by the normal audit tier, so the
   audit-freshness and host-wide audit-budget gates keep acting on it unchanged.

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
1 h – 7 d; the same bound documented under "Rolling log trimming, retention & rotation"). It is
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
WL-0MT50LKAK001EF5Q single cap source). The **local coordination/ledger**
paths are single-machine, and the **audit budget** is cross-machine via the
proxy-owned audit-availability read (WL-0MW95GBEG005ERHS) rather than a
flock/NFS extension (see *Proxy-derived audit admission*).

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

- No double-dispatch or double-join: a stable `instanceId` writes at most
  one `entries` offer regardless of stale legacy file presence — and none at
  all while its window is empty, in which case the top-level `leader` block
  (above) is what records it.
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
| Success-marker staleness window | **24 h** (`downtimeMarkerStaleWindowMs`; clamped to 1 h – 7 d; releases a stranded success marker at an unchanged stage, WL-0MU6UL0RJ008IHGT; the **same** window bounds the `hasPeerOffer` peer-entry liveness check, WL-0MVR8GDJ3008WY3Y AC7) | `DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS` (`downtime-worker.constants.ts`), `clampDowntimeMarkerStaleWindowMs` (`downtime-worker.clamps.ts`) |
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
| `packages/herdr/src/dispatcher-anchor*.ts` | The dispatcher-anchor module family: the barrel (`dispatcher-anchor.ts`, re-exports only) over the sibling modules — constants/types (`contract.ts`), `herdr` output parsers (`cli-parsers.ts`), subprocess helpers + deps factory (`herdr-cli.ts`), anchor/tab-anchor persistence (`persistence.ts`), Dispatcher provisioning and per-prefix tab anchors (`tab-anchors.ts`), project workspace + item-ID placement (`placement.ts`) (full layout: [dispatcher-anchor module layout](#dispatcher-anchor-module-layout-wl-0mvghcp9005sjpz)) |
| `packages/herdr/src/machine-coordination.ts` | Machine coordination dir resolver (`~/.herdr/downtime` / `HERDR_COORDINATION_DIR`) |
| `packages/herdr/src/leader-election.ts` | Lock acquisition, lease management, re-election (machine dir) |
| `packages/herdr/src/coordination.ts` | Coordination file read/write (entries, prune, upsert) — machine dir `downtime-coordination.json` |
| `packages/herdr/src/downtime-worker*.ts` | The downtime-worker module family: the barrel (`downtime-worker.ts`, re-exports only) over the sibling modules — worker tick orchestration (`downtime-worker.orchestrator*.ts`, `worker-contract.ts`, `launch-fence.ts`), dispatch (`dispatch.ts`, `dispatch-filter.ts`, `dispatch-claims.ts`, `dispatch-cpu-gate.ts`, `dispatch-contract.ts`), coordination (`coordination.ts`, `coordination-leader.ts`), the bounded head scan + registered-root sweep (`head-scan.ts`), gates/prompts/stalled-resume, pane, idle/poller, parsers/selection, constants/types/clamps (full layout: [Module layout](#module-layout)) |
| `packages/herdr/src/stalled-work.ts` | Stalled-pane classifier + machine-wide scan + in-place resume orchestrator (`classifyStalledPane`, `scanStalledPanes`, `resumeStalledPane`) |
| `packages/herdr/src/capacity-starvation.ts` | Capacity-refusal episode tracker + `capacity-starved` signal (`CapacityStarvationTracker`, `isCapacityRefusal`, clamp) — observation only (WL-0MVKNC2N50025HXE) |
| `packages/herdr/src/long-running-panes.ts` | Long-running pane detector (`classifyLongRunningPane`, `scanLongRunningPanes`, clamp) — observation only (WL-0MVKNC2N50025HXE) |
| `packages/herdr/src/downtime-log*.ts` | The downtime-log module family: the barrel (`downtime-log.ts`, re-exports only) over the sibling modules — storage/rotation policy and atomic append (`downtime-log-storage.ts`), host-budget refusal vocabulary (`downtime-log-budget.ts`), coordination/decision log (`downtime-log-coordination.ts`), dispatch log and pane-close entries (`downtime-log-entries.ts`), dispatched-marker readers and suppression decisions (`downtime-log-markers.ts`), recent-dispatches projection and time blocks (`downtime-log-recent.ts`) (full layout: [downtime-log module layout](#downtime-log-module-layout-wl-0mvgkhft4003x6jw)) |
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
| `~/.herdr/downtime/downtime-coordination.json` | Shared coordination list (machine dir, one entry per instance) plus the `leader` block naming the elected leader and its latest decision token (WL-0MW1VINII003IL7R) |
| `~/.herdr/downtime/downtime-coordination.lock` | Coordination lock (machine dir, guards anchor provisioning + coordination writes) |
| `~/.herdr/downtime/downtime-round-robin-by-root.json` | Global per-`worklogRoot` round-robin cursor `{ "<root>": "<ISO-8601>" }` — the least-recently-served root starts the offer ordering and the registered-root sweep (WL-0MTJDX4M4007YH5U; fail-open) |
| `~/.herdr/downtime/dispatch-budget.json` | Machine-scoped dispatch-budget ledger `{ version: 1, entries: [{ kind, itemId, instanceId, paneId?, root, startedAt, heartbeatAt, override? }] }` — one entry per in-flight `implement`/`audit` dispatch (WL-0MVXY0WQF0069YDJ); audit entries stale-release after 2 h. **Audit entries are observability-only for admission** (WL-0MW95GBEG005ERHS): the header/dialog/sweep read them, but they can never refuse an audit — the proxy owns that decision |
| `~/.herdr/downtime/budget.json` | Optional per-tier caps `{ "maxImplement": 2, "maxAudit": 1 }` (absent → those defaults; `0` disables a tier; `HERDR_HOST_MAX_IMPLEMENT`/`HERDR_HOST_MAX_AUDIT` override). **Implement-tier only for admission**: `maxAudit` is **not** the audit-admission authority — it is the one-release legacy cap (`HERDR_AUDIT_LOCAL_BUDGET=1`) and the local figure the divergence log compares against |
| `~/.herdr/downtime/active-audit` | ~~Host-wide audit serialisation marker~~ **Retired** (WL-0MVXY0XPF006YUHA F2): a non-stale file written by an older instance is still read as ONE synthetic audit entry; this version never creates or removes it |
| `<worklog-root>/.worklog/downtime-leader.lock` | Legacy per-worklog lock (orphaned after F6, ignored) |
| `<worklog-root>/.worklog/downtime-coordination.log` | Check-ins, elections, pruning + no-dispatch decisions (per worklog; rotating, 500 entries/file × 4 files ≈ ≥ 24 h — see [Retention & rotation](#rolling-log-trimming-retention--rotation)) |
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
- **A worklog root with dispatchable work is never served:** if no herdr
  instance runs in that root it writes no coordination offer, so the offer
  path can never see it. Register the root in `downtimeWorklogRoots` (the
  absolute path of the worklog ROOT — the parent of `.worklog/`), then
  confirm `loadSettings` kept it: a relative path, a missing/unreadable
  directory, or one without `.worklog/worklog.db` is dropped **per entry**
  (fail-open), so a typo silently yields `[]` and no sweep. The sweep only
  runs when the offer list yields nothing dispatchable, so check the
  decision log for `selectionPath: registered-root-sweep` and remember each
  root's own code freeze, review-queue depth and in-flight panes still gate
  it.
- **Audits skipped with `audit-budget-saturated` (WL-0MW95GBEG005ERHS):**
  the **proxy** reports its audit budget saturated — its audit cap is at its
  live-audit-lease count, possibly held by ANOTHER ContextHub host sharing the
  same local `llama-server` GPU. This is expected cross-machine serialisation,
  not a failure: audits resume when a live lease expires or is released on the
  proxy. Inspect the proxy read (`curl <proxyUrl>/llama/local/audit/status`) and
  the decision log (`grep 'audit-budget-saturated'
  <root>/.worklog/downtime-coordination.log`). **To raise the audit cap now,
  change the proxy's audit-budget configuration** (sibling llm item
  `LP-0MW95FYMH006XYNK`) — raising `budget.json` `maxAudit` has **no effect**
  on default audit admission. The proxy URL is `downtimeProxyUrl` in
  `~/.config/herdr/worklog-plugin.json` (default
  `http://192.168.0.199:8000`), the same URL the status poller and reserve
  client use.
- **Audits skipped with `audit-budget-unknown` (WL-0MW95GBEG005ERHS):** the
  audit tier **failed closed** because the proxy cannot answer — `404`
  (`endpoint-absent`, the proxy predates `/llama/local/audit/status`),
  `unreachable` (timeout/network/`http-<status>`), `unparsable` (`bad-body`),
  or no availability seam wired. Audit dispatch stops with a named reason
  rather than silently trusting a per-host cap. Check the proxy URL reachability
  and version; the `detail` on the decision entry names the failing exchange.
  **Fallback for one release:** set `HERDR_AUDIT_LOCAL_BUDGET=1` to restore
  the pre-proxy `budget.json` `maxAudit` + local-ledger decision (the legacy
  `audit-host-saturated` / `host-budget-audit` / `host-budget-unknown`
  tokens, and an `audit-budget-legacy` warning entry), or upgrade the proxy.
- **Audits skipped with `audit-host-saturated` / `host-budget-audit`
  (the one-release `HERDR_AUDIT_LOCAL_BUDGET=1` legacy path only):** the local
  ledger reports `maxAudit` fresh audit reservations, so an audit is already
  running — possibly dispatched by another project's dispatcher. Inspect the
  ledger (`cat ~/.herdr/downtime/dispatch-budget.json`), the legacy cap (`cat
  ~/.herdr/downtime/budget.json`) and the decision log
  (`grep -E 'audit-host-saturated|host-budget-audit' <root>/.worklog/downtime-coordination.log`).
  `host-budget-unknown` means the ledger was unreadable and had to be rewritten
  from the live pane list — check for a hand-edited/corrupt
  `dispatch-budget.json`. A leftover `active-audit` file only counts while it is
  fresh (one synthetic entry; it is never written or removed by this version).
  Remove `HERDR_AUDIT_LOCAL_BUDGET` to return to the proxy-owned budget.
  Set `HERDR_COORDINATION_DIR` when testing to avoid the live machine dir.
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
`queueEtaSeconds`, `queueEtaOccupancySeconds`, `queueEtaBusySlots`,
`prefillEtaCalibrated`, `slotPhases`, `slotPrefillEtaSeconds`); prefill pacing
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
`audit-in-flight` and `audit-host-saturated` / `host-budget-audit` /
`host-budget-unknown` (host-budget blocks), `slot-owned`,
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

### Empty-offer & skipped-tier attribution (WL-0MVR8FKMU009XTED)

A starved root must be **self-diagnosing**: "why is nothing being dispatched?"
is answered from the log alone, without reading the dispatcher's source or
re-running classification by hand. Two additive surfaces provide the answer.

**1. The check-in records an empty-offer reason.** Every `operation:
'checkin'` entry in `.worklog/downtime-coordination.log` that leaves
`workItemId: null` carries a machine-readable `reason`. The entry itself
already existed (one line per check-in), so this is **attribution on an
existing line**, not a new line per cycle — the rolling 100-entry bound and the
check-in cadence are unchanged.

| `reason` | Meaning | Extra fields |
|---|---|---|
| `empty-window` | The Herdr head lookup returned no items at all. | `windowSize: 0` |
| `all-window-items-held` | **Every** candidate was rejected solely by a non-empty `assignee` (the producer sentinel `Map`, …). | `heldAssignees` (sorted, deduplicated sentinels), `windowSize`, `dominantGate: 'assignee-hold'`, `gateCounts` |
| `all-window-items-gated` | Candidates were rejected by other gates. | `dominantGate` (the gate that rejected the most items), `gateCounts`, `windowSize` |
| `code-freeze` | Every rejection was the freeze split-by-skill pause. | `dominantGate`, `gateCounts` |
| `review-queue-hold` | Every rejection was the deep review-queue hold. | `dominantGate`, `gateCounts` |
| `attempt-budget-exhausted` | Every rejection was the per-item/per-kind attempt budget. | `dominantGate`, `gateCounts` |
| `in-flight-hold` | Every rejection was the critical in-flight guard. | `dominantGate`, `gateCounts` |
| `non-terminal-cooldown` | Every rejection was the non-terminal pane-close cooldown. | `dominantGate`, `gateCounts` |
| `stalled-resume` | A stalled pane was resumed in place, so no new offer was made. | — |
| `wl-error` | The offer computation failed; the existing entry was **kept** (fail-open). | `error`, `workItemId` (the kept offer) |

The per-item gate tokens (`gateCounts` keys and `dominantGate`) are stable
strings: `soft-deleted`, `producer-review`, `assignee-hold`,
`not-dispatchable`, `audit-fresh`, `audit-recency`, `effort-cap`,
`dispatched-marker`, `attempt-budget-exhausted`, `non-terminal-cooldown`,
`code-freeze`, `cpu-saturated`, `audit-slot-min`, `review-queue-hold`,
`in-flight-pane`, `slots-unavailable`, `audit-budget` (the proxy-derived
audit budget refused the audit offer — the per-offer counterpart of the
`auditBudgetHold` terminal hold, WL-0MWDDHVF2004PTYX AC5), `wl-error`.

**The result semantics are unchanged.** A fully-held window is still
`noCandidate` (the 60-minute no-candidate cooldown behaves exactly as before,
and the genuinely-empty-backlog path is byte-identical); only the explanation
is added. The attribution is derived in memory from the window already read —
no extra `wl` spawn.

```json
{"kind":"coordination","operation":"checkin","instanceId":"87558ae9",
 "workItemId":null,"reason":"all-window-items-held","windowSize":30,
 "heldAssignees":["Map"],"dominantGate":"assignee-hold",
 "gateCounts":{"assignee-hold":30},"at":"2026-10-27T22:05:00.000Z"}
```

**2. The leader attributes every offer it rejects.** A coordination-mode
decision entry whose terminal reason collapsed a rejected offer list (for
example a bare `no-candidate`) additionally carries `offerRejections` — one
element per rejected entry, with the entry's work item, its worklog root and
the gate that rejected it:

```json
{"kind":"decision","operation":"no-dispatch","instanceId":"…",
 "reason":"no-candidate","freeSlots":2,"totalSlots":2,
 "offerRejections":[{"workItemId":"WL-ABC","worklogRoot":"/repo/a",
                     "gate":"assignee-hold","assignee":"Map"}],
 "at":"2026-10-27T22:06:00.000Z"}
```

`offerRejections` is evidence only: it is recorded on the **existing**
rate-limited refusal line (an identical reason inside
`DOWNTIME_DECISION_LOG_MIN_INTERVAL_MS` is still suppressed), and the refusal
token / header blocking token / dispatch decision are unchanged. The
`audit-slot-min` gate attributes an audit offer skipped by the raw slot budget;
the tick-level `audit-tier-budget-skipped` observation (see [Prefill
serialisation pacing](#prefill-serialisation-pacing-wl-0mvhszrzq00482qx-wl-0mvr8fi4q0007cgr))
carries the same budgets for **both** the direct and the coordination path.

**Tests.** `downtime-worker.offer-attribution.test.ts` pins the aggregation
tokens (empty window, all-held with sentinels, dominated gate, tie-break, sole
dedicated gate, the shared `classifyWindowHold` helper);
`coordination-dispatch.test.ts` pins each check-in token end-to-end (including
the `wl-error` entry-kept path and the unchanged no-candidate/entry-removal
semantics), the leader's per-offer rejections, and that they appear on the
terminal decision entry.

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
| `selectionPath` | string | Which loop selected the candidate: `critical-first`, `normal-scan`, `coordination-offer`, `registered-root-sweep` (registered-root discovery, WL-0MVR8GDJ3008WY3Y), `own-backlog` (coordination own-backlog fallback, WL-0MUU4XFU90008E24), `scheduled-prompt`, or `legacy-tier` |
| `selectionReason` | string | Machine-readable reason: e.g. `no-live-pane`, `marker-stale-escalation`, `in-flight-pane` (skip), `non-critical`, `leader-offer`, `registered-root-sweep` (WL-0MVR8GDJ3008WY3Y), `own-backlog-fallback` (WL-0MUU4XFU90008E24), `scheduled-due`, `critical-tier` |
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

### Rolling log trimming, retention & rotation

**Dispatch log (`downtime-dispatches.log`) — unchanged:** the log file is
bounded to the most recent 100 entries (`DOWNTIME_LOG_MAX_ENTRIES`). Entries
are appended; when the file exceeds 100 lines the first lines are truncated.
The dispatched-marker readers (audit/implement/plan/intake scope guards) and
the recent-dispatches view depend on this single-file contract and are
untouched by the retention work.

**Coordination log (`downtime-coordination.log`) — size-based rotation with
N kept (WL-0MVKNC28B003UOLX):** the current file holds up to
`COORDINATION_LOG_MAX_ENTRIES` (default **500**) entries; when the next
append would exceed that the whole current file rotates to a numbered sibling
(`downtime-coordination.log.1`, `.2`, … — `.1` is the newest rotated file)
and a fresh current file starts, so the entry that triggers the rotation is
never lost. At most `COORDINATION_LOG_MAX_ROTATED_FILES` (default **3**)
siblings are kept; the oldest is dropped. The retained window is therefore
**bounded** by `maxEntries × (1 + maxRotatedFiles)` entries and never falls
below `maxEntries × maxRotatedFiles + 1` — with the shipped default
(500/file × 3 rotated) the coordination log always holds between 1,501 and
2,000 entries, i.e. **≥ 25 h and up to ~33 h** at the observed ≥ 60 decision
entries/hour (a full overnight post-mortem window), with disk bounded to
~2,000 JSONL lines. The policy is configurable via the worker config
(`coordinationLogMaxEntries` / `coordinationLogMaxRotatedFiles` on
`DowntimeWorkerConfig.config()`) and clamped by `resolveCoordinationLogPolicy`
(10–10,000 entries; 0–20 siblings; 0 siblings = no rotation, single-file
trim). `readCoordinationLogEntries` keeps reading the **newest** file
(unchanged contract); `readCoordinationLogAllEntries` returns the full
chronological history over the rotated siblings plus the current file.
`hourlyReasonTally` (same module) counts no-dispatch decision reasons per UTC
hour over a time range.

**Atomic replacement (WL-0MUBVL1FI0071WN3 / F5).** Both logs (and every
rotated sibling) are written **atomically**: `appendRollingJsonl` writes the
full new content to a temporary sibling file
(`.<file>.<pid>.<random>.tmp` in the same directory, so the rename stays on
one filesystem) and `rename`s it over the target. A concurrent reader — in
particular the dispatched-marker readers that scan the log by kind — therefore
sees either the whole previous file or the whole new one, **never** a
truncated, empty, or partially written log. Previously the writer did
`readFile → push → trim → writeFile` directly on the target, so a reader could
momentarily observe an empty file and lose a marker (a contributing factor in
the duplicate-dispatch RCA, WL-0MUBEZ6PE002WLP4 / H3). The temp file is
removed on failure before the error is rethrown and the target is left
untouched; trimming/rotation and the throw-on-I/O-failure (fail-closed)
contract are unchanged, and the JSONL format stays human-readable.

**Operator summary recipe (WL-0MVKNC28B003UOLX AC3) — per-hour no-dispatch
reason tally for a given night.** The decision log is the only forensic
evidence of capacity-saturation starvation, so a post-mortem must be able to
reconstruct "how many of which reason per hour". Concatenate the rotated
siblings with the current file (they are in append order) and tally
`kind: 'decision'` entries by UTC hour and `reason`:

```bash
# Per-hour no-dispatch reason tally across ALL retained history
ls .worklog/downtime-coordination.log* 2>/dev/null \
  | sort -V \
  | while read -r f; do cat "$f"; done \
  | jq -r 'select(.kind == "decision") | [(.at[0:13] + ":00Z"), .reason] | @tsv' \
  | sort | uniq -c | sort -k2,2 -k1,1nr

# Restrict to a night (e.g. 2026-10-22T21:00Z → 2026-10-23T05:30Z)
ls .worklog/downtime-coordination.log* 2>/dev/null \
  | sort -V \
  | while read -r f; do cat "$f"; done \
  | jq -r 'select(.kind == "decision" and .at >= "2026-10-22T21:00" and .at < "2026-10-23T05:30") \
          | [(.at[0:13] + ":00Z"), .reason] | @tsv' \
  | sort | uniq -c | sort -k2,2 -k1,1nr
```

The same tally is available programmatically via
`readCoordinationLogAllEntries(cwd)` + `hourlyReasonTally(entries, { from, to })`.

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
  `20:00–24:00`). Blocks are ordered **newest first** (the most recent
  activity at the top, WL-0MVLEM606008UAL1), and within each block
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
- Work item: **WL-0MW5JE0SZ0057K30** *Dispatcher opening a pane but not
  executing a command* — late placement (after host-budget admission) and
  placeholder root-pane cleanup on every pre-spawn abort (documented in *No
  orphaned placeholder pane* above)
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
- Work item: **WL-0MVR8GDJ3008WY3Y** *Downtime leader cannot see a worklog
  root with no running herdr instance* (registered-root discovery — option
  O1; documented in *Registered-root discovery* above) with its children for
  the `downtimeWorklogRoots` setting + validation, the registered-root
  sweep, and the liveness-aware `hasPeerOffer`
- Work item: **WL-0MTJDX4M4007YH5U** *global round-robin cursor module
  (`downtime-round-robin-by-root`)* — the least-recently-served cursor the
  sweep reuses for root-level fairness
- Work item: **WL-0MTMPIQBE001J41P** *stale coordination entry pruning
  (deliberate no-op)* — entry expiry stays a no-op; liveness lives only in
  the `hasPeerOffer` read predicate
- Work item: **WL-0MST3OJ8S0001ROL** *Refactor Downtime Dispatcher: leader
  election with shared coordination file* — the coordination/offer
  architecture the registered-root sweep composes with
- Docs work item: **WL-0MT76H3Z900908TV** (this page)