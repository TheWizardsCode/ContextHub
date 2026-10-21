/**
 * Shared `wl list --json` item enrichment (WL-0MVI0IT4S0070G78).
 *
 * `wl list --json` enriches every item with the audit verdict and the
 * canonical content fingerprints, plus the child count:
 *
 *   `auditResult`, `auditedAt`, `fingerprint`, `currentFingerprint`, `childCount`
 *
 * Consumers depend on that shape: the Herdr default worklist's audit-bucket
 * sort (WL-0MUWDW0N6003KF6G) prefers the richer `wl list` representation for
 * items that also appear in a mandatory subset, and `isAuditFresh`
 * (WL-0MUN7QWFP0010EQC) uses `currentFingerprint` as the primary freshness
 * gate instead of the 60 s time gate.
 *
 * The consolidated `wl worklist` bundle (WL-0MVI0HX58009JJRF) replaces those
 * `wl list` spawns, so its list subsets must carry the *same* enrichment —
 * otherwise the bundle path silently degrades the audit-bucket classification
 * of every in_review item. Rather than fork the logic, both commands share the
 * enricher below.
 *
 * Cost note: `currentFingerprint` is computed with a few read-only `git` calls
 * and ONLY for items that already carry a stored audit fingerprint (the
 * predicate needs both sides). Items without an audit pay nothing, and the
 * per-item result is memoised for the lifetime of one command invocation.
 */

import type { WorkItem } from './types.js';
import { getGitRepoRoot } from '@worklog/shared/worklog-paths';
import { computeContentFingerprint, createGitRunner, type GitRunner } from './audit-fingerprint.js';

/** Audit/fingerprint fields `wl list --json` adds to every item. */
export interface ListItemAuditFields {
  /** Audit verdict: `true` ready to close, `false` rejected, `null` never audited. */
  auditResult: boolean | null;
  /** When the stored audit result was recorded (ISO), `null` when never audited. */
  auditedAt: string | null;
  /** Stored content fingerprint from the audit result (WL-0MUBVH5S0008NQ9K). */
  fingerprint: string | null;
  /** Current content fingerprint, computed only when a stored one exists. */
  currentFingerprint: string | null;
}

/** A work item enriched exactly as `wl list --json` emits it. */
export type EnrichedListItem = WorkItem & ListItemAuditFields & { childCount: number };

/** Minimal database surface the enricher needs (structural: easy to fake). */
export interface ListEnrichmentDb {
  getAllAuditResults(): {
    workItemId: string;
    readyToClose: boolean;
    auditedAt?: string | null;
    fingerprint?: string | null;
  }[];
  getChildCounts(): Map<string, number>;
}

/** Options for {@link createListEnricher}. */
export interface ListEnricherOptions {
  /** Git working directory for fingerprint computation (default: repo root / cwd). */
  gitRepoRoot?: string;
}

/** The shared enricher: audit fields per item plus the child-count map. */
export interface ListEnricher {
  /** Audit/fingerprint fields for one item (memoised per item id). */
  auditFields(item: WorkItem): ListItemAuditFields;
  /** Enrich a list of items exactly as `wl list --json` does. */
  enrich(items: WorkItem[]): EnrichedListItem[];
}

/**
 * Build an enricher over one database handle.
 *
 * All audit results are read once (`getAllAuditResults`) and the child counts
 * once (lazily, on the first {@link ListEnricher.enrich} call), so enriching
 * four list subsets costs the same queries as enriching one.
 */
export function createListEnricher(
  db: ListEnrichmentDb,
  options: ListEnricherOptions = {},
): ListEnricher {
  const auditMap = new Map<
    string,
    { readyToClose: boolean; auditedAt: string | null; fingerprint: string | null }
  >();
  for (const ar of db.getAllAuditResults()) {
    auditMap.set(ar.workItemId, {
      readyToClose: ar.readyToClose,
      auditedAt: ar.auditedAt ?? null,
      fingerprint: ar.fingerprint ?? null,
    });
  }

  const gitRepoRoot = options.gitRepoRoot ?? getGitRepoRoot() ?? process.cwd();
  let runGit: GitRunner | null = null;
  const fingerprintCache = new Map<string, string | null>();

  const currentFingerprintFor = (item: WorkItem, storedFingerprint: string | null): string | null => {
    if (!storedFingerprint) return null;
    if (fingerprintCache.has(item.id)) {
      return fingerprintCache.get(item.id) ?? null;
    }
    if (runGit === null) runGit = createGitRunner(gitRepoRoot);
    const computed = computeContentFingerprint({
      id: item.id,
      description: item.description ?? '',
      runGit,
    });
    fingerprintCache.set(item.id, computed);
    return computed;
  };

  const auditFields = (item: WorkItem): ListItemAuditFields => {
    const audit = auditMap.get(item.id);
    return {
      auditResult: audit ? audit.readyToClose : null,
      auditedAt: audit ? audit.auditedAt : null,
      fingerprint: audit ? audit.fingerprint : null,
      currentFingerprint: currentFingerprintFor(item, audit?.fingerprint ?? null),
    };
  };

  let childCounts: Map<string, number> | null = null;

  return {
    auditFields,
    enrich(items: WorkItem[]): EnrichedListItem[] {
      if (childCounts === null) childCounts = db.getChildCounts();
      const counts = childCounts;
      return items.map((item) => ({
        ...item,
        ...auditFields(item),
        childCount: counts.get(item.id) ?? 0,
      }));
    },
  };
}
