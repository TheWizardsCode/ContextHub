/**
 * Audit-gap classification and report for `wl doctor audit-gaps`
 * (WL-0MUBVH9FV0027COG).
 *
 * Lists every `completed`/`in_review` item that has **no audit record**, with
 * its root/child relationship, age, and coverage/waiver status. Freshness and
 * derived child coverage are delegated entirely to the shared
 * `classifyAuditGap` helper (which itself reuses `isAuditFresh` /
 * `isCoveredByParent` from `@worklog/shared/icons`) — no competing
 * `auditedAt`-vs-`updatedAt` comparison lives here.
 *
 * Read-only: this module never mutates the database.
 */

import type { WorkItem, AuditResult, AuditWaiver } from '../types.js';
import { classifyAuditGap, type ParentAuditState } from '@worklog/shared/icons';

/** One no-audit item in the audit-gap report. */
export interface AuditGapReportItem {
  id: string;
  title: string;
  status: string;
  stage: string;
  /** `root` when `parentId` is null, otherwise `child`. */
  relationship: 'root' | 'child';
  parentId: string | null;
  updatedAt: string;
  activityAt: string;
  /** Age in milliseconds (from `activityAt`, falling back to `updatedAt`). */
  ageMs: number;
  /** Age in whole days (floored), for quick operator triage. */
  ageDays: number;
  /** Shared classification: `uncovered` | `covered` | `waived`. */
  classification: 'uncovered' | 'covered' | 'waived';
  /** The direct parent id when covered (depth-1 coverage). */
  coveredByParentId: string | null;
  /** The recorded waiver, when `classification === 'waived'`. */
  waiver: AuditWaiver | null;
}

/** The full read-only audit-gap report. */
export interface AuditGapReport {
  success: boolean;
  generatedAt: string;
  /** Total items scanned. */
  totalScanned: number;
  /** Items with no audit record that are `completed`/`in_review`. */
  noAuditCount: number;
  /** Genuinely uncovered items (the flagged set). */
  flaggedCount: number;
  coveredCount: number;
  waivedCount: number;
  /** Every no-audit item, with its coverage/waiver classification. */
  items: AuditGapReportItem[];
  /** The subset that is `uncovered` (the warning set). */
  flagged: AuditGapReportItem[];
}

/**
 * An item is in scope for the audit-gap report when it is `completed`
 * (status) or `in_review` (stage) — the two lifecycle states that ship.
 */
export function isAuditGapScope(item: WorkItem): boolean {
  return item.status === 'completed' || item.stage === 'in_review';
}

/**
 * Build a read-only audit-gap report.
 *
 * @param items - All work items in the database (used for parents too).
 * @param auditResults - All audit results (latest-only per item).
 * @param opts.now - Injectable clock (ISO string or ms) for deterministic age.
 */
export function buildAuditGapReport(
  items: WorkItem[],
  auditResults: AuditResult[],
  opts: { now?: string | number | Date } = {},
): AuditGapReport {
  const generatedAt = new Date(opts.now ?? Date.now()).toISOString();
  const nowMs = new Date(generatedAt).getTime();

  const itemsById = new Map<string, WorkItem>();
  for (const item of items) itemsById.set(item.id, item);

  const auditById = new Map<string, AuditResult>();
  for (const audit of auditResults) auditById.set(audit.workItemId, audit);

  const reportItems: AuditGapReportItem[] = [];

  for (const item of items) {
    if (item.status === 'deleted') continue;
    if (!isAuditGapScope(item)) continue;
    // Report scope (AC4): items with NO audit record. Stale-but-present
    // audits are handled by the closure guard and the icon surfaces.
    if (auditById.has(item.id)) continue;

    const parent = item.parentId ? itemsById.get(item.parentId) : undefined;
    const parentAudit: ParentAuditState | null = parent
      ? {
          auditResult: parentAuditResult(parent, auditById),
          auditedAt: auditById.get(parent.id)?.auditedAt ?? null,
          updatedAt: parent.updatedAt,
          fingerprint: auditById.get(parent.id)?.fingerprint ?? null,
        }
      : null;

    const classification = classifyAuditGap({
      ownAudit: null,
      updatedAt: item.updatedAt,
      parentId: item.parentId,
      auditWaiver: item.auditWaiver ?? null,
      parentAudit,
    });

    // classifyAuditGap returns 'none' only when the item's own audit is fresh;
    // by construction this item has no audit record, so 'none' cannot occur.
    // Normalise defensively to 'uncovered'.
    const resolved = classification === 'none' ? 'uncovered' : classification;

    const activityAt = item.activityAt || item.updatedAt;
    const ageMs = Math.max(0, nowMs - new Date(activityAt).getTime());

    reportItems.push({
      id: item.id,
      title: item.title,
      status: item.status,
      stage: item.stage,
      relationship: item.parentId ? 'child' : 'root',
      parentId: item.parentId ?? null,
      updatedAt: item.updatedAt,
      activityAt,
      ageMs,
      ageDays: Math.floor(ageMs / 86_400_000),
      classification: resolved,
      coveredByParentId: resolved === 'covered' ? item.parentId ?? null : null,
      waiver: resolved === 'waived' ? item.auditWaiver ?? null : null,
    });
  }

  // Stable, oldest-first ordering so the longest-standing gaps appear first.
  reportItems.sort((a, b) => (b.ageMs - a.ageMs) || a.id.localeCompare(b.id));

  const flagged = reportItems.filter(i => i.classification === 'uncovered');

  return {
    success: true,
    generatedAt,
    totalScanned: items.length,
    noAuditCount: reportItems.length,
    flaggedCount: flagged.length,
    coveredCount: reportItems.filter(i => i.classification === 'covered').length,
    waivedCount: reportItems.filter(i => i.classification === 'waived').length,
    items: reportItems,
    flagged,
  };
}

/** Map an audit result's `readyToClose` for the parent coverage predicate. */
function parentAuditResult(parent: WorkItem, auditById: Map<string, AuditResult>): boolean | null {
  const audit = auditById.get(parent.id);
  return audit ? audit.readyToClose : null;
}
