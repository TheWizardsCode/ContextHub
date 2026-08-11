/**
 * File-path validation for work items at the intake stage.
 *
 * Scans all items at the intake stage and reports those that are missing
 * or have incorrect `**Key Files:**` sections.
 *
 * Follows the pattern from `status-stage-check.ts`.
 *
 * The canonical intake stage is `intake_complete`. Some projects may use
 * an alternative name such as `prd_complete`. The caller passes the
 * intake stage names to check via the `intakeStageNames` parameter.
 */
import type { WorkItem } from '../types.js';
export type DoctorSeverity = 'info' | 'warning' | 'error';
export interface FilePathsFinding {
    checkId: string;
    type: string;
    severity: DoctorSeverity;
    itemId: string;
    message: string;
    proposedFix: Record<string, unknown> | null;
    safe: boolean;
    context: Record<string, unknown>;
}
/**
 * The default intake stage name for the file-paths convention.
 * Projects may configure a different stage name in their config.
 */
export declare const DEFAULT_INTAKE_STAGES: string[];
/**
 * Validate that all intake-stage work items have valid **Key Files:** sections.
 *
 * @param items - All work items in the database
 * @param intakeStageNames - Stage names that represent the intake stage (default: ['intake_complete', 'prd_complete'])
 * @returns Array of findings for items missing or having incorrect Key Files sections
 */
export declare function validateFilePaths(items: WorkItem[], intakeStageNames?: string[]): FilePathsFinding[];
/**
 * Apply the --fix action for file-paths findings.
 *
 * For items missing a **Key Files:** section, appends a placeholder section.
 * For items with incorrect paths, no automatic fix is applied (returns false).
 *
 * @param finding - The finding to fix
 * @param updateItem - Callback to update a work item's description
 * @returns true if the fix was applied, false otherwise
 */
export declare function applyFilePathsFix(finding: FilePathsFinding, updateItem: (itemId: string, updates: {
    description: string;
}) => boolean): boolean;
//# sourceMappingURL=file-paths-check.d.ts.map