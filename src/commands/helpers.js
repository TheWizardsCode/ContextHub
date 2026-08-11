/**
 * Shared helper functions for CLI commands
 */
import { theme } from '../theme.js';
import { redactAuditText } from '../audit.js';
import { loadConfig } from '../config.js';
import { renderCliMarkdown, isTty, resolveMarkdownEnabled } from '../cli-output.js';
import { getStageLabel, getStatusLabel, loadStatusStageRules } from '../status-stage-rules.js';
import { priorityIcon, statusIcon, priorityFallback, statusFallback, iconsEnabled } from '../icons.js';
// Priority ordering for sorting work items (higher number = higher priority)
const PRIORITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1 };
const DEFAULT_PRIORITY = PRIORITY_ORDER.medium;
// Helper to format a value for display
export function formatValue(value) {
    if (value === null || value === undefined) {
        return '(empty)';
    }
    if (value === '') {
        return '(empty string)';
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return '[]';
        }
        return `[${value.join(', ')}]`;
    }
    return String(value);
}
// Helper function to sort items by priority and creation date
export function sortByPriorityAndDate(a, b) {
    // Higher priority comes first (descending order)
    const aPriority = PRIORITY_ORDER[a.priority] ?? DEFAULT_PRIORITY;
    const bPriority = PRIORITY_ORDER[b.priority] ?? DEFAULT_PRIORITY;
    const priorityDiff = bPriority - aPriority;
    if (priorityDiff !== 0)
        return priorityDiff;
    // If priorities are equal, sort by creation time (oldest first, ascending order)
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}
export function sortByPriorityDateAndId(a, b) {
    const byPriorityAndDate = sortByPriorityAndDate(a, b);
    if (byPriorityAndDate !== 0)
        return byPriorityAndDate;
    return a.id.localeCompare(b.id);
}
// Format title and id with consistent coloring used in tree/list outputs
export function formatTitleAndId(item, prefix = '') {
    return `${prefix}${renderTitle(item)} ${theme.text.muted('-')} ${theme.text.muted(item.id)}`;
}
// Format only the title (consistent color)
export function formatTitleOnly(item) {
    return renderTitle(item);
}
// Return chalk function appropriate for a given stage (for console output)
// Stage progression: gray → blue → cyan → yellow → green → white
function titleColorForStage(stage) {
    const s = (stage || '').toLowerCase().trim();
    switch (s) {
        case 'idea':
            return theme.stage.idea;
        case 'intake_complete':
            return theme.stage.intakeComplete;
        case 'plan_complete':
            return theme.stage.planComplete;
        case 'in_progress':
            return theme.stage.inProgress;
        case 'in_review':
            return theme.stage.inReview;
        case 'done':
            return theme.stage.done;
        default:
            return theme.stage.idea; // default to idea/gray colour
    }
}
// Render a work item title with the color appropriate to its status or stage
// Blocked items always appear red, regardless of stage. Otherwise, stage-based colours apply.
function renderTitle(item, prefix = '') {
    // Blocked status overrides everything
    if (item.status === 'blocked') {
        return theme.blocked(prefix + item.title);
    }
    // Use stage-based colour; fallback to idea/gray when stage is undefined or empty
    const colorFn = titleColorForStage(item.stage || undefined);
    return colorFn(prefix + item.title);
}
// Helper to display work items in a tree structure
/**
 * @deprecated Use `displayItemTreeWithFormat(items, db, format)` which delegates
 * to the human formatter and keeps `list` and `show` outputs consistent.
 */
