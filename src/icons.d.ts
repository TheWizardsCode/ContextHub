/**
 * Icon utilities for work item priority, status, risk, effort, and more.
 *
 * Provides consistent icon rendering (emoji or text fallback) across
 * the TUI and CLI output paths, with accessible labels for screen
 * readers.
 *
 * Design spec: docs/icons-design.md
 */
/**
 * Options for icon rendering.
 */
export interface IconOptions {
    /** When true, use text fallback instead of emoji/icon glyph. */
    noIcons?: boolean;
}
/**
 * Check whether icons should be rendered.
 *
 * Icons are enabled by default when running in a TTY. They can be
 * disabled via the `WL_NO_ICONS` environment variable or the
 * `noIcons` option.
 */
export declare function iconsEnabled(opts?: {
    noIcons?: boolean;
}): boolean;
/**
 * Get the icon string (emoji or text fallback) for a work item priority.
 *
 * @param priority - The priority value (e.g. 'critical', 'high', 'medium', 'low').
 * @param opts - Options controlling fallback behaviour.
 * @returns The icon string (emoji or bracketed text).
 */
export declare function priorityIcon(priority: string, opts?: IconOptions): string;
/**
 * Get the icon string (emoji or text fallback) for a work item status.
 *
 * @param status - The status value (e.g. 'open', 'in-progress', 'completed').
 * @param opts - Options controlling fallback behaviour.
 * @returns The icon string (emoji or bracketed text).
 */
export declare function statusIcon(status: string, opts?: IconOptions): string;
/**
 * Get the accessible label for a priority icon.
 *
 * @param priority - The priority value.
 * @returns A human-readable label describing the priority (e.g. "High priority").
 */
export declare function priorityLabel(priority: string): string;
/**
 * Get the accessible label for a status icon.
 *
 * @param status - The status value.
 * @returns A human-readable label describing the status (e.g. "Status: Open").
 */
export declare function statusLabel(status: string): string;
/**
 * Get the text fallback for a priority icon.
 *
 * @param priority - The priority value.
 * @returns The bracketed text label (e.g. "[CRIT]").
 */
export declare function priorityFallback(priority: string): string;
/**
 * Get the text fallback for a status icon.
 *
 * @param status - The status value.
 * @returns The bracketed text label (e.g. "[OPEN]").
 */
export declare function statusFallback(status: string): string;
/**
 * Get the icon string (emoji or text fallback) for a work item risk level.
 *
 * @param risk - The risk value (e.g. 'Low', 'Medium', 'High', 'Severe').
 * @param opts - Options controlling fallback behaviour.
 * @returns The icon string (emoji or bracketed text).
 */
export declare function riskIcon(risk: string | undefined | null, opts?: IconOptions): string;
/**
 * Get the accessible label for a risk icon.
 *
 * @param risk - The risk value.
 * @returns A human-readable label describing the risk (e.g. "Risk: Medium").
 */
export declare function riskLabel(risk: string | undefined | null): string;
/**
 * Get the text fallback for a risk icon.
 *
 * @param risk - The risk value.
 * @returns The bracketed text label (e.g. "[MED]").
 */
export declare function riskFallback(risk: string | undefined | null): string;
/**
 * Get the icon string (emoji or text fallback) for a work item effort T-shirt size.
 *
 * @param effort - The effort value (e.g. 'XS', 'S', 'M', 'L', 'XL').
 * @param opts - Options controlling fallback behaviour.
 * @returns The icon string (emoji or bracketed text).
 */
export declare function effortIcon(effort: string | undefined | null, opts?: IconOptions): string;
/**
 * Get the accessible label for an effort icon.
 *
 * @param effort - The effort value.
 * @returns A human-readable label describing the effort (e.g. "Effort: M (medium)").
 */
export declare function effortLabel(effort: string | undefined | null): string;
/**
 * Get the text fallback for an effort icon.
 *
 * @param effort - The effort value.
 * @returns The bracketed text label (e.g. "[M]").
 */
export declare function effortFallback(effort: string | undefined | null): string;
/**
 * Get the icon string (emoji or text fallback) for a work item stage.
 *
 * @param stage - The stage value (e.g. 'idea', 'in_progress', 'done').
 * @param opts - Options controlling fallback behaviour.
 * @returns The icon string (emoji or bracketed text).
 */
