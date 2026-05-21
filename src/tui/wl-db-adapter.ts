/**
 * WlDbAdapter — bridges the existing db interface to the wl CLI.
 *
 * The TUI controller previously accessed the SQLite database directly via
 * `db.list()`, `db.get()`, `db.create()`, and `db.update()`.  All of these
 * calls are now routed through the `wl` CLI (via `runWl`) so the TUI
 * performs zero direct database access.
 *
 * This adapter preserves the original method signatures so controller.ts
 * can be migrated with minimal code changes.
 */

import { runWl } from './wl-integration.js';

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
}

/**
 * Run a wl command and return parsed JSON, or null on failure.
 */
async function wlJson(cmd: string, args: string[] = []): Promise<any> {
  try {
    const result = await runWl(cmd, args, { timeout: 15000 });
    return result;
  } catch {
    return null;
  }
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

/**
 * Build the query arguments for `wl list --json` from a JS query object.
 */
function buildListArgs(query: Record<string, unknown>): string[] {
  const args: string[] = [];
  // Map common query fields to wl list flags
  if (query.status) {
    // Support array of statuses
    if (Array.isArray(query.status)) {
      query.status.forEach((s: string) => args.push('--status', s));
    } else {
      args.push('--status', String(query.status));
    }
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
    async list(query: Record<string, unknown> = {}): Promise<WorkItem[]> {
      const args = buildListArgs(query);
      const result = await wlJson('list', args);
      if (!result || !Array.isArray(result)) return [];
      return result.map(toWorkItem);
    },

    async get(id: string): Promise<WorkItem | null> {
      const result = await wlJson('show', [id]);
      if (!result) return null;
      return toWorkItem(result);
    },

    async create(item: Partial<WorkItem>): Promise<WorkItem | null> {
      const args = buildCreateArgs(item);
      const result = await wlJson('create', args);
      if (!result) return null;
      return toWorkItem(result);
    },

    async update(id: string, updates: Record<string, unknown>): Promise<WorkItem | null> {
      const args = buildUpdateArgs(id, updates);
      const result = await wlJson('update', args);
      if (!result) return null;
      return toWorkItem(result);
    },

    getPrefix(): string | undefined {
      // The wl CLI doesn't expose a prefix concept directly.
      // Return undefined to match the previous default behavior.
      return undefined;
    },

    async getCommentsForWorkItem(workItemId: string): Promise<WorkItemComment[]> {
      const result = await wlJson('comment', ['list', workItemId]);
      if (!result || !Array.isArray(result)) return [];
      return result.map((c: any) => ({
        id: c.id ?? '',
        workItemId,
        comment: c.comment ?? c.body ?? '',
        author: c.author ?? c.by ?? '',
        createdAt: c.createdAt ?? c.created_at ?? '',
      }));
    },

    async createComment(params: { workItemId: string; comment: string; author: string }): Promise<WorkItemComment | null> {
      const result = await wlJson('comment', ['add', params.workItemId, '-c', params.comment, '-a', params.author]);
      if (!result) return null;
      return {
        id: result.id ?? '',
        workItemId: params.workItemId,
        comment: result.comment ?? result.body ?? params.comment,
        author: result.author ?? params.author,
        createdAt: result.createdAt ?? result.created_at ?? new Date().toISOString(),
      };
    },
  };
}
