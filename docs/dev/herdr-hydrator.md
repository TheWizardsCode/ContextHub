# Herdr hydrator — self-healing `in_progress` claims

Work item: WL-0MSOJLZD9004P8PI
Folded-in scope: WL-0MTTSWE0G008M1VA (no-activity / claim-age timeout, 2026-09-13)

## Problem

Work items claimed as `in_progress` are correctly excluded from downtime
dispatch (single-flight — an active claim owns them). But there is no
automatic mechanism to detect claims that are **stuck**: status `in-progress`
with no matching agent tab (tab closed, session died, claim abandoned). Such
items linger at the top of the queue and are never re-selected — they block
themselves and top the Herdr selection list as non-dispatchable wall items
(RCA `WL-0MTTS9FY00055QJV`, root cause E; evidence
`AH-0MTP19DG100472CV`).

## Design

The hydrator is a scheduler task inside the worklist pane process, exactly
like the downtime worker:

1. **Every 30 s** — `wl list --status in-progress --json` (all in-progress
   items for the pane's worklog root).
2. **Fetch live tabs** — `herdr tab list --workspace <id>`; keep tabs in the
   **current workspace** (`HERDR_WORKSPACE_ID`; tabs without a workspace id
   are always included — fail-open toward "active").
3. **Match** — a tab whose label **exactly equals** the item's work-item ID
   (e.g. `WL-…`) counts as active; a label that merely *contains* the ID does
   not. Tabs are labelled with the exact work-item ID by the shared
   dispatcher-anchor anchors (`getItemTabAnchor`/`findTabByLabel`).
4. **Demote (release)** any item with no matching tab:
   - stage `in_review` → `status=completed`, stage `in_review`
   - an active outbound dependency blocker → `status=blocked` (stage
     repaired to a compatible value, e.g. `plan_complete` when the claim
     sat at `in_progress`)
   - otherwise → `status=open` at the claimed stage (the folded-in
     no-activity/claim-age timeout release: a no-tab claim is released
     regardless of activity age, reusing the existing 2 h dispatch stale
     window `DOWNTIME_AUDIT_STALE_WINDOW_MS` as the activity bound)
5. **Focus-resume** — the hidden→visible transition runs the check
   immediately (same runner, no interval wait).

### Safety (fail-open, never crash, never false-demote)

- An unavailable / unparseable `wl list` or `herdr tab list` **aborts the
  cycle without demoting** (no demotion on ambiguous evidence).
- An item with a live tab is never touched (the dep query is skipped entirely
  for it).
- A dependency lookup failure treats the item as not-blocked and still
  releases it to `open`.
- A failed `wl update` is logged and left unchanged (counted as skipped).
- Visibility-gated: a hidden worklog tab spawns zero `wl`/`herdr`
  processes.
- Single-flight + scheduler watchdog (`HYDRATOR_RUN_TIMEOUT_MS`): a hung
  run is abandoned and retried on the next tick, never wedging the task.

## Selection-list in-progress marker (WL-0MV1BWETT005GSUJ)

Demotion alone is not enough for the selection list: an item whose worklog
status is still `open` (e.g. a claim released before its tab was re-opened)
would show no marker even though a work-item tab is open. To make the marker
reflect tab existence directly, the same exact-label tab lookup also drives a
display overlay:

- `markItemsActiveByTab(items, activeIds)` recursively stamps
  `status = 'in-progress'` on every item whose ID is in the active tab set, so
  the row renders the in-progress icon and the item is placed in Group N. It
  is **idempotent**: each item's pre-marker status is captured on first sight
  (a non-enumerable `Symbol` property) and restored on every later pass, so a
  **closed** tab clears the marker back to the true worklog status without a
  `wl` re-fetch.
- `applyActiveTabMarkers(items, listTabs, workspaceId)` fetches the workspace
  tabs (fail-open) and applies the marker; the production wiring injects it
  into `runWorklistTui`'s `applyActiveTabMarkers` seam from `index.ts` (the
  same "inject from the caller" pattern as `mergeAgentStates`).
- **Update cadence.** Opening or closing a work-item tab does **not** touch the
  worklog DB, so the DB-change-gated refresh tick can never update this marker
  for it. The worklist therefore re-applies it on the initial load, on every
  full refresh, on the `active-tab-marker` scheduler task (the hydrator
  cadence, `HYDRATOR_INTERVAL_MS`), and on focus-resume. The marker task
  spawns only `herdr tab list` (never `wl`), so the zero-`wl`-when-idle
  guarantee holds; it is visibility- and typing-gated like the hydrator.
- Terminal `in_review`/`completed` items are deliberately left untouched:
  they already carry the review/audit marker and belong in the In Review
  group.

## Files

- `packages/herdr/src/hydrator.ts` — module: ID extraction, active-tab
  matching, demotion decision, tab-based selection-list marker
  (`markItemsActiveByTab` / `applyActiveTabMarkers`), compatibility repair,
  orchestration (`runHydrationOnce`), visibility-gated runner
  (`createHydratorRunner`), production deps
  (`createProductionHydratorDeps`).
- `packages/herdr/src/hydrator.test.ts` — unit tests (AC6 map below),
  including the pure tab-marker helper.
- `packages/herdr/src/worklist.ts` — registers the `hydrate` and
  `active-tab-marker` scheduler tasks, hooks the focus-resume path, and
  applies the injected `applyActiveTabMarkers` marker on the initial load,
  each refresh, the marker cadence, and focus-resume.
- `packages/herdr/src/worklist-active-tab-marker.test.ts` — integration tests
  for the selection-list marker wire-up (marker shown/hidden/scope).
- `packages/herdr/src/index.ts` — production wiring of the
  `applyActiveTabMarkers` seam.
- `packages/herdr/src/pane-title.ts` — `truncatePaneTitlePreservingSuffix`
  keeps the work-item ID visible in truncated pane titles (a human-readable
  concern now — the hydrator matches exact tab labels, not pane titles).

## Test map (AC6)

| Requirement | Test |
|---|---|
| ID extraction | `extractWorkItemIdsFromText` |
| active-tab matching (exact label, workspace-scoped) | `active-tab matching` |
| in_review → completed | `decideDemotion` + `runHydrationOnce` |
| dependency-blocked → blocked | `decideDemotion` + `runHydrationOnce` |
| else → open | `decideDemotion` + `runHydrationOnce` |
| stage/status compatibility | `compatibleStage`, blocked-at-`in_progress` case |
| focus-resume immediate run | `createHydratorRunner` (visibility flip) |
| selection-list marker (tab → in-progress) | `tab-based active marker (selection list)` + `worklist-active-tab-marker.test.ts` |
| fail-open error paths | `runHydrationOnce` (missing list, missing tabs, failed demotion) |

## Related

- `WL-0MSOJLZD9004P8PI` (this feature) · `WL-0MTTSWE0G008M1VA` (folded-in
  no-activity timeout, deleted) · `WL-0MTTS9FY00055QJV` (RCA root cause E) ·
  `WL-0MSJ4E8UA005KG9Y` (pane-title format, completed) ·
  `WL-0MSBQUJQX005RAT9` (agent-panes association — out of scope here, per
  the operator's pane-title decision).