export function displayItemTree(items) {
    walkItemTree(items, {
        sortRootItems: list => list.slice().sort(sortByPriorityAndDate),
        sortChildItems: list => list.slice().sort(sortByPriorityDateAndId),
        render: (item, { indent, isLast, inheritedStage }) => {
            const prefix = indent + (isLast ? '└── ' : '├── ');
            console.log(formatTitleAndId(item, prefix));
            const detailIndent = indent + (isLast ? '    ' : '│   ');
            const effectiveStage = item.stage ?? inheritedStage;
            const statusSummary = effectiveStage
                ? `Status: ${item.status} · Stage: ${effectiveStage} | Priority: ${item.priority}`
                : `Status: ${item.status} | Priority: ${item.priority}`;
            console.log(`${detailIndent}${statusSummary}`);
            console.log(`${detailIndent}Risk: ${item.risk || '—'}`);
            console.log(`${detailIndent}Effort: ${item.effort || '—'}`);
            if (item.assignee)
                console.log(`${detailIndent}Assignee: ${item.assignee}`);
            if (item.tags.length > 0)
                console.log(`${detailIndent}Tags: ${item.tags.join(', ')}`);
        }
    });
}
// Display work items using the human formatter but preserve tree hierarchy
export function displayItemTreeWithFormat(items, db, format) {
    const itemIds = new Set(items.map(i => i.id));
    const orderedItems = db
        ? db.getAllOrderedByHierarchySortIndex().filter(item => itemIds.has(item.id))
        : null;
    const sortChildren = (list) => {
        if (!orderedItems) {
            return list.slice().sort(sortByPriorityAndDate);
        }
        const positions = new Map(orderedItems.map((item, index) => [item.id, index]));
        return list
            .slice()
            .sort((a, b) => {
            const aPos = positions.get(a.id);
            const bPos = positions.get(b.id);
            if (aPos === undefined && bPos === undefined) {
                return sortByPriorityAndDate(a, b);
            }
            if (aPos === undefined)
                return 1;
            if (bPos === undefined)
                return -1;
            if (aPos !== bPos)
                return aPos - bPos;
            return sortByPriorityAndDate(a, b);
        });
    };
    walkItemTree(items, {
        sortRootItems: sortChildren,
        sortChildItems: sortChildren,
        render: (item, { indent, isLast, inheritedStage }) => {
            const prefix = indent + (isLast ? '└── ' : '├── ');
            const detailIndent = indent + (isLast ? '    ' : '│   ');
            // If the item doesn't have an explicit stage, fall back to an inherited stage
            const displayItem = Object.assign({}, item, { stage: item.stage ?? inheritedStage });
            // Normalize empty-string stage to explicit empty so downstream logic can detect it
            if (displayItem.stage === '') {
                // keep as empty string to signal 'Undefined' label
            }
            const formatted = humanFormatWorkItem(displayItem, db, format);
            const lines = formatted.split('\n');
            // First line gets the tree marker prefix
            console.log(prefix + lines[0]);
            // Subsequent lines align under the detail indent
            for (let i = 1; i < lines.length; i++) {
                console.log(detailIndent + lines[i]);
            }
        }
    });
}
/**
 * Render the same tree output as `displayItemTreeWithFormat` but return it as
 * a single string instead of printing directly. This is useful when callers
 * wish to pipe the output through a pager or otherwise capture it.
 */
export function displayItemTreeWithFormatToString(items, db, format) {
    const outLines = [];
    const itemIds = new Set(items.map(i => i.id));
    const orderedItems = db
        ? db.getAllOrderedByHierarchySortIndex().filter(item => itemIds.has(item.id))
        : null;
    const sortChildren = (list) => {
        if (!orderedItems) {
            return list.slice().sort(sortByPriorityAndDate);
        }
        const positions = new Map(orderedItems.map((item, index) => [item.id, index]));
        return list
            .slice()
            .sort((a, b) => {
            const aPos = positions.get(a.id);
            const bPos = positions.get(b.id);
            if (aPos === undefined && bPos === undefined) {
                return sortByPriorityAndDate(a, b);
            }
            if (aPos === undefined)
                return 1;
            if (bPos === undefined)
                return -1;
            if (aPos !== bPos)
                return aPos - bPos;
            return sortByPriorityAndDate(a, b);
        });
    };
    walkItemTree(items, {
        sortRootItems: sortChildren,
        sortChildItems: sortChildren,
        render: (item, { indent, isLast, inheritedStage }) => {
            const prefix = indent + (isLast ? '└── ' : '├── ');
            const detailIndent = indent + (isLast ? '    ' : '│   ');
            const displayItem = Object.assign({}, item, { stage: item.stage ?? inheritedStage });
            if (displayItem.stage === '') {
                // keep as empty string to signal 'Undefined' label
            }
            const formatted = humanFormatWorkItem(displayItem, db, format);
            const lines = formatted.split('\n');
            outLines.push(prefix + lines[0]);
            for (let i = 1; i < lines.length; i++) {
                outLines.push(detailIndent + lines[i]);
            }
        }
    });
    return outLines.join('\n');
}
function walkItemTree(items, options) {
    const itemIds = new Set(items.map(item => item.id));
    const childrenByParent = new Map();
    for (const item of items) {
        const parentKey = item.parentId && itemIds.has(item.parentId) ? item.parentId : null;
        const list = childrenByParent.get(parentKey) ?? [];
        list.push(item);
        childrenByParent.set(parentKey, list);
    }
    const rootItems = options.sortRootItems(childrenByParent.get(null) ?? []);
    const visit = (item, indent, isLast, inheritedStage) => {
        options.render(item, { indent, isLast, inheritedStage });
        const detailIndent = indent + (isLast ? '    ' : '│   ');
        const effectiveStage = item.stage ?? inheritedStage;
        const children = childrenByParent.get(item.id);
        if (!children || children.length === 0)
            return;
        const orderedChildren = options.sortChildItems(children);
        orderedChildren.forEach((child, index) => {
            const last = index === orderedChildren.length - 1;
            visit(child, detailIndent, last, effectiveStage);
        });
    };
    rootItems.forEach((item, index) => {
        const isLastItem = index === rootItems.length - 1;
        visit(item, '', isLastItem, undefined);
    });
}
// Helper to apply color to audit excerpt based on readiness status
// Redaction must happen BEFORE applying color
function colorizeAuditExcerpt(auditText) {
    const firstLine = auditText.split(/\r?\n/, 1)[0];
    if (firstLine.includes('Ready to close: Yes')) {
        return theme.text.readyYes(firstLine);
    }
    return theme.text.readyNo(firstLine);
}
/**
 * Format an array of [label, value] pairs as a markdown table string.
 *
 * Pipe characters (`|`) in values are escaped to `\|` to prevent markdown
 * table rendering issues. The table has two columns: "Field" and "Value".
 *
 * @param rows - Array of [label, value] tuples to render in the table
 * @returns The markdown table as a string (without trailing newline)
 */
