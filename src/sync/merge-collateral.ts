/**
 * src/sync/merge-collateral.ts — collapse of non-item records during a sync.
 *
 * Concern: merging a project's non-item records alongside work items —
 * comments (immutable after creation; deduplicated by id), audit results
 * (last-write-wins by `auditedAt`, local wins exact ties, so a sync never
 * downgrades a newer audit — WL-0MSKZ36MT0089UOS / SA-0MUJNFF3K009BF03) and
 * dependency edges (deduplicated by from::to pair).
 *
 * Moved verbatim from `src/sync.ts` (WL-0MVP9QLWU003NV41, child 3 of 6 of the
 * WL-0MVGKGMU400631VZ `src/sync.ts` decomposition). Move-only: no logic
 * edited, no signature changed, no symbol renamed.
 */

import type { Comment, DependencyEdge, AuditResult } from '../types.js';

/**
 * Merge two sets of comments
 * Comments are immutable after creation (except explicit updates), so we use createdAt + id for deduplication
 */
export function mergeComments(
  localComments: Comment[],
  remoteComments: Comment[]
): { merged: Comment[], conflicts: string[] } {
  const mergedMap = new Map<string, Comment>();
  
  // Add all local comments to the map
  localComments.forEach(comment => {
    mergedMap.set(comment.id, comment);
  });
  
  // Add remote comments (deduplicate by id)
  remoteComments.forEach(remoteComment => {
    if (!mergedMap.has(remoteComment.id)) {
      mergedMap.set(remoteComment.id, remoteComment);
    }
  });
  
  return {
    merged: Array.from(mergedMap.values()),
    conflicts: [] // Comments don't have conflicts in this simple model
  };
}

/**
 * Merge audit results by unique work item id.
 *
 * Last-write-wins by `auditedAt`: the newest audit wins, whichever side it
 * came from, and exact ties break in favour of the local copy. This makes the
 * merge monotonic in audit time, so a sync can never downgrade a newer audit
 * to an older one — a stale local copy (restored snapshot, old process) cannot
 * shadow a newer remote audit, and a stale remote export cannot clobber a
 * newer local audit (SA-0MUJNFF3K009BF03).
 *
 * Audits whose `auditedAt` is missing or unparseable fall back to the previous
 * local-precedence behaviour, since freshness cannot be compared.
 */
export function mergeAuditResults(
  localAudits: AuditResult[],
  remoteAudits: AuditResult[]
): { merged: AuditResult[] } {
  const mergedMap = new Map<string, AuditResult>();

  const timestampOf = (audit: AuditResult): number | null => {
    if (!audit || typeof audit.auditedAt !== 'string') return null;
    const ms = Date.parse(audit.auditedAt);
    return Number.isFinite(ms) ? ms : null;
  };

  const isStrictlyNewer = (candidate: AuditResult, current: AuditResult): boolean => {
    const candidateMs = timestampOf(candidate);
    const currentMs = timestampOf(current);
    if (candidateMs === null || currentMs === null) return false;
    return candidateMs > currentMs;
  };

  // Start with the local audits — local wins exact ties.
  localAudits.forEach(audit => {
    mergedMap.set(audit.workItemId, audit);
  });

  // Fold in remote audits: keep the newest audit per work item.
  remoteAudits.forEach(remoteAudit => {
    const existing = mergedMap.get(remoteAudit.workItemId);
    if (!existing || isStrictlyNewer(remoteAudit, existing)) {
      mergedMap.set(remoteAudit.workItemId, remoteAudit);
    }
  });

  return {
    merged: Array.from(mergedMap.values()),
  };
}

/**
 * Merge dependency edges by unique from/to pairs.
 */
export function mergeDependencyEdges(
  localEdges: DependencyEdge[],
  remoteEdges: DependencyEdge[]
): { merged: DependencyEdge[] } {
  const merged = new Map<string, DependencyEdge>();
  for (const edge of localEdges) {
    merged.set(`${edge.fromId}::${edge.toId}`, edge);
  }
  for (const edge of remoteEdges) {
    const key = `${edge.fromId}::${edge.toId}`;
    if (!merged.has(key)) {
      merged.set(key, edge);
    }
  }
  return { merged: Array.from(merged.values()) };
}
