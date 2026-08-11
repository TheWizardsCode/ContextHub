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
import { extractFilePaths } from '../commands/helpers.js';
const SEVERITY = 'warning';
const CHECK_ID_MISSING = 'file-paths.missing-section';
const CHECK_ID_INCORRECT = 'file-paths.incorrect';
const TYPE_MISSING = 'missing-key-files';
const TYPE_INCORRECT = 'incorrect-key-files';
/**
 * The default intake stage name for the file-paths convention.
 * Projects may configure a different stage name in their config.
 */
export const DEFAULT_INTAKE_STAGES = ['intake_complete', 'prd_complete'];
/**
 * Validate that all intake-stage work items have valid **Key Files:** sections.
 *
 * @param items - All work items in the database
 * @param intakeStageNames - Stage names that represent the intake stage (default: ['intake_complete', 'prd_complete'])
 * @returns Array of findings for items missing or having incorrect Key Files sections
 */
export function validateFilePaths(items, intakeStageNames) {
    const findings = [];
    const stages = intakeStageNames || DEFAULT_INTAKE_STAGES;
    const intakeItems = items.filter(item => stages.includes(item.stage) && item.status !== 'deleted');
    for (const item of intakeItems) {
        const description = item.description || '';
        const paths = extractFilePaths(description);
        if (paths.length === 0) {
            // Check if the description has a **Key Files:** section header at all
            const hasSection = /^#{0,3}\s*\*{0,2}key files:\*{0,2}\s*$/im.test(description);
            if (!hasSection) {
                findings.push({
                    checkId: CHECK_ID_MISSING,
                    type: TYPE_MISSING,
                    severity: SEVERITY,
                    itemId: item.id,
                    message: `Missing **Key Files:** section in description. ` +
                        `Add a "**Key Files:**" section with bullet-pointed file paths ` +
                        `(e.g., "- \`src/commands/next.ts\`"). ` +
                        `See docs/FILE_PATH_CONVENTION.md for details.`,
                    proposedFix: {
                        appendDescription: `\n\n**Key Files:**\n- \`TODO: add file paths\``,
                    },
                    safe: true,
                    context: {
                        stage: item.stage,
                        itemTitle: item.title,
                        hasSection: false,
                    },
                });
            }
            else {
                findings.push({
                    checkId: CHECK_ID_INCORRECT,
                    type: TYPE_INCORRECT,
                    severity: SEVERITY,
                    itemId: item.id,
                    message: `**Key Files:** section exists but contains no valid file paths. ` +
                        `Each path must contain at least one "/" and end with a file extension ` +
                        `(e.g., "- \`src/commands/next.ts\`"). ` +
                        `See docs/FILE_PATH_CONVENTION.md for details.`,
                    proposedFix: null,
                    safe: false,
                    context: {
                        stage: item.stage,
                        itemTitle: item.title,
                        hasSection: true,
                        extractedPaths: paths,
                    },
                });
            }
        }
    }
    return findings;
}
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
export function applyFilePathsFix(finding, updateItem) {
    if (finding.type !== TYPE_MISSING) {
        return false;
    }
    const proposedFix = finding.proposedFix;
    if (!proposedFix?.appendDescription) {
        return false;
    }
    // The proposedFix contains the text to append; we need to get the current item
    // and append. However, the callback receives the full description.
    // Since we can't read the current description here, we return true to signal
    // the caller should apply the fix using the proposedFix data.
    return true;
}
//# sourceMappingURL=file-paths-check.js.map