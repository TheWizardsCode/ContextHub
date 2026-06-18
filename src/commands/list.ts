/**
 * List command - List work items
 */

import type { PluginContext } from '../plugin-types.js';
import type { ListOptions } from '../cli-types.js';
import type { WorkItemQuery, WorkItemStatus, WorkItemPriority } from '../types.js';
import { displayItemTreeWithFormat, humanFormatWorkItem, resolveFormat, sortByPriorityAndDate } from './helpers.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;
  
  program
    .command('list')
    .description('List work items')
    .argument('[search]', 'Search term (matches id, title, and description)')
    .option('-s, --status <status>', 'Filter by status')
    .option('-p, --priority <priority>', 'Filter by priority')
    .option('--parent <id>', 'Filter by parent id (direct children only)')
    
    .option('-n, --number <n>', 'Limit the number of items returned')
    .option('--deleted', 'Include deleted items in results')
    .option('--tags <tags>', 'Filter by tags (comma-separated)')
    .option('-a, --assignee <assignee>', 'Filter by assignee')
    .option('--stage <stage>', 'Filter by stage')
    .option('--needs-producer-review [value]', 'Filter by needsProducerReview flag (true|false|yes|no; default true when omitted)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--no-icons', 'Disable icon rendering for clean text output')
    .action((search: string | undefined, options: ListOptions) => {
      // Apply --no-icons flag by setting env var before any icon functions are called
      if (options.icons === false) {
        process.env.WL_NO_ICONS = '1';
      }
      utils.requireInitialized();
      const db = utils.getDatabase(options?.prefix);
      
      const query: WorkItemQuery = {};
      if (options.status) {
        const validStatuses = ['open', 'in-progress', 'completed', 'blocked', 'deleted', 'input-needed'];
        const statuses = options.status.split(',').map(s => s.trim());
        for (const s of statuses) {
          const normalized = s.replace(/_/g, '-');
          if (!validStatuses.includes(normalized)) {
            output.error(`Invalid status value: ${s}. Valid values: ${validStatuses.join(', ')}`, { success: false, error: 'invalid-arg' });
            process.exit(1);
          }
        }
        query.status = statuses.map(s => s.replace(/_/g, '-') as WorkItemStatus);
      }
      if (options.priority) query.priority = options.priority as WorkItemPriority;
      if (options.parent) {
        const normalizedParentId = utils.normalizeCliId(options.parent, options.prefix) || options.parent;
        const parent = db.get(normalizedParentId);
        if (!parent) {
          output.error(`Work item not found: ${normalizedParentId}`, { success: false, error: `Work item not found: ${normalizedParentId}` });
          process.exit(1);
        }
        query.parentId = normalizedParentId;
      }
      
      if (options.tags) {
        query.tags = options.tags.split(',').map((t: string) => t.trim());
      }
      if (options.assignee) query.assignee = options.assignee;
      if (options.stage) query.stage = options.stage;
      if (options.needsProducerReview !== undefined) {
        if (options.needsProducerReview === true) {
          query.needsProducerReview = true;
        } else {
          // Accept common boolean-like CLI values
          const raw = String(options.needsProducerReview).toLowerCase();
          const truthy = ['true', 'yes', '1', ''];
          const falsy = ['false', 'no', '0'];
          if (truthy.includes(raw)) query.needsProducerReview = true;
          else if (falsy.includes(raw)) query.needsProducerReview = false;
          else {
            output.error(`Invalid value for --needs-producer-review: ${options.needsProducerReview}`, { success: false, error: 'invalid-arg' });
            process.exit(1);
          }
        }
      }
      
      let items = db.list(query);

      // Apply --number/-n limit when provided (only for human or JSON output)
      const numRequested = options.number ? parseInt(options.number as any, 10) : NaN;
      const limit = Number.isNaN(numRequested) || numRequested < 1 ? undefined : numRequested;

      // By default hide completed items for human-readable output only.
      // When JSON mode is requested return all matching items so callers
      // can decide how to handle completed items programmatically.
      // When an explicit --stage filter is provided, skip this exclusion so
      // that stages commonly associated with completed status (e.g.
      // "in_review", "done") are not silently dropped from human output.
      if (!options.status && !options.stage && !utils.isJsonMode()) {
        items = items.filter(item => item.status !== 'completed');
      }

      // By default exclude deleted items from results unless the user explicitly
      // requests them via the `--deleted` switch. The intent is that deleted
      // items are not part of normal workflows and must be opt-in even for
      // machine-readable (JSON) outputs.
      const includeDeleted = Boolean(options.deleted);
      if (!includeDeleted) {
        items = items.filter(item => item.status !== 'deleted');
      }

      if (search) {
        const lower = String(search).toLowerCase();
        items = items.filter(item => {
          const idMatch = item.id && item.id.toLowerCase().includes(lower);
          const titleMatch = item.title && item.title.toLowerCase().includes(lower);
          const descMatch = item.description && item.description.toLowerCase().includes(lower);
          return Boolean(idMatch || titleMatch || descMatch);
        });
      }
      
      // Sort then apply limit so we return the intended order
      const allowedIds = new Set(items.map(item => item.id));
      const orderedItems = db.getAllOrderedByHierarchySortIndex().filter(item => allowedIds.has(item.id));
      const positions = new Map(orderedItems.map((item, index) => [item.id, index]));
      const sortedAll = items.slice().sort((a, b) => {
        const aPos = positions.get(a.id);
        const bPos = positions.get(b.id);
        if (aPos === undefined && bPos === undefined) {
          return sortByPriorityAndDate(a, b);
        }
        if (aPos === undefined) return 1;
        if (bPos === undefined) return -1;
        if (aPos !== bPos) return aPos - bPos;
        return sortByPriorityAndDate(a, b);
      });
      const limited = limit ? sortedAll.slice(0, limit) : sortedAll;

      if (utils.isJsonMode()) {
        // Enrich each work item with audit result data from the dedicated table.
        // This is needed so consumers (e.g. Pi TUI extension) can show the
        // correct audit icon (✅/❌/❓) without an extra round-trip per item.
        // Build a lookup map from all audit results for efficiency with large lists.
        const auditMap = new Map<string, boolean>();
        const allAudits = db.getAllAuditResults();
        for (const ar of allAudits) {
          auditMap.set(ar.workItemId, ar.readyToClose);
        }
        const enrichedItems = limited.map(item => ({
          ...item,
          auditResult: auditMap.has(item.id) ? auditMap.get(item.id) : null,
        }));
        output.json({ success: true, count: enrichedItems.length, workItems: enrichedItems });
      } else {
        if (items.length === 0) {
          console.log('No work items found');
          return;
        }

        const displayItems = limited;
        console.log(`Found ${displayItems.length} work item(s):\n`);
        const format = resolveFormat(program);
        if (format.toLowerCase() === 'concise') {
          console.log('');
          // Use the shared renderer so `list` and `show` produce identical concise output.
          // The human formatter's concise mode now includes the additional fields
          // (Status, Priority, Risk, Effort, Assignee, Tags) so this preserves
          // the richer information previously shown by the legacy tree printer.
          displayItemTreeWithFormat(displayItems, db, format);
          console.log('');
          return;
        }

        const sortedItems = displayItems;
        console.log('');
        sortedItems.forEach((item, index) => {
          console.log(humanFormatWorkItem(item, null, format));
          if (index < sortedItems.length - 1) console.log('');
        });
        console.log('');
      }
    });
}
