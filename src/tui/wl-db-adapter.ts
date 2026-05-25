/**
 * WlDbAdapter — bridges the existing db interface to the wl CLI.
 *
 * The TUI controller previously accessed the SQLite database directly via
 * `db.list()`, `db.get()`, `db.create()`, and `db.update()`.  All of these
 * calls are now routed through the `wl` CLI (via `runWlCommandSync`)
 * so the TUI performs zero direct database access.
 *
 * This adapter preserves the original method signatures so controller.ts
 * can be migrated with minimal code changes.
 *
 * NOTE: The methods below are synchronous wrappers that execute `wl` CLI
 * commands synchronously via the integration layer's `runWlCommandSync`.
 * The async `runWlCommand` path is used by the TUI for interactive flows;
 * this sync variant is used here because the controller calls db methods
 * synchronously.
 */

import { runWlCommandSync } from '../wl-integration/spawn.js';

/**
 * Minimal work-item shape matching what the controller expects.
 */
export interface WorkItem {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  sortIndex: number;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  assignee: string;
  stage: string;
  issueType: string;
  createdBy: string;
  deletedBy: string;
  deleteReason: string;
  risk: string;
  effort: string;
  needsProducerReview?: boolean;
  [key: string]: unknown;
}

/**
 * Comment shape for createComment / getCommentsForWorkItem.
 */
export interface WorkItemComment {
  id: string;
  workItemId: string;
  comment: string;
  author: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface WlDbInterface {
  list(query: Record<string, unknown>): WorkItem[];
  get(id: string): WorkItem | null;
  create(item: Partial<WorkItem>): WorkItem | null;
  update(id: string, updates: Record<string, unknown>): WorkItem | null;
  getPrefix?(): string | undefined;
  getCommentsForWorkItem(workItemId: string): WorkItemComment[];
  createComment(params: { workItemId: string; comment: string; author: string }): WorkItemComment | null;
  // DelegateDb compatibility methods
  getAll(): WorkItem[];
  getAllComments(): WorkItemComment[];
  getChildren(parentId: string): WorkItem[];
  upsertItems(items: WorkItem[]): void;
}

/**
 * Run a wl command synchronously via the integration layer and return
 * parsed JSON, or null on failure.
 */
function wlJsonSync(cmd: string, args: string[] = []): any {
  const result = runWlCommandSync([cmd, ...args, '--json']);
  if (result.error || !result.json) {
    return null;
  }
  return result.json;
}

/**
 * Convert a raw work-item record from wl to our WorkItem interface.
 */
function toWorkItem(raw: any): WorkItem {
  return {
    id: raw.id ?? '',
    title: raw.title ?? '',
    description: raw.description ?? '',
    status: raw.status ?? '',
    priority: raw.priority ?? '',
    sortIndex: Number(raw.sortIndex ?? 0),
    parentId: raw.parentId ?? null,
    createdAt: raw.createdAt ?? '',
    updatedAt: raw.updatedAt ?? '',
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    assignee: raw.assignee ?? '',
    stage: raw.stage ?? '',
    issueType: raw.issueType ?? '',
    createdBy: raw.createdBy ?? '',
    deletedBy: raw.deletedBy ?? '',
    deleteReason: raw.deleteReason ?? '',
    risk: raw.risk ?? '',
    effort: raw.effort ?? '',
    needsProducerReview: raw.needsProducerReview ?? false,
  };
}

function extractWorkItem(result: any): any | null {
  if (!result) return null;
  if (Array.isArray(result)) return result[0] ?? null;
  return result.workItem ?? result.workItems?.[0] ?? result.item ?? result;
}

function extractWorkItems(result: any): any[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.workItems)) return result.workItems;
  if (result.workItem) return [result.workItem];
  return [];
}

function extractComments(result: any): any[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.comments)) return result.comments;
  if (result.comment) return [result.comment];
  return [];
}

/**
 * Build the query arguments for `wl list --json` from a JS query object.
 */
function buildListArgs(query: Record<string, unknown>): string[] {
  const args: string[] = [];
  // Map common query fields to wl list flags
  if (query.status) {
    const raw = Array.isArray(query.status) ? (query.status as string[]).join(',') : String(query.status);
    args.push('--status', raw);
  }
  if (query.inProgress === true) {
    args.push('--in-progress');
  }
  if (query.priority) {
    args.push('--priority', String(query.priority));
  }
  if (query.stage) {
    args.push('--stage', String(query.stage));
  }
  if (query.assignee) {
    args.push('--assignee', String(query.assignee));
  }
  if (query.search) {
    args.push('--search', String(query.search));
  }
  if (query.all) {
    args.push('--all');
  }
  return args;
}

/**
 * Build the arguments for `wl update --json` from an updates object.
 */
