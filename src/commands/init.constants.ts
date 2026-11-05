/**
 * init constants — paths, destination filenames and marker strings for `wl init`.
 *
 * Single responsibility: hold the constant vocabulary shared across the
 * `src/commands/init*.ts` family (template locations, destination file names
 * and the markers used to detect already-provisioned content). Declarations
 * only — no logic and no imports.
 */

export const WORKLOG_GITIGNORE_SECTION_START = 'Worklog Specific Ignores';
export const WORKLOG_GITIGNORE_SECTION_END = '### End of Worklog Specific Ignores';
export const WORKLOG_AGENT_TEMPLATE_RELATIVE_PATH = 'templates/AGENTS.md';
export const WORKLOG_AGENT_DESTINATION_FILENAME = 'AGENTS.md';
export const WORKFLOW_TEMPLATE_RELATIVE_PATH = 'templates/WORKFLOW.md';
export const WORKFLOW_DESTINATION_FILENAME = 'WORKFLOW.md';
export const WORKLOG_GITIGNORE_TEMPLATE_RELATIVE_PATH = 'templates/GITIGNORE_WORKLOG.txt';
/**
 * Marker used to detect that the canonical "Global agent guidance" reference
 * structure is already present in a project AGENTS.md. The template
 * (templates/AGENTS.md) self-references the global file, so projects that
 * install or append it must NOT duplicate the reference on re-run.
 */
export const CANONICAL_GLOBAL_REFERENCE_MARKER = '## Global agent guidance';
export const CANONICAL_GLOBAL_REFERENCE_LINE = 'Read the global agent instructions at `~/.pi/agent/AGENTS.md`';

/**
 * Scheduled-prompts provisioning (WL-0MSS1Q5ER007QDKX AC1): `wl init` copies
 * templates/scheduled-prompts.json into .worklog/scheduled-prompts.json when
 * the file is absent (create-if-absent — never clobbers user edits or
 * lastTriggeredAt state). The file is consumed by the herdr downtime
 * worker's scheduled-prompts dispatch tier.
 */
export const SCHEDULED_PROMPTS_TEMPLATE_RELATIVE_PATH = 'templates/scheduled-prompts.json';
export const SCHEDULED_PROMPTS_DESTINATION_FILENAME = 'scheduled-prompts.json';

export const DEFAULT_COMMITTED_HOOKS_DIR = '.githooks';
