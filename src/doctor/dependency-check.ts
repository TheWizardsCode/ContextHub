import type { DependencyEdge, WorkItem } from '../types.js';
import type { DoctorFinding, DoctorSeverity } from './status-stage-check.js';

const CHECK_ID_MISSING_DEP_ENDPOINT = 'dependency.missing-endpoint';
const TYPE_MISSING_DEP_ENDPOINT = 'missing-dependency-endpoint';
const SEVERITY_MISSING_DEP_ENDPOINT: DoctorSeverity = 'error';

const CHECK_ID_FOREIGN_UNRESOLVED = 'dependency.foreign-unresolved';
const TYPE_FOREIGN_UNRESOLVED = 'unresolved-foreign-dependency';
const SEVERITY_FOREIGN_UNRESOLVED: DoctorSeverity = 'warning';

type DependencyCheckContext = {
  fromId: string;
  toId: string;
  missingFrom: boolean;
  missingTo: boolean;
  createdAt?: string;
};

/**
 * The subset of a foreign resolution this check needs.
 *
 * Structural on purpose: the CLI passes `resolveForeignItem()`'s
 * `ForeignItemResolution` without this module importing the cross-repo
 * resolver (the check stays a pure function over items + edges).
 */
export interface ForeignResolutionLike {
  state: 'resolved' | 'unresolved' | 'unavailable';
  /**
   * `true` when a project owns the target's prefix (even if its store is
   * unreadable or the prefix is ambiguous). An `unavailable` target with no
   * discovered project is a coordination note, not a finding.
   */
  discoveredProject: boolean;
  reason?: string;
}

/** Options accepted by {@link validateDependencyEdges}. */
export interface DependencyCheckOptions {
  /**
   * Resolve a non-local edge target against the discovered sibling projects.
   *
   * Returns `null` when `toId` is not a foreign id (e.g. it carries this
   * store's own prefix) — the caller owns that classification because it knows
   * the local prefix. When omitted, the historical local-only check runs
   * unchanged.
   */
  resolveForeign?: (id: string) => ForeignResolutionLike | null;
}

/**
 * Validate dependency edges for missing endpoints and unresolved foreign
 * targets.
 *
 * A foreign (cross-project) target is never reported as a local
 * `dependency.missing-endpoint`: it cannot have a local row by design. An
 * unresolved one — the owning store was read but holds no such item, or a
 * discovered store/ambiguous prefix could not be used — is surfaced as a
 * `dependency.foreign-unresolved` warning keyed to the **dependent**, so
 * `wl doctor` distinguishes the two cases instead of raising a false error
 * (parent WL-0MVWABT2Z001XMSD AC3).
 */
export function validateDependencyEdges(
  items: WorkItem[],
  edges: DependencyEdge[],
  options: DependencyCheckOptions = {},
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const itemIds = new Set(items.map(item => item.id));

  for (const edge of edges) {
    const missingFrom = !itemIds.has(edge.fromId);
    let missingTo = !itemIds.has(edge.toId);
    let foreignUnresolved: ForeignResolutionLike | null = null;

    if (missingTo && options.resolveForeign) {
      const foreign = options.resolveForeign(edge.toId);
      if (foreign) {
        // A foreign target is not a local missing endpoint by definition.
        missingTo = false;
        const unresolved =
          foreign.state === 'unresolved' ||
          (foreign.state === 'unavailable' && foreign.discoveredProject);
        if (unresolved) {
          foreignUnresolved = foreign;
        }
      }
    }

    if (foreignUnresolved) {
      const reason =
        foreignUnresolved.reason ??
        `Foreign dependency ${edge.toId} could not be resolved (${foreignUnresolved.state}).`;
      findings.push({
        checkId: CHECK_ID_FOREIGN_UNRESOLVED,
        type: TYPE_FOREIGN_UNRESOLVED,
        severity: SEVERITY_FOREIGN_UNRESOLVED,
        itemId: edge.fromId,
        message: `Dependency edge references an unresolved foreign work item: ${edge.toId}. ${reason}`,
        proposedFix: null,
        safe: false,
        context: {
          blockerId: edge.toId,
          foreign: true,
          foreign_dependency: foreignUnresolved.state,
          unresolved: true,
          reason,
        },
      });
    }

    if (!missingFrom && !missingTo) {
      continue;
    }

    const missingParts: string[] = [];
    if (missingFrom) missingParts.push(`fromId ${edge.fromId}`);
    if (missingTo) missingParts.push(`toId ${edge.toId}`);

    const context: DependencyCheckContext = {
      fromId: edge.fromId,
      toId: edge.toId,
      missingFrom,
      missingTo,
    };
    if (edge.createdAt) {
      context.createdAt = edge.createdAt;
    }

    findings.push({
      checkId: CHECK_ID_MISSING_DEP_ENDPOINT,
      type: TYPE_MISSING_DEP_ENDPOINT,
      severity: SEVERITY_MISSING_DEP_ENDPOINT,
      itemId: missingFrom ? edge.fromId : edge.toId,
      message: `Dependency edge references missing work item: ${missingParts.join(', ')}.`,
      proposedFix: null,
      safe: false,
      context,
    });
  }

  return findings;
}
