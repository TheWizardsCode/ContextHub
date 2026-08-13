# RCA — Downtime dispatcher re-dispatches the same work item

**Date:** 2026-08-13 · **Work item:** WL-0MSRBFFLN005W3VT · **Severity:** critical (operational)

## Headline

The herdr downtime worker (`dispatchDowntimeWork`, `packages/herdr/src/downtime-worker.ts`)
still dispatches the same work item more than once. Two distinct root causes are
proven from dispatch-log evidence, reproduced by
`packages/herdr/scripts/scan_duplicate_dispatches.py` across all five
`.worklog/downtime-dispatches.log` roots on this host:

1. **RC-1 — same-instant cross-pane race (audit tier; affects all tiers).** Two
   panes select the same candidate before either claims it, because selection
   happens **before** claim and the claim is not conditional (read-then-write /
   TOCTOU). Proven by a pair of audit dispatches **14 ms apart** on the same
   item/root (SA-0MSN4AXIQ007IZG2, 2026-08-10T21:20:53.909Z and
   .923Z) — *after* the dispatched-marker exclusion landed (2026-08-09).
2. **RC-2 — plan tier has no dispatched-marker exclusion; "stage self-guard" fails.**
   The plan tier (`getNextItem('intake_complete')`) has no marker exclusion
   (unlike audit/implement), and `wl next --stage intake_complete` keeps
   `completed` items under a stage filter (no client-side `status === 'open'`
   guard on the plan/intake tiers). A plan run that aborts/errors resets
   **status only** (`StatusLifecycle.update_status(<id>, "open")`,
   `skill/plan/SKILL.md`), leaving the stage at `intake_complete` — the item is
   re-selected on the next idle window. Proven by plan-tier duplicate pairs
   post-fix (SA-0MSMAZP6T007NM0O, SA-0MSN04X2S006ONH0), including one item
   plan-dispatched 7× in ~7 h (SA-0MSJI53RX006E2PS, pre-fix, demonstrating the
   unbounded-loop severity).

**Deliverable:** this RCA + a fix design (below). Implementation is explicitly
deferred to a follow-up work item — **WL-0MSRDEWES0059TZN** (scope guard,
blocked-by this item).

## Evidence — reproduced duplicate scan

Run:
```bash
python3 packages/herdr/scripts/scan_duplicate_dispatches.py            # all pairs
python3 packages/herdr/scripts/scan_duplicate_dispatches.py --json     # machine-readable
python3 packages/herdr/scripts/scan_duplicate_dispatches.py --since 2026-08-09T14:16:32Z   # post-fix
```

Full scan (2026-08-13): **17 duplicate (kind, itemId) pairs** across the five
roots — 12 audit pairs and 5 plan pairs.

### Post-fix pairs (marker exclusion landed 2026-08-09, commit `228019bd` 14:16:32Z)

| Kind | Item | Count | First / last dispatch (UTC) | Gap | Root cause |
|---|---|---|---|---|---|
| audit | SA-0MSN4AXIQ007IZG2 | 2 | 2026-08-10T21:20:53.909Z / .923Z | **14 ms** | RC-1 (same-instant race) |
| plan | SA-0MSMAZP6T007NM0O | 2 | 2026-08-12T06:59:43.732Z / 2026-08-13T04:50:06.423Z | ~21.8 h | RC-2 (no plan marker; stage self-guard fails) |
| plan | SA-0MSN04X2S006ONH0 | 2 | 2026-08-12T11:05:30.321Z / 2026-08-13T05:19:08.331Z | ~18.2 h | RC-2 (no plan marker) |
| audit | WL-0MSHUMX5C004NC4O | 2 | 2026-08-09T15:29:41.663Z / 16:35:15.612Z | ~1.1 h | same-day, pre-reload of the Aug-9 fix |
| audit | OSL-0MSLY6OY2003BAFL | 2 | 2026-08-09T16:02:55.919Z / 17:17:01.825Z | ~1.2 h | same-day, pre-reload of the Aug-9 fix |
| audit | CG-0MSL0OP040043KKZ | 2 | 2026-08-09T16:48:42.313Z / 18:54:50.274Z | ~2.1 h | same-day, pre-reload of the Aug-9 fix |

> **Deployment-timing note:** the three audit pairs on 2026-08-09 are **after**
> the fix commit time but on the same day the fix landed; herdr panes reload
> plugin code only when restarted, so these are consistent with panes still
> running the pre-fix code (the re-selection loop the exclusion closes). They
> are **not** evidence against the exclusion. The definitive post-fix audit
> duplicate is the 14 ms RC-1 pair on 2026-08-10 — which the marker exclusion
> cannot prevent by construction (selection precedes claim/marker write).