function buildUpdateArgs(id: string, updates: Record<string, unknown>): string[] {
  const args: string[] = [id];
  if (updates.status) args.push('--status', String(updates.status));
  if (updates.priority) args.push('--priority', String(updates.priority));
  if (updates.stage) args.push('--stage', String(updates.stage));
  if (updates.parentId !== undefined) {
    if (updates.parentId === null) {
      args.push('--no-parent');
    } else {
      args.push('--parent', String(updates.parentId));
    }
  }
  if (updates.sortIndex !== undefined) {
    args.push('--sort-index', String(updates.sortIndex));
  }
  if (updates.tags !== undefined) {
    // Tags need special handling - build comma-separated or use multiple --tags flags
    const tags = Array.isArray(updates.tags) ? updates.tags : [updates.tags];
    tags.forEach((t: string) => args.push('--tag', t));
  }
  if (updates.needsProducerReview !== undefined) {
    args.push('--reviewed', String(updates.needsProducerReview).toLowerCase());
  }
  return args;
}

/**
 * Build the arguments for `wl create --json` from a work item object.
 */
function buildCreateArgs(item: Partial<WorkItem>): string[] {
  const args: string[] = ['-t', String(item.title ?? '')];
  if (item.description) args.push('-d', item.description);
  if (item.issueType) args.push('--issue-type', item.issueType);
  if (item.priority) args.push('--priority', item.priority);
  if (item.status) args.push('--status', item.status);
  if (item.parentId) args.push('-P', item.parentId);
  return args;
}

/**
 * Create a WlDbAdapter instance that routes all operations through wl CLI.
 */
export function createWlDbAdapter(): WlDbInterface {
  return {
    list(query: Record<string, unknown> = {}): WorkItem[] {
      const args = buildListArgs(query);
      const result = wlJsonSync('list', args);
      return extractWorkItems(result).map(toWorkItem);
    },

    get(id: string): WorkItem | null {
      const result = wlJsonSync('show', [id]);
      const item = extractWorkItem(result);
      return item ? toWorkItem(item) : null;
    },

    create(item: Partial<WorkItem>): WorkItem | null {
      const args = buildCreateArgs(item);
      const result = wlJsonSync('create', args);
      const created = extractWorkItem(result);
      return created ? toWorkItem(created) : null;
    },

    update(id: string, updates: Record<string, unknown>): WorkItem | null {
      const args = buildUpdateArgs(id, updates);
      const result = wlJsonSync('update', args);
      const updated = extractWorkItem(result);
      return updated ? toWorkItem(updated) : null;
    },

    getPrefix(): string | undefined {
      // The wl CLI doesn't expose a prefix concept directly.
      // Return undefined to match the previous default behavior.
      return undefined;
    },

    getCommentsForWorkItem(workItemId: string): WorkItemComment[] {
      const result = wlJsonSync('comment', ['list', workItemId]);
      const comments = extractComments(result);
      if (comments.length === 0) return [];
      return comments.map((c: any) => ({
        id: c.id ?? '',
        workItemId,
        comment: c.comment ?? c.body ?? '',
        author: c.author ?? c.by ?? '',
        createdAt: c.createdAt ?? c.created_at ?? '',
      }));
    },

    createComment(params: { workItemId: string; comment: string; author: string }): WorkItemComment | null {
      const result = wlJsonSync('comment', ['add', params.workItemId, '-c', params.comment, '-a', params.author]);
      const comment = extractComments(result)[0];
      if (!comment) return null;
      return {
        id: comment.id ?? '',
        workItemId: params.workItemId,
        comment: comment.comment ?? comment.body ?? params.comment,
        author: comment.author ?? params.author,
        createdAt: comment.createdAt ?? comment.created_at ?? new Date().toISOString(),
      };
    },

    // DelegateDb compatibility methods
    getAll(): WorkItem[] {
      // Get all items using wl list with no filters
      const result = wlJsonSync('list', ['--all']);
      return extractWorkItems(result).map(toWorkItem);
    },

    getAllComments(): WorkItemComment[] {
      // Get all comments by listing all items and fetching their comments
      const items = this.getAll();
      const allComments: WorkItemComment[] = [];
      for (const item of items) {
        const comments = this.getCommentsForWorkItem(item.id);
        allComments.push(...comments);
      }
      return allComments;
    },

    getChildren(parentId: string): WorkItem[] {
      // Use wl list --parent to get direct children
      const result = wlJsonSync('list', ['--parent', parentId]);
      return extractWorkItems(result).map(toWorkItem);
    },

    upsertItems(items: WorkItem[]): void {
      // Update each item via the update CLI command
      for (const item of items) {
        // Build updates from the item's fields (excluding id which identifies the item)
        const updates: Record<string, unknown> = {};
        if (item.status) updates.status = item.status;
        if (item.stage) updates.stage = item.stage;
        if (item.priority) updates.priority = item.priority;
        if (item.parentId !== undefined) updates.parentId = item.parentId;
        if (item.tags !== undefined) updates.tags = item.tags;
        if (item.assignee) updates.assignee = item.assignee;
        if (updates.status || updates.stage || updates.priority || updates.parentId !== undefined || updates.tags || updates.assignee) {
          this.update(item.id, updates);
        }
      }
    },
  };
}