export declare function stageIcon(stage: string | undefined | null, opts?: IconOptions): string;
/**
 * Get the accessible label for a stage icon.
 *
 * @param stage - The stage value.
 * @returns A human-readable label describing the stage (e.g. "Stage: In Progress").
 */
export declare function stageLabel(stage: string | undefined | null): string;
/**
 * Get the text fallback for a stage icon.
 *
 * @param stage - The stage value.
 * @returns The bracketed text label (e.g. "[PROG]").
 */
export declare function stageFallback(stage: string | undefined | null): string;
/**
 * Get the icon string (emoji or text fallback) for an audit result.
 *
 * @param result - The audit result: true (yes/passed), false (no/failed), null/undefined (unknown).
 * @param opts - Options controlling fallback behaviour.
 * @returns The icon string (emoji or bracketed text).
 */
export declare function auditIcon(result: boolean | null | undefined, opts?: IconOptions): string;
/**
 * Get the accessible label for an audit result icon.
 *
 * @param result - The audit result value.
 * @returns A human-readable label (e.g. "Audit: Passed").
 */
export declare function auditLabel(result: boolean | null | undefined): string;
/**
 * Get the text fallback for an audit result icon.
 *
 * @param result - The audit result value.
 * @returns The bracketed text label (e.g. "[YES]").
 */
export declare function auditFallback(result: boolean | null | undefined): string;
/**
 * Get the icon string for a stale audit result.
 *
 * For stale-but-passed audits (result === true), returns the stale-passed
 * icon (\u{1F7E9}). For all other results, falls back to the regular
 * audit icon for backward compatibility.
 *
 * @param result - The audit result.
 * @param opts - Options controlling fallback behaviour.
 * @returns The icon string (emoji or bracketed text).
 */
export declare function auditStaleIcon(result: boolean | null | undefined, opts?: IconOptions): string;
/**
 * Get the accessible label for a stale audit result icon.
 *
 * @param result - The audit result value.
 * @returns A human-readable label (e.g. "Audit: Passed (stale)").
 */
export declare function auditStaleLabel(result: boolean | null | undefined): string;
/**
 * Get the text fallback for a stale audit result icon.
 *
 * @param result - The audit result value.
 * @returns The bracketed text label (e.g. "[YES_STALE]").
 */
export declare function auditStaleFallback(result: boolean | null | undefined): string;
/**
 * Get the icon string (emoji or text fallback) for the needsProducerReview flag.
 *
 * @param needsProducerReview - Whether the work item needs producer review.
 * @param opts - Options controlling fallback behaviour.
 * @returns The icon string (emoji or bracketed text).
 */
export declare function needsProducerReviewIcon(needsProducerReview: boolean | null | undefined, opts?: IconOptions): string;
/**
 * Get the accessible label for a producer review icon.
 *
 * @param needsProducerReview - Whether the work item needs producer review.
 * @returns A human-readable label (e.g. "Needs producer review").
 */
export declare function needsProducerReviewLabel(needsProducerReview: boolean | null | undefined): string;
/**
 * Get the text fallback for a producer review icon.
 *
 * @param needsProducerReview - Whether the work item needs producer review.
 * @returns The bracketed text label (e.g. "[NEEDS_PRODUCER]").
 */
export declare function needsProducerReviewFallback(needsProducerReview: boolean | null | undefined): string;
/**
 * Get the icon string (emoji or text fallback) for an epic work item.
 *
 * Epic icon: 🏰 (castle) — represents a large feature with dependencies.
 * Fallback: [EPIC]
 *
 * @param opts - Options controlling fallback behaviour.
 * @returns The icon string (emoji or bracketed text).
 */
export declare function epicIcon(opts?: IconOptions): string;
/**
 * Get the accessible label for the epic icon.
 *
 * @returns A human-readable label ("Issue Type: Epic").
 */
export declare function epicLabel(): string;
/**
 * Get the text fallback for the epic icon.
 *
 * @returns The bracketed text label ("[EPIC]").
 */
export declare function epicFallback(): string;
//# sourceMappingURL=icons.d.ts.map