### Pre-fix pairs (re-selection loop the Aug-9 fix closed, plus severity demo)

| Kind | Item | Count | Span | Note |
|---|---|---|---|---|
| plan | SA-0MSJI53RX006E2PS | **7** | 2026-08-09T00:46Z–07:31Z (~6.8 h) | unbounded loop severity, plan tier |
| audit | WL-0MSGTLSUT002NF29 | 2 | 2026-08-09T01:51Z–10:59Z | re-selection loop, audit tier |
| audit | WL-0MSKUG2WW0058A7W | 2 | 2026-08-09T06:38Z–13:49Z | re-selection loop, audit tier |
| audit | SA-0MSL51XSF0086KM5 | 2 | 2026-08-09T14:45Z–16:48Z | re-selection loop, audit tier |
| plan | WL-0MSGG5N5Z0074TLY | 2 | 2026-08-06T23:51Z–2026-08-07T00:03Z | pre-fix |
| audit | CG-0MSJ7ZXDB002CX97 | 2 | 2026-08-09T02:58Z–15:42Z | re-selection loop |
| audit | CG-0MSJ7ZXD5005N9E5 | 2 | 2026-08-09T13:49Z–14:55Z | re-selection loop |
| audit | DS-0MSAZSAPL003YHVR | 2 | 2026-08-07T06:07Z–2026-08-08T02:49Z | pre-fix |
| audit | DS-0MSDIVUPU003Y22W | 2 | 2026-08-09T07:20Z–10:22Z | re-selection loop |
| audit | OSL-0MSKODN9T001G9U7 | 2 | 2026-08-09T00:46Z–15:05Z | re-selection loop |
| plan | OSL-0MSGCVSDH002656S | 2 | 2026-08-07T09:49Z–10:08Z | pre-fix |

## Root causes

### RC-1 — Same-instant cross-pane race (audit tier; affects all tiers)

- **Evidence:** SA-0MSN4AXIQ007IZG2 (SorraAgents root) — `kind=audit`
  dispatched at 2026-08-10T21:20:53.909Z **and** 21:20:53.923Z — two log
  entries **14 ms apart**, same item, same root, both recorded as success.
  Post-fix (marker exclusion landed 2026-08-09).
- **Mechanism (code-traced):**
  - Every herdr pane runs its own `dispatchDowntimeWork`; `dispatchInFlight`
    is per-process only (`downtime-worker.ts:196`). Cross-pane serialization
    is explicitly delegated to the pre-dispatch claim (code comment on
    `dispatchInFlight`: "the claimed item leaves `wl next`'s selection set").
  - Selection happens **before** claim in every tier
    (`dispatchDowntimeWork`, `downtime-worker.ts:232-280`):
    `getNextAuditCandidate`/`getNextItem` reads the dispatch log (no marker
    yet) → selects → `claimItem` → `spawnAgentPane` → `recordDispatch`
    (marker written **after** spawn).
  - `claimWorkItem` (`packages/herdr/src/fetcher.ts:623`) runs
    `wl update <id> --status in_progress --assignee <assignee>` — idempotent:
    re-claiming an already-`in_progress` item also "succeeds", so both panes
    proceed. Claim failures are discarded by `claimItem`
    (`packages/herdr/src/index.ts:456-462`; open follow-up
    WL-0MSLWJ310000ND0X). Result: two identical panes for one item.
  - **Why the existing marker cannot prevent it:** the dispatched-marker
    exclusion is read-then-write (TOCTOU) on
    `.worklog/downtime-dispatches.log`; both panes read the log before either
    appends its marker, and the marker is written after spawn — even a correct
    read could not block the second pane in time.

### RC-2 — Plan tier has no dispatched-marker exclusion; "stage self-guard" fails

- **Evidence (post-fix, plan tier):**
  - SA-0MSN04X2S006ONH0 — `kind=plan` ×2: 2026-08-12T11:05:30Z and
    2026-08-13T05:19:08Z — no implement/audit between the two, i.e. the first
    plan run left the item selectable again.
  - SA-0MSMAZP6T007NM0O — `kind=plan` ×2: 2026-08-12T06:59:43Z and
    2026-08-13T04:50:06Z — the second plan dispatch occurred even though the
    item had completed a full plan → implement → audit cycle.
  - SA-0MSJI53RX006E2PS — `kind=plan` ×7 in ~7 h (2026-08-09T00:46Z–07:31Z) —
    pre-fix, but demonstrates the unbounded loop severity of the same tier.
