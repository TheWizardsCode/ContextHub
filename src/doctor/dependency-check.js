const CHECK_ID_MISSING_DEP_ENDPOINT = 'dependency.missing-endpoint';
const TYPE_MISSING_DEP_ENDPOINT = 'missing-dependency-endpoint';
const SEVERITY_MISSING_DEP_ENDPOINT = 'error';
export function validateDependencyEdges(items, edges) {
    const findings = [];
    const itemIds = new Set(items.map(item => item.id));
    for (const edge of edges) {
        const missingFrom = !itemIds.has(edge.fromId);
        const missingTo = !itemIds.has(edge.toId);
        if (!missingFrom && !missingTo) {
            continue;
        }
        const missingParts = [];
        if (missingFrom)
            missingParts.push(`fromId ${edge.fromId}`);
        if (missingTo)
            missingParts.push(`toId ${edge.toId}`);
        const context = {
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
//# sourceMappingURL=dependency-check.js.map