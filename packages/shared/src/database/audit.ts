/**
 * packages/shared/src/database/audit.ts — audit-result storage, waiver
 * management and the audit-not-ready ordering tier for the `database.ts`
 * decomposition.
 *
 * Parent: WL-0MVGKGHNR0019OLT (decompose the `database.ts` god class).
 * Slice: WL-0MVOBP2Q2002ZYCF (extract sort and audit modules).
 *
 * ## Responsibility
 *
 * Everything a consumer needs to read/write audit results through the
 * `WorklogDatabase` façade: upsert/read/delete of the latest audit per work
 * item, durable audit-gap waivers, the invalidation reconcile verdict, batch
 * import/export, plus the two ordering helpers the sort module consumes
 * (`buildAuditMapForItems`, `isAuditNotReadyFresh`). Nothing here knows how a
 * candidate is ranked or selected.
 *
 * ## Boundary
 *
 * **Belongs here.** `saveAuditResult`, `reconcileAuditInvalidation`,
 * `getAuditResult`, `deleteAuditResult`, `setAuditWaiver`,
 * `clearAuditWaiver`, `getAllAuditResults`, `importAuditResults`, and the
 * audit-map building / not-ready freshness predicates. They touch only the
 * store through `WorklogDatabaseContext` (plus the `WriteHooks.triggerAutoSync`
 * collaborator for the two waiver writes and the bulk import).
 *
 * **Does NOT belong here.** Score computation, sort-index assignment and the
 * tiered comparators that *consume* audit freshness — those live in
 * `sort.ts` and import the two freshness predicates from here (mirroring the
 * never-landed `src/lib/audit-store.ts` boundary of WL-0MQJK4UJD0028IRO).
 * No knowledge of the `WorklogDatabase` façade; the graph stays acyclic.
 *
 * `WorklogDatabase` keeps a thin delegating member per function so the façade
 * surface is unchanged (parent AC — public API untouched).
 */

import { AuditResult, AuditWaiver, WorkItem } from '../types.js';
// Self-referencing package export (WL-0MSJ4BT4Z002HH9B grep guard forbids a
// relative `icons.js` import; `@worklog/shared/icons` is the canonical path
// even from within the shared package).
import { isAuditFresh, type AuditInvalidationVerdict } from '@worklog/shared/icons';
import {
  WorklogDatabaseContext,
  WriteHooks,
} from './context.js';

/**
 * Ordering-tier gate (WL-0MTH7G2O1004BHN5): only an audit that exists,
 * is not ready to close (`readyToClose === false`), and is fresh per the
 * shared `isAuditFresh` predicate qualifies for the audit-not-ready boost.
 * Stale audits (content edited more than the 60 s at-or-near tolerance
 * after the audit) are treated as no audit for ordering. The timestamp
 * comparison is delegated to the single source of
 * truth in `@worklog/shared/icons` (WL-0MUBVH7ZR009PP80) — no competing
 * `auditedAt`-vs-`updatedAt` comparison lives here. No fingerprints are
 * passed: the ordering path has no per-item current fingerprint, so the
 * shared helper applies its time-gate fallback. Critical items are never
 * boosted past by the audit tier (hard boundary, enforced by callers).
 */
export function isAuditNotReadyFresh(audit: AuditResult | null | undefined, itemUpdatedAt: string | undefined): boolean {
  if (!audit || audit.readyToClose) return false;
  return isAuditFresh(audit.auditedAt, itemUpdatedAt);
}

/**
 * Build a batch audit map for a set of work item ids (EdgeCache-style, one
 * batch query per scored set, no per-item N+1). Used by sortItemsByScore
 * and the selectBySortIndex fallback.
 */
export function buildAuditMapForItems(ctx: WorklogDatabaseContext, items: WorkItem[]): Map<string, AuditResult> {
  const all = ctx.store.getAllAuditResults();
  const map = new Map<string, AuditResult>();
  for (const a of all) map.set(a.workItemId, a);
  return map;
}

/**
 * Save or update an audit result for a work item (upsert).
 * Only the latest audit per work item is kept.
 */
export function saveAuditResult(ctx: WorklogDatabaseContext, audit: { workItemId: string; readyToClose: boolean; auditedAt: string; summary: string | null; rawOutput: string | null; author: string | null; fingerprint?: string | null }): void {
  ctx.store.saveAuditResult(audit);
}