- **Mechanism (code-traced):**
  - The plan tier (`getNextItem('intake_complete')` →
    `wl next --stage intake_complete --json`, `index.ts:351-383`) has **no**
    dispatched-marker exclusion, unlike the audit/implement tiers
    (`getNextAuditCandidate`/`getNextImplementCandidate` consult
    `readDowntimeLogEntries`; the plan/intake tiers do not).
  - The plan skill's error/abort path is `StatusLifecycle.update_status(<id>,
    "open")` — **status only; stage is left at `intake_complete`**
    (`skill/plan/SKILL.md` "On error/abort"). A plan pane that aborts (model
    error, infra failure, killed session) resets the item to
    `open`/`intake_complete` → the dispatcher re-selects it on the next idle
    window. The audit runner has a similar restore-to-captured-state path
    (`skill/audit/scripts/audit_runner.py` `finally` block, lines ~6458-6538)
    that can likewise leave an item selectable.
  - **Amplifier:** `wl next`'s stage filter does **not** remove completed
    items (`filterCandidates` step 3 in
    `packages/shared/src/database.ts:1931-1968`: completed items removed only
    when **no** stage filter is active), and the plan/intake tiers have no
    client-side `status === 'open'` guard (the implement tier has one —
    `selectImplementCandidate` filters `c.status === 'open'`). So even a
    `completed`/`in_review` item whose stage equals `intake_complete` is
    selectable for `/skill:plan`.

### RC-3 (contributing, audit tier) — marker fragility

The audit-tier marker exclusion works for the re-selection loop (no post-fix
audit re-dispatch beyond RC-1), but it is per-worklog-root
(`.worklog/downtime-dispatches.log` at `<cwd>`), bounded at
`DOWNTIME_LOG_MAX_ENTRIES = 100`, and written **after** spawn — a pane that
dies before `recordDispatch` leaves no marker. These are residual risks, not
the observed failure.

## Fix design (for follow-up implementation)

Five design points, matching the four mechanisms above. Implementation is the
follow-up work item WL-0MSRDEWES0059TZN; this section records the agreed
option choices.

1. **Verified conditional claim (compare-and-swap) before spawn — closes RC-1.**
   Make the pre-dispatch claim atomic at the DB layer: transition to
   `in_progress` only if the item is still in the selectable state the tier
   chose it in. Option A (recommended): `wl update <id> --status in_progress
   --if-status <open|completed> [--if-stage <stage>]` — a guarded update
   added to `src/commands/update.ts` + `packages/shared/src/database.ts
   update()`. Option B: a DB-level guarded update exposed via a new CLI flag.
   Exactly one concurrent pane wins; a loser (0 rows changed, or claim
   failure) **aborts the dispatch** — no pane, no marker, no success log.
   This also absorbs WL-0MSLWJ310000ND0X (claim failures must not be
   silently discarded when they mean "another pane won").
2. **Marker write before spawn + fail-closed — hardens RC-1 at the log layer.**
   Move `recordDispatch`'s log append ahead of `spawnAgentPane` in every tier
   (`dispatchDowntimeWork`, `downtime-worker.ts:232-280`); if the marker
   cannot be written, abort the dispatch (fail-closed) rather than dispatching
   an unmarked item. The work-item comment may stay post-spawn (best-effort
   trail); the **log marker is the exclusion source and must precede the
   pane**.
3. **Extend the dispatched-marker exclusion to the plan and intake tiers —
   closes RC-2.** Add kind-scoped marker sets (`plan`/`intake` entries) to
   `downtime-log.ts` (`planDispatchedItemIds`/`intakeDispatchedItemIds`,
   mirroring `auditDispatchedItemIds`/`implementDispatchedItemIds`) and wire
   them into `getNextItem`'s plan/intake selection paths in `index.ts`. Add a
   **change-guard**: exclude while the item is still at the stage it had at
   dispatch (`intake_complete` for plan, `idea` for intake); a stage
   advancement or an explicit human/state change releases the item for a
   legitimate retry (prevents plan-retry starvation, risk below).
4. **Client-side open-status guard on plan/intake tiers — closes the
   amplifier.** Filter to `status === 'open'` in the plan/intake
   parse/select paths (mirroring the implement tier's guard in
   `selectImplementCandidate`, `downtime-worker.ts`), so a `completed` item
   whose stage matches the filter is never dispatched for
   `/skill:plan`/`/skill:intake`. Requires `parseNextItemOutput` to carry
   `status` through (`DowntimeCandidate` gains a `status` field).
5. **Record dependencies/follow-ups:** WL-0MSLWJ3I70031Z8U (spawn failure
   still logged as success — with marker-before-spawn this becomes an abort
   path) and document the 100-entry log-roll limit as a residual risk (or
   extend `DOWNTIME_LOG_MAX_ENTRIES`).

### Option choices (explicit)

- **Conditional claim:** Option A (`wl update --if-status`/`--if-stage`
  guarded update) chosen as primary — reuses the existing CLI seam, keeps the
  dispatch code DB-agnostic; a DB-level guarded update is the fallback if the
  CLI flag cannot express `completed` (audit tier) + `open` (implement/plan/
  intake) uniformly.
- **Marker-before-spawn:** log append moves ahead of spawn in **all four
  tiers** (audit, implement, plan, intake); fail-closed abort on write error.
- **Change-guard semantics:** marker releases when the item's stage advances
  past the dispatched-at stage, or when a human/agent state change updates
  the item. Purely time-based release is **not** chosen (would re-open the
  re-selection loop).

## Key files

| File | Role |
|---|---|
| `packages/herdr/src/downtime-worker.ts` | `dispatchDowntimeWork` tier order; selection; where claim/spawn/marker ordering changes land |
| `packages/herdr/src/index.ts` | `getNextItem` (~351-383), `getNextAuditCandidate` (~378-410), `getNextImplementCandidate` (~413-455), `claimItem` (~456-462), `recordDispatch` (~465-490) |
| `packages/herdr/src/fetcher.ts` | `claimWorkItem` (~623) — where the guarded claim lands |
| `packages/herdr/src/downtime-log.ts` | marker source; extend with `plan`/`intake` kinds |
| `packages/shared/src/database.ts` | `filterCandidates` (stage-filter amplifier); `update()` (guarded update) |
| `src/commands/update.ts` | `--if-status`/`--if-stage` CLI flags |
| `skill/plan/SKILL.md` | error/abort resets status only (RC-2 mechanism) |
| `skill/audit/scripts/audit_runner.py` | finally-block status/stage restore path |
| `packages/herdr/scripts/scan_duplicate_dispatches.py` | evidence scan (this RCA) |

## Traceability

- **Prior fix:** WL-0MSLIY8ZR004QUSY "Downtime dispatcher triggers multiple
  identical sessions" (completed) — audit-tier-only marker exclusion; the
  "self-guard" assumption this RCA refutes. Commit `228019bd`.
- **Exclusion implementation:** WL-0MSLUASNF001LLAT (completed).
- **Regression tests to extend:** WL-0MSLUANM5004NNPU "Regression tests for
  audit-tier re-dispatch exclusion" (completed) — extend for plan/intake.
- **Open dependencies (absorbed by design):** WL-0MSLWJ310000ND0X (claim
  failure discarded → design point 1), WL-0MSLWJ3I70031Z8U (spawn failure
  logged as success → design point 2).
- **Wiki:** `concepts/downtime-dispatch` updated with this RCA's findings.

## Risks & assumptions

- **Assumption — same-host multi-pane is the observed scope.** The RC-1
  evidence is same-host (SorraAgents root, one host). Cross-host duplicates
  (two hosts sharing a worklog root) remain out of scope; the per-item
  worklog comment remains the durable cross-machine trail.
- **Risk — conditional claim semantics change claim behavior for all
  dispatches** (implement tier uses `claimItem` too): the CAS must accept
  every status the tier's query can return (`open` for plan/intake/implement,
  `completed` for audit) — design point 1's `--if-status` list.
- **Risk — plan retry starvation:** design point 3's change-guard must release
  the marker when the item legitimately advances, so a genuinely replanned
  item is not permanently blocked; define and test the change-guard precisely.
- **Risk — log roll:** the 100-entry bound can silently drop markers for
  long-unaudited items; documented residual risk (design point 5) unless
  trivially extended.

## Validation script

`packages/herdr/scripts/scan_duplicate_dispatches.py` reproduces the duplicate
scan (used for this RCA; also useful for verifying the follow-up fix — the
post-fix scan should show no audit pairs beyond a same-instant race and no
plan/intake pairs while items stay at their dispatched stage):

```bash
python3 packages/herdr/scripts/scan_duplicate_dispatches.py --since <fix-deploy-timestamp>
```