function formatMetadataTable(rows) {
    if (rows.length === 0)
        return '';
    // Escape pipe characters in values to prevent markdown table breakage
    const escaped = rows.map(([label, value]) => {
        const escapedValue = value.replace(/\|/g, '\\|');
        return [label, escapedValue];
    });
    const fieldWidth = Math.max(...escaped.map(([l]) => l.length), 5); // min 5 for "Field"
    const lines = [];
    lines.push(`| ${'Field'.padEnd(fieldWidth)} | Value |`);
    lines.push(`| ${'-'.repeat(fieldWidth)} | ----- |`);
    for (const [label, value] of escaped) {
        lines.push(`| ${label.padEnd(fieldWidth)} | ${value} |`);
    }
    return lines.join('\n');
}
// Standard human formatter: supports 'summary' | 'concise' | 'normal' | 'full' | 'raw' | 'markdown' | 'auto'
export function humanFormatWorkItem(item, db, format) {
    // Load config once and reuse for both humanDisplay and cliFormatMarkdown
    const config = loadConfig();
    // Read audit result from the dedicated table (sole source of truth)
    const auditResult = db ? db.getAuditResult(item.id) : null;
    // Resolve 'auto' and 'markdown' format values
    let fmt = (format || config?.humanDisplay || 'full').toLowerCase();
    let markdownEnabled = false;
    // Track if the format explicitly disables or enables markdown rendering.
    // These flags prevent config from overriding explicit CLI choices.
    let explicitDisabled = false;
    let explicitAuto = false;
    // 'markdown' format means: render full output through the markdown renderer
    if (fmt === 'markdown') {
        fmt = 'full';
        markdownEnabled = true;
    }
    // 'auto' means: use markdown rendering if TTY, otherwise plain full
    if (fmt === 'auto') {
        fmt = 'full';
        explicitAuto = true;
    }
    // 'text' or 'plain' format means: plain text, no markdown
    if (fmt === 'text' || fmt === 'plain') {
        fmt = 'full';
        explicitDisabled = true;
    }
    // Use the shared precedence resolver when no explicit markdown/plain/text/auto
    // flag was specified. This preserves the CLI > config > auto-detect chain.
    if (!markdownEnabled && !explicitDisabled && !explicitAuto) {
        const resolved = resolveMarkdownEnabled({
            format: undefined, // format is already resolved into fmt/explicit flags above
            cliFormatMarkdown: config?.cliFormatMarkdown,
        });
        if (resolved === true) {
            markdownEnabled = true;
        }
        else if (resolved === false) {
            markdownEnabled = false;
        }
        else {
            // undefined: auto-detect from TTY
            markdownEnabled = isTty();
        }
    }
    const rules = loadStatusStageRules();
    // Helper to format status line with icon
    const formatStatusWithIcon = (status) => {
        const icon = statusIcon(status, { noIcons: !iconsEnabled() });
        const fallback = statusFallback(status);
        const label = getStatusLabel(status, rules) || status;
        // If noIcons mode, icon already returned the fallback text - just show label + fallback
        // Otherwise show icon + label + fallback (icon for visual, fallback for copy/paste)
        if (icon === fallback) {
            return `${label} ${fallback}`;
        }
        return icon ? `${icon} ${label} ${fallback}` : label;
    };
    // Helper to format priority line with icon
    const formatPriorityWithIcon = (priority) => {
        const icon = priorityIcon(priority, { noIcons: !iconsEnabled() });
        const fallback = priorityFallback(priority);
        // If noIcons mode, icon already returned the fallback text - just show priority + fallback
        // Otherwise show icon + priority + fallback (icon for visual, fallback for copy/paste)
        if (icon === fallback) {
            return `${priority} ${fallback}`;
        }
        return icon ? `${icon} ${priority} ${fallback}` : priority;
    };
    const lines = [];
    // summary: truly minimal - just title, status, priority
    if (fmt === 'summary') {
        const lines = [];
        lines.push(`${formatTitleOnly(item)} ${theme.text.muted(item.id)}`);
        const sLine = formatStatusWithIcon(item.status);
        lines.push(`Status: ${sLine} | Priority: ${formatPriorityWithIcon(item.priority)}`);
        return lines.join('\n');
    }
    if (fmt === 'raw') {
        return JSON.stringify(item, null, 2);
    }
    if (fmt === 'concise') {
        const lines = [];
        // First line: title + id (compact)
        lines.push(`${formatTitleOnly(item)} ${theme.text.muted(item.id)}`);
        // Build metadata as a markdown table
        const metaRows = [];
        if (item.stage !== undefined) {
            const stageLabel = item.stage === '' ? getStageLabel('', rules) || 'Undefined' : getStageLabel(item.stage, rules) || item.stage;
            metaRows.push(['Status', `${formatStatusWithIcon(item.status)} · Stage: ${stageLabel} | Priority: ${formatPriorityWithIcon(item.priority)}`]);
        }
        else {
            metaRows.push(['Status', `${formatStatusWithIcon(item.status)} | Priority: ${formatPriorityWithIcon(item.priority)}`]);
        }
        metaRows.push(['SortIndex', String(item.sortIndex)]);
        metaRows.push(['Risk', item.risk || '—']);
        metaRows.push(['Effort', item.effort || '—']);
        if (item.assignee)
            metaRows.push(['Assignee', item.assignee]);
        if (auditResult) {
            const raw = String(auditResult.summary || '');
            const redacted = redactAuditText(raw);
            const colorized = colorizeAuditExcerpt(redacted);
            metaRows.push(['Audit', colorized]);
        }
        if (item.tags && item.tags.length > 0)
            metaRows.push(['Tags', item.tags.join(', ')]);
        lines.push(formatMetadataTable(metaRows));
        // Non-blocking warning after the table (if applicable)
        if (auditResult && !auditResult.readyToClose && !auditResult.summary?.startsWith('Ready to close:')) {
            lines.push(`Warning: Audit claim could not be verified (Missing Criteria)`);
        }
        return lines.join('\n');
    }
    // normal output
    if (fmt === 'normal') {
        // Build metadata as a markdown table (ID, Title, Status, SortIndex, Risk, Effort, Assignee, Audit, Parent)
        const metaRows = [];
        metaRows.push(['ID', theme.text.muted(item.id)]);
        metaRows.push(['Title', formatTitleOnly(item)]);
        if (item.stage !== undefined) {
            const stageLabel = item.stage === '' ? getStageLabel('', rules) || 'Undefined' : getStageLabel(item.stage, rules) || item.stage;
            metaRows.push(['Status', `${formatStatusWithIcon(item.status)} · Stage: ${stageLabel} | Priority: ${formatPriorityWithIcon(item.priority)}`]);
        }
        else {
            metaRows.push(['Status', `${formatStatusWithIcon(item.status)} | Priority: ${formatPriorityWithIcon(item.priority)}`]);
        }
        metaRows.push(['SortIndex', String(item.sortIndex)]);
        metaRows.push(['Risk', item.risk || '—']);
        metaRows.push(['Effort', item.effort || '—']);
        if (item.assignee)
            metaRows.push(['Assignee', item.assignee]);
        if (auditResult) {
            const raw = String(auditResult.summary || '');
            const redacted = redactAuditText(raw);
            const colorized = colorizeAuditExcerpt(redacted);
            metaRows.push(['Audit', colorized]);
        }
        if (item.parentId)
            metaRows.push(['Parent', item.parentId]);
        if (item.tags && item.tags.length > 0)
            metaRows.push(['Tags', item.tags.join(', ')]);
        lines.push(formatMetadataTable(metaRows));
        // Description remains as a separate section below the table
        if (item.description)
            lines.push(`Description: ${item.description}`);
        return lines.join('\n');
    }
    // detail-pane: title + description + comments only (metadata is in the metadata pane)
    if (fmt === 'detail-pane') {
        lines.push(renderTitle(item, '# '));
        if (item.description) {
            lines.push('');
            lines.push('## Description');
            lines.push('');
            lines.push(item.description);
        }
        if (db) {
            const comments = db.getCommentsForWorkItem(item.id);
            if (comments.length > 0) {
                lines.push('');
                lines.push('## Comments');
                lines.push('');
                for (const c of comments) {
                    lines.push(`  ${c.author} at ${c.createdAt}`);
                    lines.push(`    ${c.comment}`);
                }
            }
        }
        return lines.join('\n');
    }
    // full output
    lines.push(renderTitle(item, '# '));
    lines.push('');
    const issueTypeLabel = item.issueType && item.issueType.trim() !== '' ? item.issueType : 'unknown';
    // Build status/priority line with icons
    const statusPriorityValue = item.stage !== undefined
        ? `${formatStatusWithIcon(item.status)} · Stage: ${item.stage === '' ? getStageLabel('', rules) || 'Undefined' : getStageLabel(item.stage, rules) || item.stage} | Priority: ${formatPriorityWithIcon(item.priority)}`
        : `${formatStatusWithIcon(item.status)} | Priority: ${formatPriorityWithIcon(item.priority)}`;
    // Build metadata as a markdown table
    const frontmatter = [
        ['ID', theme.text.muted(item.id)],
        ['Status', statusPriorityValue],
        ['Type', issueTypeLabel],
        ['SortIndex', String(item.sortIndex)]
    ];
    frontmatter.push(['Risk', item.risk || '—']);
    frontmatter.push(['Effort', item.effort || '—']);
    if (item.assignee)
        frontmatter.push(['Assignee', item.assignee]);
    if (item.parentId)
        frontmatter.push(['Parent', item.parentId]);
    if (item.tags && item.tags.length > 0)
        frontmatter.push(['Tags', item.tags.join(', ')]);
    lines.push(formatMetadataTable(frontmatter));
    if (item.description) {
        lines.push('');
        lines.push('## Description');
        lines.push('');
        lines.push(item.description);
    }
    if (db) {
        // Ensure comments are presented newest-first in human output as well.
        const comments = db.getCommentsForWorkItem(item.id);
        if (comments.length > 0) {
            lines.push('');
            lines.push('## Comments');
            lines.push('');
            for (const c of comments) {
                // IDs are internal-only for human display; omit them here per WL-0MKZ5IR3H0O4M8GD.
                lines.push(`  ${c.author} at ${c.createdAt}`);
                lines.push(`    ${c.comment}`);
            }
        }
    }
    if (auditResult) {
        lines.push('');
        lines.push('## Audit');
        lines.push('');
        lines.push(`Ready to close: ${auditResult.readyToClose ? 'Yes' : 'No'}`);
        lines.push(`Audited at: ${auditResult.auditedAt}`);
        if (auditResult.author)
            lines.push(`Author: ${auditResult.author}`);
        if (auditResult.summary) {
            const redacted = redactAuditText(auditResult.summary);
            const colorizedFirstLine = colorizeAuditExcerpt(redacted);
            const remainingLines = redacted.split(/\r?\n/).slice(1).join('\n');
            const coloredText = remainingLines ? `${colorizedFirstLine}\n${remainingLines}` : colorizedFirstLine;
            lines.push('');
            lines.push(coloredText);
        }
    }
    const result = lines.join('\n');
    // If markdown rendering is enabled, render the full output through the CLI renderer
    if (markdownEnabled) {
        return renderCliMarkdown(result, { formatAsMarkdown: true });
    }
    return result;
}
// Resolve final format choice: CLI override > provided > config > default
export function resolveFormat(program, provided) {
    const cliFormat = program.opts().format;
    if (cliFormat && typeof cliFormat === 'string' && cliFormat.trim() !== '')
        return cliFormat;
    if (provided && provided.trim() !== '')
        return provided;
    return loadConfig()?.humanDisplay || 'full';
}
// Human formatter for comments
export function humanFormatComment(comment, format) {
    const fmt = (format || loadConfig()?.humanDisplay || 'full').toLowerCase();
    if (fmt === 'raw')
        return JSON.stringify(comment, null, 2);
    if (fmt === 'concise') {
        const excerpt = comment.comment.split('\n')[0];
        return `${theme.text.muted('[' + comment.id + ']')} ${comment.author} - ${excerpt}`;
    }
    const lines = [];
    lines.push(`ID:      ${theme.text.muted(comment.id)}`);
    lines.push(`Author:  ${comment.author}`);
    lines.push(`Created: ${comment.createdAt}`);
    lines.push('');
    lines.push(comment.comment);
    if (comment.references && comment.references.length > 0) {
        lines.push('');
        lines.push(`References: ${comment.references.join(', ')}`);
    }
    return lines.join('\n');
}
// Display detailed conflict information with color coding
export function displayConflictDetails(result, mergedItems, options) {
    if (result.conflictDetails.length === 0) {
        console.log('\n' + theme.text.success('✓ No conflicts detected'));
        return;
    }
    console.log('\n' + theme.text.strong('Conflict Resolution Details:'));
    if (options?.repoUrl) {
        console.log(theme.text.muted(options.repoUrl));
    }
    console.log(theme.text.muted('━'.repeat(80)));
    const itemsById = new Map(mergedItems.map(item => [item.id, item]));
    result.conflictDetails.forEach((conflict, index) => {
        const workItem = itemsById.get(conflict.itemId);
        const displayText = workItem ? `${formatTitleOnly(workItem)} (${conflict.itemId})` : conflict.itemId;
        console.log(theme.text.strong(`\n${index + 1}. Work Item: ${displayText}`));
        if (conflict.conflictType === 'same-timestamp') {
            console.log(theme.text.warning(`   Same timestamp (${conflict.localUpdatedAt}) - merged deterministically`));
        }
        else {
            console.log(`   Local updated: ${conflict.localUpdatedAt || 'unknown'}`);
            console.log(`   Remote updated: ${conflict.remoteUpdatedAt || 'unknown'}`);
        }
        console.log();
        conflict.fields.forEach((field) => {
            console.log(theme.text.strong(`   Field: ${field.field}`));
            if (field.chosenSource === 'merged') {
                console.log(theme.text.info(`     Local:  ${formatValue(field.localValue)}`));
                console.log(theme.text.info(`     Remote: ${formatValue(field.remoteValue)}`));
                console.log(theme.text.success(`     Merged: ${formatValue(field.chosenValue)}`));
            }
            else {
                if (field.chosenSource === 'local') {
                    console.log(theme.text.success(`   ✓ Local:  ${formatValue(field.localValue)}`));
                    console.log(theme.text.error(`   ✗ Remote: ${formatValue(field.remoteValue)}`));
                }
                else {
                    console.log(theme.text.error(`   ✗ Local:  ${formatValue(field.localValue)}`));
                    console.log(theme.text.success(`   ✓ Remote: ${formatValue(field.remoteValue)}`));
                }
            }
            console.log(theme.text.muted(`     Reason: ${field.reason}`));
            console.log();
        });
    });
    console.log(theme.text.muted('━'.repeat(80)));
}
// ── JSON response shape helpers ──────────────────────────────────────
// These helpers standardize the top-level JSON shape returned by all `wl`
// commands when --json mode is active. The consistent shape reduces
// fragility in consuming scripts and the TUI.
/**
 * Wrap any command output in a standard success/error envelope.
 *
 * All commands using --json should ensure their top-level JSON shape
 * follows the pattern: `{ success: true/false, ...data }`.
 */
