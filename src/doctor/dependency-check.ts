import type { DependencyEdge, WorkItem } from '../types.js';
import type { DoctorFinding, DoctorSeverity } from './status-stage-check.js';

const CHECK_ID_MISSING_DEP_ENDPOINT = 'dependency.missing-endpoint';
const TYPE_MISSING_DEP_ENDPOINT = 'missing-dependency-endpoint';
const SEVERITY_MISSING_DEP_ENDPOINT: DoctorSeverity = 'error';

type DependencyCheckContext = {
  fromId: string;
  toId: string;
  missingFrom: boolean;
  missingTo: boolean;
  createdAt?: string;
};

export function validateDependencyEdges(
  items: WorkItem[],
  edges: DependencyEdge[],
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const itemIds = new Set(items.map(item => item.id));

  for (const edge of edges) {
    const missingFrom = !itemIds.has(edge.fromId);
    const missingTo = !itemIds.has(edge.toId);
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
