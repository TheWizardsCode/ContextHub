# Herdr hydrator — self-healing `in_progress` claims

Work item: WL-0MSOJLZD9004P8PI
Folded-in scope: WL-0MTTSWE0G008M1VA (no-activity / claim-age timeout, 2026-09-13)
Active-detection rework: WL-0MV1BWETT005GSUJ (pane-title detection, 2026-10-16)

## Problem

Work items claimed as `in_progress` are correctly excluded from downtime
dispatch (single-flight — an active claim owns them). But there is no
automatic mechanism to detect claims that are **stuck**: status `in-progress`
with no matching agent pane (pane closed, session died, claim abandoned).
Such items linger at the top of the queue and are never re-selected — they
block themselves and top the Herdr selection list as non-dispatchable wall
items (RCA `WL-0MTTS9FY00055QJV`, root cause E; evidence
`AH-0MTP19DG100472CV`).

## Design

The hydrator is a scheduler task inside the worklist pane process, exactly
like the downtime worker:

1. **Every 30 s** — `wl list --status in-progress --json` (all in-progress
   items for the pane's worklog root).
2. **Fetch live panes** — `herdr pane list --workspace <id>`; keep panes in
   the **current workspace** (`HERDR_WORKSPACE_ID`; panes without a workspace
   id are always included — fail-open toward "active").
3. **Match** — a pane whose **title contains** the item's work-item ID
   (e.g. `Downtime triggered implement Foo - WL-…`) counts as active.
   Every pane spawned for an item is titled by the shared `pane-title.ts`
   builders (manual, shell, downtime), and
   `truncatePaneTitlePreservingSuffix` keeps the ID as a trailing suffix
   under truncation, so the ID reliably appears in the title.
4. **Demote (release)** any item with no matching pane:
   - stage `in_review` → `status=completed`, stage `in_review`
   - an active outbound dependency blocker → `status=blocked` (stage
     repaired to a compatible value, e.g. `plan_complete` when the claim
     sat at `in_progress`)
   - otherwise → `status=open` at the claimed stage (the folded-in
     no-activity/claim-age timeout release: a no-pane claim is released
     regardless of activity age, reusing the existing 2 h dispatch stale
     window `DOWNTIME_AUDIT_STALE_WINDOW_MS` as the activity bound)
5. **Focus-resume** — the hidden→visible transition runs the check
   immediately (same runner, no interval wait).

### Why pane titles, not tabs

An earlier revision matched the exact **label** of a workspace **tab**
(`herdr tab list`). That proved unreliable in practice
(WL-0MV1BWETT005GSUJ): tabs are created by the dispatcher *anchor* as a
placement side effect, so an item being dispatched can be evaluated before
its tab exists (a false-demotion race), and tabs can be re-parented or
renamed by the operator. Pane **titles** are set at spawn time, always carry
the item ID as a preserved suffix, and survive re-parenting — matching them
is the simple, reliable rule the producer directed:

> "It should be simple. Look for a pane in this workspace with the work item
> id as the title. If it exists then work item is busy."

### Safety (fail-open, never crash, never false-demote)

- An unavailable / unparseable `wl list` or `herdr pane list` **aborts the
  cycle without demoting** (no demotion on ambiguous evidence).
- An item with a matching pane is never touched (the dep query is skipped
  entirely for it).
- A dependency lookup failure treats the item as not-blocked and still
  releases it to `open`.
- A failed `wl update` is logged and left unchanged (counted as skipped).
- Visibility-gated: a hidden worklog tab spawns zero `wl`/`herdr`
  processes.
- Single-flight + scheduler watchdog (`HYDRATOR_RUN_TIMEOUT_MS`): a hung
  run is abandoned and retried on the next tick, never wedging the task.

## Selection-list in-progress marker (WL-0MV1BWETT005GSUJ)

Demotion alone is not enough for the selection list: an item whose worklog
status is still `open` (e.g. a claim released before its pane was re-opened)
would show no marker even though a work-item pane is open. To make the marker
reflect pane existence directly, the same pane-title lookup also drives a
display overlay:

- `markItemsActiveByPane(items, activeIds)` recursively stamps
  `status = 'in-progress'` on every item whose ID is in the active pane set,
  so the row renders the in-progress icon and the item is placed in Group N.
  It is **idempotent**: each item's pre-marker status is captured on first
  sight (a non-enumerable `Symbol` property) and restored on every later
  pass, so a **closed** pane clears the marker back to the true worklog
  status without a `wl` re-fetch.
- The same pass also drives the row's **green-circle icon** (the agent slot
  of the icon prefix): an item with a matching pane gets
  `agentState = 'working'` (the green circle) and an item without one gets it
  cleared. This is the producer's rule — the green circle appears exactly
  when a work-item pane is open in this workspace and never otherwise. The
  icon no longer depends on the event-driven agent-status tracker
  (WL-0MSBQUJQX005RAT9), which could not honour that invariant (a
  freshly-spawned/`unknown` pane is absent from `herdr agent list` and was
  pruned — losing its icon permanently; an agent `done` state pruned the
  icon even while the pane stayed open).