export function wrapJsonResponse(data, success = true) {
    return { success, ...data };
}
/**
 * Convenience: wrap an array of work items for an array-returning command.
 *
 * Array-returning commands (list, search, in-progress, recent) should use
 * the shape: `{ success: true, count, workItems: [...] }`.
 */
export function wrapWorkItemsResponse(workItems, extraFields) {
    return {
        success: true,
        count: workItems.length,
        workItems,
        ...extraFields,
    };
}
/**
 * Convenience: wrap a single work item for an object-returning command.
 *
 * Object-returning commands (show, create, update, next single) should use
 * the shape: `{ success: true, workItem: {...}, ...extraFields }`.
 */
export function wrapWorkItemResponse(workItem, extraFields) {
    return {
        success: true,
        workItem,
        ...extraFields,
    };
}
// ── File path extraction ──────────────────────────────────────────────
/**
 * Extract file paths from a work item description.
 *
 * Looks for a "Key Files" or "Key Files:" section (case-insensitive, with or without bold markers,
 * and with or without a trailing colon, e.g. `**Key Files:**`, `## Key Files`, `key files:`, `Key Files`)
 * and extracts path-like strings from subsequent bullet list items.
 *
 * A path is considered valid if it:
 * - Contains at least one `/` (indicating a file in a directory)
 * - Ends with a file extension after a `.` (e.g., `.ts`, `.md`, `.json`)
 *
 * Items can be listed with or without backtick formatting.
 *
 * @param description - The work item description text
 * @returns Array of extracted file paths
 */
