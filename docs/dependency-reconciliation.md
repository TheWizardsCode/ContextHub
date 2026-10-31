# Dependency Reconciliation

This document describes how Worklog automatically manages the `blocked`/`open` status of work items based on their dependency edges.

## Overview

When a work item's status or stage changes, the database layer automatically reconciles all dependent items to determine whether they should remain blocked or be unblocked. This ensures consistency between the CLI, TUI, and any other interface that modifies work items through the `WorklogDatabase` API.

## Key Functions

The reconciliation logic lives in
`packages/shared/src/database/dependencies.ts` (extracted from
`packages/shared/src/database.ts` by WL-0MVOBP6K0007574C; the `WorklogDatabase`
members of the same name are thin delegates to these functions):

| Function | Purpose |
|---|---|
| `reconcileDependentsForTarget(targetId)` | Entry point: finds all dependents of `targetId` and reconciles each one |
| `reconcileDependentStatus(dependentId)` | Determines whether a dependent should be blocked or unblocked |
| `reconcileBlockedStatus(itemId)` | Sets or clears `blocked` status based on active blockers |
| `isDependencyActive(item)` | Returns `true` if an item is an active blocker (not completed, not deleted, not in `in_review` or `done` stage) |
| `hasActiveBlockers(itemId)` | Returns `true` if any inbound dependency edges point to active items |
| `getInboundDependents(targetId)` | Returns IDs of items that depend on `targetId` |
| `listDependencyEdgesTo(targetId)` | Returns all dependency edges where `targetId` is the prerequisite |

Dependency-edge CRUD (`addDependencyEdge`, `removeDependencyEdge`,
`listDependencyEdgesFrom`, `listDependencyEdgesTo`, `getAllDependencyEdges`)
lives in the same module. `EdgeCache` construction stays in
`packages/shared/src/database/context.ts` (`buildEdgeCache`); this module only
reads its `outbound` slice.

## How It Works

1. **Trigger**: `db.update()` and `db.deleteSingle()` check whether the status or stage changed. If so, they call `reconcileDependentStatus(id)` to reconcile the item itself, then `reconcileDependentsForTarget(itemId)` to reconcile the item's dependents. `db.update()` returns the **persisted post-reconcile** record, so callers (including `wl update --json`) report the value the store actually holds.

2. **Self-reconciliation**: `reconcileDependentStatus(id)` checks if the item itself should be blocked or unblocked based on its own dependency edges. For example, when a completed item is reopened and its prerequisite is still active, it gets re-blocked.

3. **Explicit status/stage writes win** (WL-0MVTVYXZD002NDMP): the self-reconciliation in step 2 is derived state, so an explicitly requested status/stage must never be overwritten by it. `db.update(id, input, options)` and `db.updateIfMatches(...)` accept `UpdateOptions` with `reconcileSelf` (default `true`); `wl update` passes `reconcileSelf: false` whenever the caller supplied `--status`/`--stage`. Fan-out to **dependents** (steps 4–7) and the `wl dep add` / `wl dep rm` paths are unaffected — dependency-derived blocks and unblocks behave exactly as before.

   Defence in depth (WL-0MVTVZ9RU003D4WW): opting out of the known
   reverting write is not enough on its own, because any *other* late writer
   (a competing process, a future reconcile) could still win. After the
   write, `wl update` therefore **re-reads the persisted record** — never the
   update's return value — and, for an explicit `--status` request, compares
   it with the requested value. On divergence the per-id result is a failure
   with the distinct error code `status-not-persisted` naming both values
   (`requestedStatus` and `persistedStatus`), and the command exits non-zero.
   No update path (including the "no fields changed" path) can report
   `success: true` for an explicit `--status` request whose persisted status
   differs. The guard reports a lost write; it does not repair it —
   investigate the store before retrying.

4. **Fan-out**: `reconcileDependentsForTarget()` finds all items that depend on the changed item using `getInboundDependents()`.

5. **Per-dependent check**: For each dependent, `reconcileDependentStatus()` calls `hasActiveBlockers()` to determine if any remaining blockers are still active.

6. **Status update**: If no active blockers remain and the dependent is currently `blocked`, its status is set to `open`. If active blockers exist and the dependent is not already `blocked`, its status is set to `blocked`.

7. **Cascade**: The status update on the dependent itself triggers another round of reconciliation via `saveWorkItem()`, so chain dependencies (A blocks B blocks C) resolve transitively.

## Behaviour Summary

| Action | Effect on Dependents |
|---|---|
| Close a blocker (sole blocker) | Dependent unblocked (status -> `open`) |
| Close a blocker (other blockers remain) | Dependent stays `blocked` |
| Delete a blocker | Dependent unblocked if no other active blockers |
| Move blocker to `in_review` stage (sole blocker) | Dependent unblocked (status -> `open`) |
| Move blocker to `in_review` stage (other active blockers remain) | Dependent stays `blocked` |
| Move blocker to `done` stage | Dependent unblocked if no other active blockers |
| Reopen a closed blocker | Dependent re-blocked (status -> `blocked`) |
| Move blocker back from `in_review` to an active stage | Dependent re-blocked (status -> `blocked`) |
| Close already-closed blocker | No-op (idempotent) |
| Move blocker to `in_review` multiple times | No-op (idempotent) |
| Dependent is completed/deleted | No status change (already terminal) |

> **Note:** The `in_review` stage is treated as non-blocking for **dependency edges only**.
> Parent/child relationships are not affected by this change — a child item moving to
> `in_review` does not unblock its parent.

## CLI and TUI Parity

Both the CLI `close` command (`src/commands/close.ts`) and the TUI close handler (`src/tui/controller.ts`) call `db.update(id, { status: 'completed' })`, which triggers the same reconciliation path. There is no separate unblock logic in either interface — all unblocking is handled by the shared database layer.

## Adding Dependencies via CLI

The `wl dep add` command (`src/commands/dep.ts`) adds a dependency edge and then sets the dependent item's status to `blocked` if the prerequisite is active. The database's `addDependencyEdge()` method only persists the edge itself; the auto-block on add is handled by the CLI command layer.

## Test Coverage

- **Unit tests**: `tests/database.test.ts` — `dependency edges` describe block contains tests for single-blocker unblock, multi-blocker scenarios, chain dependencies, delete unblock, reopen re-block, idempotence, `in_review` stage unblocking (single blocker, partial multi-blocker, all blockers, mixed in_review/completed, idempotence, re-block on stage revert, multiple dependents), and more.
- **CLI integration tests**: `tests/cli/issue-management.test.ts` — tests for `close` and `dep` commands verifying end-to-end unblock behaviour through the CLI, including `in_review` stage unblocking (single blocker → in_review, partial multi-blocker, all blockers → in_review).
- **Explicit-status regression tests**: `tests/regression-explicit-blocked-status.test.ts` — an explicit `wl update --status blocked` persists for items with no edges, with inbound-only edges, and with an active outbound blocker; an explicit `--status open` is not re-blocked by the self-reconcile; `dep rm` still unblocks; and `db.update` returns the persisted post-reconcile record (including with `reconcileSelf: false`).
- **Persistence-guard tests**: `tests/update-status-persistence-guard.test.ts` — through a stubbed database seam that lets a competing write win, an explicit `--status` write exits non-zero with `status-not-persisted` naming both values (never `success: true`); the consistent path still reports success; and an explicit `--status` that never reaches the store fails the same way.