/**
 * Decide whether a stored audit is fresh, should be re-instated, or must be
 * re-run — and automatically re-instate it when the only change since the
 * audit was non-semantic (WL-0MU1EWMHN000YUCG).
 *
 * Delegates to {@link SqlitePersistentStore.reconcileAuditInvalidation}, so
 * the automatic `updatedAt = auditedAt` reset and the decision live in the
 * store. Callers that can compute the item's current content fingerprint
 * pass it in; callers without git access omit it and get a fail-safe
 * `re-audit` verdict for any timestamp-stale audit.
 *
 * @param workItemId The work item whose audit is being reconciled.
 * @param currentFingerprint The item's current content fingerprint, when known.
 * @returns The invalidation verdict (`fresh` | `reinstate` | `re-audit`).
 */
export function reconcileAuditInvalidation(
  ctx: WorklogDatabaseContext,
  workItemId: string,
  currentFingerprint?: string | null,
): AuditInvalidationVerdict {
  return ctx.store.reconcileAuditInvalidation(workItemId, currentFingerprint);
}

/**
 * Get the audit result for a work item.
 * Returns null if no audit result exists.
 */
export function getAuditResult(ctx: WorklogDatabaseContext, workItemId: string): { workItemId: string; readyToClose: boolean; auditedAt: string; summary: string | null; rawOutput: string | null; author: string | null; fingerprint: string | null } | null {
  return ctx.store.getAuditResult(workItemId);
}

/**
 * Delete the audit result for a work item.
 */
export function deleteAuditResult(ctx: WorklogDatabaseContext, workItemId: string): boolean {
  return ctx.store.deleteAuditResult(workItemId);
}

/**
 * Record an explicit, durable audit-gap waiver on a work item
 * (WL-0MUBVH9FV0027COG).
 *
 * The waiver is persisted in the nullable `workitems.auditWaiver` JSON
 * column, surfaced by `wl show --json`, and round-trips through JSONL sync.
 * `updatedAt` is bumped so delta sync exports the change; a waiver is an
 * audit-relevant state change, so a previously fresh audit becomes stale —
 * the waiver still wins in {@link classifyAuditGap}, so the item is not
 * flagged.
 *
 * @returns the updated item, or `null` when the id does not exist.
 */
export function setAuditWaiver(ctx: WorklogDatabaseContext, hooks: WriteHooks, id: string, waiver: AuditWaiver): WorkItem | null {
  const item = ctx.store.getWorkItem(id);
  if (!item) return null;
  const now = new Date().toISOString();
  const updated: WorkItem = {
    ...item,
    auditWaiver: {
      reason: waiver.reason,
      author: waiver.author ?? '',
      waivedAt: waiver.waivedAt || now,
    },
    updatedAt: now,
  };
  ctx.store.saveWorkItem(updated);
  ctx.store.upsertFtsEntry(updated);
  hooks.triggerAutoSync();
  return updated;
}

/**
 * Remove an explicit audit-gap waiver from a work item. Idempotent: an
 * item that is not waived is returned unchanged (no write).
 *
 * @returns the updated item, or `null` when the id does not exist.
 */
export function clearAuditWaiver(ctx: WorklogDatabaseContext, hooks: WriteHooks, id: string): WorkItem | null {
  const item = ctx.store.getWorkItem(id);
  if (!item) return null;
  if (!item.auditWaiver) return item;
  const now = new Date().toISOString();
  const updated: WorkItem = { ...item, auditWaiver: null, updatedAt: now };
  ctx.store.saveWorkItem(updated);
  ctx.store.upsertFtsEntry(updated);
  hooks.triggerAutoSync();
  return updated;
}

/**
 * Get all audit results (for JSONL export / sync).
 */
export function getAllAuditResults(ctx: WorklogDatabaseContext): AuditResult[] {
  return ctx.store.getAllAuditResults();
}

/**
 * Import audit results (upsert, bulk).
 */
export function importAuditResults(ctx: WorklogDatabaseContext, hooks: WriteHooks, audits: AuditResult[]): void {
  ctx.store.saveAuditResults(audits);
  hooks.triggerAutoSync();
}
