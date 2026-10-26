/**
 * packages/shared/src/database/context.ts — shared types and helpers for the
 * `database.ts` decomposition.
 *
 * This module is the **single source of truth** for plumbing every extracted
 * module needs: the database context, the edge cache, the children map, id
 * generation, prefix accessors, and timestamp comparison.
 *
 * ## Responsibility boundary
 *
 * **Belongs here.** Pure functions / plain types operating on a
 * `WorklogDatabaseContext`:
 *
 * - `EdgeCache` type and its `childrenByParent` map.
 * - `buildChildrenByParent` — parent → direct children mapping.
 * - `laterTimestamp` — deterministic "later of two timestamps".
 * - `UNIQUE_*` constants and `generateUniqueId` / `generateId` /
 *   `generateCommentId`.
 * - `getPrefix` / `setPrefix` — prefix accessor helpers.
 *
 * **Does NOT belong here.** Anything that is specific to a single concern or
 * requires the full `WorklogDatabase` class:
 *
 * - `WorklogDatabase` itself (the façade / concern orchestrator).
 * - SQL queries, schema definitions, FTS setup.
 * - JSONL import/export, Git sync operations.
 * - Audit result management.
 * - Search / semantic search / embedders.
 * - Dirty-tracking, auto-sync, and lock management.
 *
 * Every extracted module may import this module (it is the acyclic root of the
 * extracted-module import graph). No extracted module should import the
 * `database.ts` façade.
 */

import { randomBytes } from 'crypto';
import { WorkItem, DependencyEdge } from '../types.js';
import { SqlitePersistentStore } from '../persistent-store.js';

// ── Context shape ─────────────────────────────────────────────────────

/**
 * Shared state passed to every extracted-module helper.
 *
 * Built once in the `WorklogDatabase` constructor; read-only for helpers
 * except for the mutable `idSequence` fields used by id generation.
 */
export interface WorklogDatabaseContext {
  /** The persistent store backing this database instance. */
  store: SqlitePersistentStore;
  /** The work-item ID prefix (e.g. `'WI'`, `'WL'`). */
  prefix: string;
  /** Optional file-locking and other services. */
  services: {
    fileLock?: {
      getLockPathForJsonl?: (jsonlPath: string) => string;
    };
    jsonl?: {
      getDefaultDataPath?: () => string;
    };
    persistentStoreServices?: any;
    cacheOptions?: any;
  };
  /** When true, suppress console/debug output. */
  silent: boolean;
  /** Mutable state for `generateUniqueId` — advances on every call. */
  _lastIdTime: number;
  _idSequence: number;
}

// ── Edge cache type (shared across helpers) ───────────────────────────

/**
 * Pre-loaded cache of dependency edges and work items to eliminate N+1 queries
 * during the `wl next` selection pipeline.
 */
export interface EdgeCache {
  /** inbound dependency edges: toId → edges[] (items that depend on this item) */
  inbound: Map<string, DependencyEdge[]>;
  /** outbound dependency edges: fromId → edges[] (items this item depends on) */
  outbound: Map<string, DependencyEdge[]>;
  /** All work items indexed by id for O(1) lookup */
  itemsById: Map<string, WorkItem>;
  /**
   * Children of each parentId (including non-closed children).
   * Built once from loaded items to avoid per-item SQL queries.
   */
  childrenByParent: Map<string, WorkItem[]>;
}

// ── Helper functions ──────────────────────────────────────────────────

/**
 * Return the later of two ISO-8601 timestamps (undefined/null-safe).
 *
 * Used to preserve comment activity stamps when a peer snapshot carries an
 * older `activityAt` than the local database (comment-only writes do not move
 * `updatedAt`, so sync cannot rely on it to carry activity —
 * WL-0MUBVH6JM0093KVM).
 */
export function laterTimestamp(
  a?: string | null,
  b?: string | null,
): string | undefined {
  if (!a) return b ?? undefined;
  if (!b) return a;
  return a >= b ? a : b;
}

/**
 * Build a map of parentId → direct children from a list of work items.
 */
export function buildChildrenByParent(
  items: WorkItem[],
): Map<string, WorkItem[]> {
  const map = new Map<string, WorkItem[]>();
  for (const item of items) {
    if (item.parentId) {
      let list = map.get(item.parentId);
      if (!list) {
        list = [];
        map.set(item.parentId, list);
      }
      list.push(item);
    }
  }
  return map;
}

/**
 * Normalize a title into a canonical dedup-comparison key: case-folded with
 * ALL whitespace removed (tabs/newlines collapse away too). `"Same Title"`,
 * `"same  title"` and `" same\ttitle "` all normalize to `"sametitle"` so
 * retried create commands with cosmetic title differences still match
 * (WL-0MSTNG2QF0049B97). The SQL side of `getRecentDuplicate` applies the
 * same transformation to stored titles.
 */
export function normalizeTitleForMatch(title: string): string {
  return title.replace(/\s+/g, '').toLowerCase();
}

// ── Unique ID constants & generators ──────────────────────────────────