- `applyActivePaneMarkers(items, listActivePanes, workspaceId)` fetches the
  workspace panes (fail-open) and applies the marker; the production wiring
  injects it into `runWorklistTui`'s `applyActivePaneMarkers` seam from
  `index.ts`.
- **Update cadence.** Opening or closing a work-item pane does **not** touch
  the worklog DB, so the DB-change-gated refresh tick can never update this
  marker for it. The worklist therefore re-applies it on the initial load, on
  every full refresh, on the `active-pane-marker` scheduler task (the
  hydrator cadence, `HYDRATOR_INTERVAL_MS`), on focus-resume, and after pane
  lifecycle events (`pane_agent_status_changed` / `pane_agent_detected` /
  `pane_closed` / `pane_exited`) so the green circle tracks open/closed
  panes without the 30 s wait. The marker task spawns only `herdr pane list`
  (never `wl`), so the zero-`wl`-when-idle guarantee holds; it is
  visibility- and typing-gated like the hydrator.
- Terminal `in_review`/`completed` items are deliberately left untouched by
  the STATUS marker: they already carry the review/audit marker and belong
  in the In Review group. The green circle STILL reflects pane existence for
  them — an open pane means the item is being worked regardless of stage.

## Files

- `packages/herdr/src/hydrator.ts` — module: ID extraction, active-pane
  matching (`collectPaneWorkItemIds` / `isActivePaneMatch`), demotion
  decision, pane-based selection-list marker (`markItemsActiveByPane` /
  `applyActivePaneMarkers`), compatibility repair, orchestration
  (`runHydrationOnce`), visibility-gated runner (`createHydratorRunner`),
  production deps (`createProductionHydratorDeps`).
- `packages/herdr/src/hydrator.test.ts` — unit tests (AC6 map below),
  including the pure pane-marker helper.
- `packages/herdr/src/hydrator.fixtures.ts` — recording exec seam +
  worst-case pane/item fixtures.
- `packages/herdr/src/worklist.ts` — registers the `hydrate` and
  `active-pane-marker` scheduler tasks, hooks the focus-resume path, and
  applies the injected `applyActivePaneMarkers` marker on the initial load,
  each refresh, the marker cadence, and focus-resume.
- `packages/herdr/src/worklist-active-pane-marker.test.ts` — integration
  tests for the selection-list marker wire-up (marker shown/hidden/scope).
- `packages/herdr/src/index.ts` — production wiring of the
  `applyActivePaneMarkers` seam.
- `packages/herdr/src/pane-title.ts` — `truncatePaneTitlePreservingSuffix`
  keeps the work-item ID visible in truncated pane titles, which is what makes
  the pane-title match reliable.

## Test map (AC6)

| Requirement | Test |
|---|---|
| ID extraction | `extractWorkItemIdsFromText` |
| active-pane matching (title contains ID, workspace-scoped) | `active-pane matching` |
| in_review → completed | `decideDemotion` + `runHydrationOnce` |
| dependency-blocked → blocked | `decideDemotion` + `runHydrationOnce` |
| else → open | `decideDemotion` + `runHydrationOnce` |
| stage/status compatibility | `compatibleStage`, blocked-at-`in_progress` case |
| focus-resume immediate run | `createHydratorRunner` (visibility flip) |
| selection-list marker (pane → in-progress) | `pane-based active marker (selection list)` + `worklist-active-pane-marker.test.ts` |
| green circle (pane → `agentState`) stamp/clear | `markItemsActiveByPane` cases + `worklist-active-pane-marker.test.ts` |
| event-driven pane refresh (no `herdr agent list` exec) | `worklist-agent-state-event.test.ts` |
| fail-open error paths | `runHydrationOnce` (missing list, missing panes, failed demotion) |

## Related

- `WL-0MSOJLZD9004P8PI` (this feature) · `WL-0MTTSWE0G008M1VA` (folded-in
  no-activity timeout, deleted) · `WL-0MTTS9FY00055QJV` (RCA root cause E) ·
  `WL-0MSJ4E8UA005KG9Y` (pane-title format, completed) ·
  `WL-0MV1BWETT005GSUJ` (pane-title active-detection rework, this item) ·
  `WL-0MSBQUJQX005RAT9` (agent-panes association — now record-keeping only;
  the row green-circle icon is pane-title existence, WL-0MV1BWETT005GSUJ).
