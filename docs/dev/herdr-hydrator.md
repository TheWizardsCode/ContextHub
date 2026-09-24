# Herdr hydrator — self-healing `in_progress` claims

Work item: WL-0MSOJLZD9004P8PI
Folded-in scope: WL-0MTTSWE0G008M1VA (no-activity / claim-age timeout, 2026-09-13)

## Problem

Work items claimed as `in_progress` are correctly excluded from downtime
dispatch (single-flight — an active pane owns them). But there is no
automatic mechanism to detect claims that are **stuck**: status `in-progress`
with no live agent pane (pane closed, session died, claim abandoned). Such
items linger at the top of the queue and are never re-selected — they block
themselves and top the Herdr selection list as non-dispatchable wall items
(RCA `WL-0MTTS9FY00055QJV`, root cause E; evidence
`AH-0MTP19DG100472CV`).

## Design

The hydrator is a scheduler task inside the worklist pane process, exactly
like the downtime worker:

1. **Every 30 s** — `wl list --status in-progress --json` (all in-progress
   items for the pane's worklog root).
2. **Fetch live panes** — `herdr pane list`; keep panes in the **current
   workspace** (`HERDR_WORKSPACE_ID`; panes without a workspace id are
   always included — fail-open toward "active").
3. **Match** — a pane whose title contains the item's work-item ID (e.g.
   `WL-…`) counts as active. The shared pane-title builders
   (`packages/herdr/src/pane-title.ts`) preserve the ` - <id>` suffix when
   truncating long titles, so every spawned pane carries its ID.
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

### Safety (fail-open, never crash, never false-demote)

- An unavailable / unparseable `wl list` or `herdr pane list` **aborts the
  cycle without demoting** (no demotion on ambiguous evidence).
- A live-pane item is never touched (the dep query is skipped entirely for
  it).
- A dependency lookup failure treats the item as not-blocked and still
  releases it to `open`.
- A failed `wl update` is logged and left unchanged (counted as skipped).
- Visibility-gated: a hidden worklog tab spawns zero `wl`/`herdr`
  processes.
- Single-flight + scheduler watchdog (`HYDRATOR_RUN_TIMEOUT_MS`): a hung
  run is abandoned and retried on the next tick, never wedging the task.

## Files

- `packages/herdr/src/hydrator.ts` — module: ID extraction, active-pane
  matching, demotion decision, compatibility repair, orchestration
  (`runHydrationOnce`), visibility-gated runner
  (`createHydratorRunner`), production deps
  (`createProductionHydratorDeps`).
- `packages/herdr/src/hydrator.test.ts` — unit tests (AC6 map below).
- `packages/herdr/src/worklist.ts` — registers the `hydrate` scheduler task
  and hooks the focus-resume path.
- `packages/herdr/src/pane-title.ts` — `truncatePaneTitlePreservingSuffix`
  keeps the work-item ID in truncated pane titles (prerequisite fix).

## Test map (AC6)

| Requirement | Test |
|---|---|
| ID extraction | `extractWorkItemIdsFromText` |
| active-pane matching across tabs/workspace | `active-pane matching` |
| in_review → completed | `decideDemotion` + `runHydrationOnce` |
| dependency-blocked → blocked | `decideDemotion` + `runHydrationOnce` |
| else → open | `decideDemotion` + `runHydrationOnce` |
| stage/status compatibility | `compatibleStage`, blocked-at-`in_progress` case |
| focus-resume immediate run | `createHydratorRunner` (visibility flip) |
| fail-open error paths | `runHydrationOnce` (missing list, missing panes, failed demotion) |

## Related

- `WL-0MSOJLZD9004P8PI` (this feature) · `WL-0MTTSWE0G008M1VA` (folded-in
  no-activity timeout, deleted) · `WL-0MTTS9FY00055QJV` (RCA root cause E) ·
  `WL-0MSJ4E8UA005KG9Y` (pane-title format, completed) ·
  `WL-0MSBQUJQX005RAT9` (agent-panes association — out of scope here, per
  the operator's pane-title decision).