export function extractFilePaths(description) {
    if (!description || description.trim().length === 0) {
        return [];
    }
    const paths = [];
    // Match the "Key Files:" header (case-insensitive, optional bold markers)
    // Capture everything after the header line until the next section header or end of string
    const keyFilesRegex = /^#{0,3}\s*\*{0,2}key files:?\*{0,2}\s*$/im;
    const match = description.match(keyFilesRegex);
    if (!match) {
        return [];
    }
    const headerIndex = match.index;
    const afterHeader = description.slice(headerIndex + match[0].length);
    // Split into lines and process each line until we hit another section header
    // or a bold section header (e.g., **Some Section:**)
    const lines = afterHeader.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        // Stop if we hit another Markdown heading
        if (/^#{1,3}\s/.test(trimmed)) {
            break;
        }
        // Stop if we hit another bold section header (e.g., **Some Section:**)
        if (/^\*{1,2}\w.*:\*{0,2}\s*$/.test(trimmed) && !/^[-*]\s/.test(trimmed)) {
            break;
        }
        // Stop if we hit another "Key Files:" header (case-insensitive)
        if (/\*{0,2}key files:?\*{0,2}\s*$/i.test(trimmed) && !/^[-*]\s/.test(trimmed)) {
            break;
        }
        // Match bullet items: `- ` or `* ` prefix, with two extraction strategies:
        //
        // 1. Backtick-wrapped path: extract text between backticks (allowing trailing
        //    description after the closing backtick, e.g. `path.ts` — some context).
        // 2. Plain path (no backticks): extract the first space-delimited word as a
        //    path candidate.
        //
        // Note: We try backtick first because a line like `- \`path.ts\` — desc` could
        // have a false-positive plain match on the trailing desc.
        let pathCandidate = null;
        const backtickMatch = trimmed.match(/^[-*]\s+`([^`]+)`/);
        if (backtickMatch) {
            pathCandidate = backtickMatch[1].trim();
        }
        else {
            // No backticks — try to extract the first word after the bullet marker
            const plainMatch = trimmed.match(/^[-*]\s+([^\s]+)/);
            if (plainMatch) {
                pathCandidate = plainMatch[1].trim();
            }
        }
        if (!pathCandidate)
            continue;
        // Validate that it looks like a file path
        if (isFilePath(pathCandidate)) {
            paths.push(pathCandidate);
        }
    }
    return paths;
}
/**
 * Check if a string looks like a valid file path.
 *
 * A valid path contains at least one `/` and has a file extension.
 * Rejects URLs (http://, https://) and known non-path patterns.
 */
function isFilePath(candidate) {
    // Reject URLs
    if (/^https?:\/\//i.test(candidate))
        return false;
    if (!candidate.includes('/'))
        return false;
    // Must have a file extension (dot followed by alphanumeric chars at the end)
    const extMatch = candidate.match(/\.([a-zA-Z0-9]+)$/);
    if (!extMatch)
        return false;
    // Ensure the extension is at least 1 character
    return extMatch[1].length >= 1;
}
//# sourceMappingURL=helpers.js.map