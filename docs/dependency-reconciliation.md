# Dependency Reconciliation

This document describes how Worklog automatically manages the `blocked`/`open` status of work items based on their dependency edges.

## Overview

When a work item's status or stage changes, the database layer automatically reconciles all dependent items to determine whether they should remain blocked or be unblocked. This ensures consistency between the CLI, TUI, and any other interface that modifies work items through the `WorklogDatabase` API.

## Key Functions

All reconciliation logic lives in `src/database.ts`:

| Function | Line | Purpose |
|---|---|---|
| `reconcileDependentsForTarget(targetId)` | ~1811 | Entry point: finds all dependents of `targetId` and reconciles each one |
| `reconcileDependentStatus(dependentId)` | ~1772 | Determines whether a dependent should be blocked or unblocked |
| `reconcileBlockedStatus(itemId)` | ~1749 | Sets or clears `blocked` status based on active blockers |
| `isDependencyActive(item)` | ~1701 | Returns `true` if an item is an active blocker (not completed, not deleted, not in `in_review` or `done` stage) |
| `hasActiveBlockers(itemId)` | ~1738 | Returns `true` if any inbound dependency edges point to active items |
| `getInboundDependents(targetId)` | ~1726 | Returns IDs of items that depend on `targetId` |
| `listDependencyEdgesTo(targetId)` | ~1696 | Returns all dependency edges where `targetId` is the prerequisite |

## How It Works

1. **Trigger**: `db.update()` (line ~655) and `db.delete()` (line ~688) check whether the status or stage changed. If so, they call `reconcileDependentsForTarget(itemId)`.

2. **Fan-out**: `reconcileDependentsForTarget()` finds all items that depend on the changed item using `getInboundDependents()`.

3. **Per-dependent check**: For each dependent, `reconcileDependentStatus()` calls `hasActiveBlockers()` to determine if any remaining blockers are still active.

4. **Status update**: If no active blockers remain and the dependent is currently `blocked`, its status is set to `open`. If active blockers exist and the dependent is not already `blocked`, its status is set to `blocked`.

5. **Cascade**: The status update on the dependent itself triggers another round of reconciliation, so chain dependencies (A blocks B blocks C) resolve transitively.

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
