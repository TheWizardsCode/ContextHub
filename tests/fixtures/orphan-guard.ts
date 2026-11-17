/**
 * Shared orphan-guard fixtures (WL-0MWGRJCXO006A9ZV, parent
 * WL-0MWFMKWZA005ZT4T — "Children survive deletion of their parent work item
 * and become unreachable orphans").
 *
 * Stable id constants + seed helpers for the four scenarios the parent
 * decomposition requires (see the parent's "Proposed decomposition", slice 1):
 *
 *   1. a **hard-deleted parent** with live children — the parent id is never
 *      seeded, so it resolves nowhere (`HARD_MISSING_PARENT`);
 *   2. a **soft-deleted parent** with live children — the parent row exists
 *      with `status: 'deleted'` (`SOFT_DELETED_PARENT`); today
 *      `validateParentReferences` treats such a parent as resolvable (R3b);
 *   3. a **foreign-prefix parent** with an own-prefix child — a `WL-` id
 *      referenced by a `TEST-` child (`FOREIGN_PARENT_WITH_OWN_CHILD`), the
 *      shape `wl doctor foreign-items --apply` must protect or cascade (R1);
 *   4. a **promotion** (`parentId -> null`) — a live child under a live
 *      parent (`PROMOTION`), plus a dangling-parent case (`DANGLING`) for the
 *      doctor remediation paths.
 *
 * The tests that consume these fixtures live in `tests/cli/`:
 *
 *   - `orphan-guard-prune.test.ts`      → R1 (hard-delete cascade-or-refuse)
 *   - `orphan-guard-reporting.test.ts`  → R3/R3b (grouped orphan reporting)
 *   - `orphan-guard-attribution.test.ts`→ R2 (attribution comments)
 *
 * These tests are **RED-pinned with `it.fails(...)`** — their assertions
 * fail on current main while the suite stays green for the gate — and go
 * green (as plain `it` specs, after the sibling slices flip the pins) once
 * the implementation lands. Repo convention for test-first fixture phases,
 * cf. tests/cli/doctor-prefix.test.ts.
 *
 * Note on seeding: `seedWorkItems` writes the ephemeral `.worklog/
 * worklog-data.jsonl`; the CLI imports it into SQLite on first open, so any
 * timestamp patching must happen before the first CLI invocation in a test.
 */

import * as fs from 'fs';
import * as path from 'path';
import { seedWorkItems } from '../cli/cli-helpers.js';

// ── Stable ids for every scenario ───────────────────────────────────────

/** A parent that is only ever referenced, never created (hard-deleted). */
export const HARD_MISSING_PARENT = {
  parentId: 'TEST-GONEPAR',
  children: ['TEST-GONEKID1', 'TEST-GONEKID2'],
} as const;

/** A parent soft-deleted (`status: 'deleted'`) with live children (R3b). */
export const SOFT_DELETED_PARENT = {
  parent: 'TEST-SOFTPAR',
  child: 'TEST-SOFTKID',
} as const;

/** A foreign-prefix (`WL-`) parent with an own-prefix (`TEST-`) child (R1). */
export const FOREIGN_PARENT_WITH_OWN_CHILD = {
  foreignParent: 'WL-101',
  ownChild: 'TEST-FKID',
  plainForeign: 'WL-102',
  plainOwn: 'TEST-OWN',
} as const;

/** Soft-deleted parent with live children, targeted by `wl doctor prune`. */
export const PRUNE_PARENT_WITH_CHILDREN = {
  parent: 'TEST-PRUNEPAR',
  children: ['TEST-PRUNECHILD1', 'TEST-PRUNECHILD2'],
} as const;

/** Parent deleted with `wl delete --no-recursive` (explicit orphaning, R2). */
export const NO_RECURSIVE_ORPHAN = {
  parent: 'TEST-NRPAR',
  children: ['TEST-NRKID1', 'TEST-NRKID2'],
} as const;

/** Live child under a live parent, promoted via `parentId -> null` (R2). */
export const PROMOTION = {
  parent: 'TEST-PROMOPAR',
  child: 'TEST-PROMOKID',
} as const;

/** Child whose `parentId` references the legacy `WL-NULL` artifact. */
export const DANGLING = {
  parentId: 'WL-NULL',
  child: 'TEST-DANGLING',
} as const;