const UNIQUE_TIME_LENGTH = 9;
const UNIQUE_SEQUENCE_LENGTH = 2;
const UNIQUE_RANDOM_BYTES = 3;
const UNIQUE_RANDOM_LENGTH = 5;
export const UNIQUE_ID_LENGTH = UNIQUE_TIME_LENGTH + UNIQUE_SEQUENCE_LENGTH + UNIQUE_RANDOM_LENGTH;
const MAX_ID_GENERATION_ATTEMPTS = 10;

/**
 * Generate a globally unique, human-readable identifier component.
 * Uses a sequence counter to ensure deterministic ordering when multiple
 * IDs are generated within the same millisecond.
 *
 * @param ctx — the shared context holding mutable sequence state.
 * @returns the unique component (not prefixed).
 */
export function generateUniqueId(ctx: WorklogDatabaseContext): string {
  const now = Date.now();
  if (now !== ctx._lastIdTime) {
    ctx._lastIdTime = now;
    ctx._idSequence = 0;
  } else {
    ctx._idSequence++;
  }
  const timeRaw = now.toString(36).toUpperCase();
  if (timeRaw.length > UNIQUE_TIME_LENGTH) {
    throw new Error('Timestamp overflow while generating unique ID');
  }
  const timePart = timeRaw.padStart(UNIQUE_TIME_LENGTH, '0');
  const randomBytesValue = randomBytes(UNIQUE_RANDOM_BYTES);
  const randomNumber = randomBytesValue.readUIntBE(0, UNIQUE_RANDOM_BYTES);
  const randomPart = randomNumber.toString(36).toUpperCase().padStart(UNIQUE_RANDOM_LENGTH, '0');
  const sequencePart = ctx._idSequence.toString(36).toUpperCase().padStart(UNIQUE_SEQUENCE_LENGTH, '0');
  const id = `${timePart}${sequencePart}${randomPart}`;
  if (id.length !== UNIQUE_ID_LENGTH) {
    throw new Error('Generated unique ID has unexpected length');
  }
  return id;
}

/**
 * Generate a unique work item ID (with prefix + collision check).
 *
 * @param ctx — the shared context.
 * @returns a unique ID like `'WI-XXXXX'`.
 */
export function generateId(ctx: WorklogDatabaseContext): string {
  for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
    const id = `${ctx.prefix}-${generateUniqueId(ctx)}`;
    if (!ctx.store.getWorkItem(id)) {
      return id;
    }
  }
  throw new Error('Unable to generate a unique work item ID');
}

/**
 * Generate a unique comment ID (with prefix + collision check).
 *
 * @param ctx — the shared context.
 * @returns a unique ID like `'WI-CXXXXX'`.
 */
export function generateCommentId(ctx: WorklogDatabaseContext): string {
  for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
    const id = `${ctx.prefix}-C${generateUniqueId(ctx)}`;
    if (!ctx.store.getComment(id)) {
      return id;
    }
  }
  throw new Error('Unable to generate a unique comment ID');
}

// ── Prefix accessors (for helpers that need prefix manipulation) ──────

/** Get the prefix from context. */
export function getPrefix(ctx: WorklogDatabaseContext): string {
  return ctx.prefix;
}

/** Set the prefix on context. */
export function setPrefix(ctx: WorklogDatabaseContext, prefix: string): void {
  ctx.prefix = prefix;
}

// ── Edge cache builder ────────────────────────────────────────────────

/**
 * Build an EdgeCache from all dependency edges and work items.
 * Eliminates N+1 query patterns by loading all edges and items once
 * into in-memory Maps for O(1) lookups during computeScore() and
 * filterCandidates().
 *
 * @param ctx — the shared context.
 * @param items — Optional pre-loaded work items to avoid double-loading.
 * @returns the assembled EdgeCache.
 */
export function buildEdgeCache(
  ctx: WorklogDatabaseContext,
  items?: WorkItem[],
): EdgeCache {
  const allEdges = ctx.store.getAllDependencyEdges();
  const allItems = items ?? ctx.store.getAllWorkItems();

  const inbound = new Map<string, DependencyEdge[]>();
  const outbound = new Map<string, DependencyEdge[]>();
  const itemsById = new Map<string, WorkItem>();

  for (const edge of allEdges) {
    // outbound: fromId -> edges (items that depend on others)
    let fromList = outbound.get(edge.fromId);
    if (!fromList) {
      fromList = [];
      outbound.set(edge.fromId, fromList);
    }
    fromList.push(edge);

    // inbound: toId -> edges (items that are depended upon)
    let toList = inbound.get(edge.toId);
    if (!toList) {
      toList = [];
      inbound.set(edge.toId, toList);
    }
    toList.push(edge);
  }

  for (const item of allItems) {
    itemsById.set(item.id, item);
  }

  // Build childrenByParent map once to avoid per-item SQL queries
  const childrenByParent = buildChildrenByParent(allItems);

  return { inbound, outbound, itemsById, childrenByParent };
}
