/**
 * Serialise mutating CLI commands on the same per-store advisory file lock
 * that `wl sync` holds for its entire fetch → merge → write → push operation.
 *
 * Background (WL-0MUV2U9QF002S9J1 / CG-0MUUFGXFX004O2X7): `wl sync` reads a
 * snapshot of the store, merges it in memory, then writes the merged set back.
 * A mutating command (`wl update`, `wl comment add`, `wl audit-set`) that
 * landed inside that read→write window was previously not serialised against
 * the sync, so the sync's stale snapshot overwrote it — losing the status
 * transition and any comment added in the window. Lost comments (which the
 * merge layer otherwise only ever adds) were the tell-tale second symptom.
 *
 * Wrapping the mutation's read-modify-write in the same `withFileLock` that
 * `sync` uses means a mutation and a sync can never interleave: the mutation
 * either completes before the sync takes its snapshot or waits until the sync
 * has released the lock. This is the fix chosen by the producer in preference
 * to an optimistic `updatedAt` re-check (which would touch every write path).
 *
 * Reentrancy: `withFileLock` is reentrant per process, so a mutation that
 * internally triggers a sync (e.g. an auto-sync path) does not deadlock.
 */

import { withFileLock, getLockPathForJsonl } from './file-lock.js';

/**
 * Run `fn` while holding the store's mutation lock.
 *
 * @param dataPath - The store's JSONL data-file path (`ctx.dataPath`); the
 *   lock path is derived with the same `getLockPathForJsonl` used by `sync`,
 *   so every participant contends on one lock.
 * @param fn - The read-modify-write callback (sync or async). The lock is
 *   released when it settles, including on error.
 * @returns Whatever `fn` returns (a promise when `fn` is async).
 */
export function withStoreMutationLock<T>(dataPath: string, fn: () => T): T {
  return withFileLock(getLockPathForJsonl(dataPath), fn);
}