// ── Seed helpers ─────────────────────────────────────────────────────────

/**
 * Seed a soft-deleted parent (`status: 'deleted'`) with two live children.
 * Each child's `parentId` resolves to the parent row — the R3b trap.
 */
export function seedSoftDeletedParentWithLiveChildren(dir: string): void {
  const { parent, child } = SOFT_DELETED_PARENT;
  seedWorkItems(dir, [
    { id: parent, title: 'Soft-deleted parent', status: 'deleted' },
    { id: child, title: 'Live child of soft-deleted parent', parentId: parent },
  ]);
}

/**
 * Seed children whose `parentId` references an id that is never created —
 * the hard-deleted-parent shape. The two children share one lost parent so
 * grouped reporting has something to group.
 */
export function seedHardMissingParentWithLiveChildren(dir: string): void {
  const { parentId, children } = HARD_MISSING_PARENT;
  seedWorkItems(
    dir,
    children.map((id, index) => ({
      id,
      title: `Live child ${index + 1} of hard-deleted parent`,
      parentId,
    })),
  );
}

/**
 * Seed a foreign-prefix parent (`WL-101`) with an own-prefix child, a second
 * plain foreign item with no dependents, and a plain own item. This is the
 * R1 shape for `wl doctor foreign-items --apply`.
 */
export function seedForeignParentWithOwnChild(dir: string): void {
  const { foreignParent, ownChild, plainForeign, plainOwn } = FOREIGN_PARENT_WITH_OWN_CHILD;
  seedWorkItems(dir, [
    { id: foreignParent, title: 'Foreign parent referenced by an own child' },
    { id: ownChild, title: 'Own child of foreign parent', parentId: foreignParent },
    { id: plainForeign, title: 'Plain foreign item' },
    { id: plainOwn, title: 'Plain own item' },
  ]);
}

/**
 * Seed a soft-deleted parent (old `updatedAt`) with two live children, for
 * `wl doctor prune`. The parent is a prune candidate by age and status; its
 * children keep it attached.
 */
export function seedPruneParentWithLiveChildren(
  dir: string,
  options: { parentUpdatedDaysAgo?: number } = {},
): void {
  const { parent, children } = PRUNE_PARENT_WITH_CHILDREN;
  seedWorkItems(dir, [
    { id: parent, title: 'Soft-deleted prune parent', status: 'deleted' },
    { id: children[0], title: 'Prune child 1', parentId: parent },
    { id: children[1], title: 'Prune child 2', parentId: parent },
  ]);
  makeDeletedOld(dir, [parent], options.parentUpdatedDaysAgo ?? 40);
}

/**
 * Seed a live parent with two live children for `wl delete --no-recursive`
 * explicit-orphaning tests.
 */
export function seedNoRecursiveOrphan(dir: string): void {
  const { parent, children } = NO_RECURSIVE_ORPHAN;
  seedWorkItems(dir, [
    { id: parent, title: 'Parent to orphan explicitly' },
    { id: children[0], title: 'No-recursive child 1', parentId: parent },
    { id: children[1], title: 'No-recursive child 2', parentId: parent },
  ]);
}

/** Seed a live parent + live child for promotion (`parentId -> null`) tests. */
export function seedPromotion(dir: string): void {
  const { parent, child } = PROMOTION;
  seedWorkItems(dir, [
    { id: parent, title: 'Live promotion parent' },
    { id: child, title: 'Live promotion child', parentId: parent },
  ]);
}

/** Seed a child whose `parentId` is the legacy `WL-NULL` artifact. */
export function seedDangling(dir: string): void {
  const { parentId, child } = DANGLING;
  seedWorkItems(dir, [{ id: child, title: 'Dangling child', parentId }]);
}

/**
 * Patch the seeded JSONL so the given (deleted-status) items carry an
 * `updatedAt` older than the prune cutoff. Must run before the first CLI
 * invocation in the test so the JSONL→SQLite import sees the old timestamps.
 */
export function makeDeletedOld(dir: string, ids: string[], days: number): void {
  const f = path.join(dir, '.worklog', 'worklog-data.jsonl');
  const old = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const lines = fs
    .readFileSync(f, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  for (const rec of lines) {
    if (rec.type !== 'workitem') continue;
    if (ids.includes(rec.data.id)) {
      rec.data.updatedAt = old;
    }
  }
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}
