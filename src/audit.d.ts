export type AuditFirstLineInspection = {
    firstNonEmptyLine: string;
    trimmedFirstNonEmptyLine: string;
    hasBom: boolean;
    hasNonPrintable: boolean;
    hasGutterChars: boolean;
    isValid: boolean;
};
export declare function resolveAuditAuthor(): string;
/**
 * Redact email-like strings in free-form audit text.
 *
 * Rules (WL-0MMNCOIYS15A1YSI):
 * - Match common email patterns where domain contains a dot (avoid localhost)
 * - Replace local part with first-character + exactly three asterisks and keep domain
 * - Deterministic and irreversible
 */
export declare function redactAuditText(auditText: string): string;
export type BuildAuditOptions = {
    /** If provided, signals whether the associated work item description includes acceptance/success criteria. */
    hasAcceptanceCriteria?: boolean;
};
export declare function hasAcceptanceCriteria(description?: string): boolean;
export declare function buildAuditEntry(auditText: string, author?: string, opts?: BuildAuditOptions): {
    time: string;
    author: string;
    text: string;
    status: 'Complete' | 'Partial' | 'Missing Criteria';
};
export declare function inspectAuditFirstLine(auditText: string): AuditFirstLineInspection;
export declare function formatInvalidAuditFirstLineMessage(inspection: AuditFirstLineInspection): string;
/**
 * Parse the first line of an audit text to derive readiness status.
 *
 * Rules:
 * - Inspect only the first non-empty line.
 * - Trim whitespace around that line.
 * - Accept only exact matches:
 *   - `Ready to close: Yes` -> `Complete`
 *   - `Ready to close: No` -> `Partial`
 * - Otherwise return `Missing Criteria`.
 */
export declare function parseReadinessLine(auditText: string): 'Complete' | 'Partial' | 'Missing Criteria';
//# sourceMappingURL=audit.d.ts.map