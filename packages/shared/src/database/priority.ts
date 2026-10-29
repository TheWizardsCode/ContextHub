/**
 * packages/shared/src/database/priority.ts — priority, risk/effort ordinals and
 * effective-priority inheritance for the `wl next` selection pipeline.
 *
 * Parent: WL-0MVGKGHNR0019OLT (decompose the `database.ts` god class).
 * Slice: WL-0MVOBP0U5007BAZD (extract the `wl next` selection pipeline).
 *
 * ## Responsibility
 *
 * Turn declared priority/risk/effort values into comparable ordinals, and
 * compute the *effective* priority used for tie-breaking in candidate
 * selection: an item's own priority, raised to the priority of any active
 * item that depends on it (transparent priority inheritance). An item that
 * blocks a critical task is elevated to critical effective priority.
 *
 * ## Boundary
 *
 * **Belongs here.** `getPriorityValue`, `riskOrdinal`, `effortOrdinal`,
 * `matchesRiskEffort` and `computeEffectivePriority` as pure functions. They
 * touch no mutable state: only read-only `WorklogDatabaseContext` store reads
 * and the `SelectionHooks.isInProgressSubtree` predicate.
 *
 * **Does NOT belong here.** Candidate filtering, blocker surfacing, critical
 * escalation and final selection — those live in `next-pipeline.ts` and
 * `critical-escalation.ts`. No writing to the store, no output, no knowledge
 * of the `WorklogDatabase` façade.
 *
 * `WorklogDatabase` keeps a thin delegating member per function so the façade
 * surface is unchanged (parent AC — public API untouched).
 */

import { WorkItem } from '../types.js';
import {
  EdgeCache,
  SelectionHooks,
  WorklogDatabaseContext,
} from './context.js';
/**
 * Ordinal rank of a risk level on the canonical scale
 * (Low < Medium < High < Severe/Critical). Both the type-level spelling
 * ('Severe') and the icon-scale spelling ('critical') map to the top
 * rank. Agents may produce verbose risk fields like "Medium — NVIDIA
 * driver changes…"; extract the leading keyword before any delimiter.
 * Unset/unknown values map to null (fail-closed: they are never
 * matched by an at-most risk filter).
 */
export function riskOrdinal(risk: string | undefined | null): number | null {
  // Extract the leading keyword before any delimiter (—, -, :, whitespace).
  const normalized = (risk ?? '').trim().toLowerCase().split(/[-:–—\s]+/)[0];
  switch (normalized) {
    case 'low': return 1;
    case 'medium': return 2;
    case 'high': return 3;
    case 'severe':
    case 'critical': return 4;
    default: return null;
  }
}

/**
 * Ordinal rank of an effort level on the canonical scale
 * (Extra Small < Small < Medium < Large < Extra Large). Accepts both the
 * short CLI spellings (XS/S/M/L/XL) and the long-form effort-and-risk
 * skill spellings (extra small/small/medium/large/extra large),
 * normalized case-insensitively. Agents may produce verbose effort fields
 * like "1–4 hours — Small. Diagnostic investigation…"; extract the
 * keyword via exact match on stripped string first, then fall back to
 * word-boundary search.
 * Unset/unknown values map to null (fail-closed: they are never matched
 * by an at-most effort filter).
 */
export function effortOrdinal(effort: string | undefined | null): number | null {
  const normalized = (effort ?? '').trim().toLowerCase();
  // Try exact match on stripped version first (simple cases: "small", "medium",
  // "Extra Small" → "extrasmall"). If that fails, fall back to searching for
  // the keyword anywhere in the string — agents produce verbose fields like
  // "1–4 hours — Small. Diagnostic investigation…" (keyword after the dash).
  const stripped = normalized.replace(/[\s-]+/g, '');
  switch (stripped) {
    case 'xs':
    case 'extrasmall': return 1;
    case 's':
    case 'small': return 2;
    case 'm':
    case 'medium': return 3;
    case 'l':
    case 'large': return 4;
    case 'xl':
    case 'extralarge': return 5;
    default:
      // Fallback: search for the keyword bounded by non-word characters.
      // Checked in order of specificity (longest first) so "small" wins over "s".
      if (/(?:^|\W)extrasmall(?:\W|$)/.test(normalized)) return 1;
      if (/(?:^|\W)xs(?:\W|$)/.test(normalized)) return 1;
      if (/(?:^|\W)small(?:\W|$)/.test(normalized)) return 2;
      if (/(?:^|\W)s(?:\W|$)/.test(normalized)) return 2;
      if (/(?:^|\W)extralarge(?:\W|$)/.test(normalized)) return 5;
      if (/(?:^|\W)large(?:\W|$)/.test(normalized)) return 4;
      if (/(?:^|\W)xl(?:\W|$)/.test(normalized)) return 5;
      if (/(?:^|\W)l(?:\W|$)/.test(normalized)) return 4;
      if (/(?:^|\W)m(?:\W|$)/.test(normalized)) return 3;
      if (/(?:^|\W)medium(?:\W|$)/.test(normalized)) return 3;
      return null;
  }
}

/**
 * True when an item satisfies the optional at-most risk/effort filters.
 * Fail-closed: an unset/unknown risk or effort on the item (or an invalid
 * filter level) never matches.
 */
export function matchesRiskEffort(item: WorkItem, risk?: string, effort?: string): boolean {
  if (risk !== undefined && risk !== '') {
    const level = riskOrdinal(risk);
    const ord = riskOrdinal(item.risk);
    if (level === null || ord === null || ord > level) return false;
  }
  if (effort !== undefined && effort !== '') {
    const level = effortOrdinal(effort);
    const ord = effortOrdinal(item.effort);
    if (level === null || ord === null || ord > level) return false;
  }
  return true;
}

/**
 * Get numeric priority value for comparisons
 */
export function getPriorityValue(priority?: string): number {
  const priorityOrder: { [key: string]: number } = {
    'critical': 4,
    'high': 3,
    'medium': 2,
    'low': 1,
  };

  if (!priority) return 0;
  return priorityOrder[priority] ?? 0;
}

/**
 * Compute the effective priority of a candidate work item.
 *
 * Effective priority is the maximum of:
 *   - The item's own priority
 *   - The priority of any active (non-completed, non-deleted) item that
 *     depends on this item (i.e., this item is a prerequisite for)
 *
 * This implements transparent, deterministic priority inheritance:
 * an item that blocks a critical task is elevated to critical effective
 * priority for tie-breaking in sortIndex selection.
 *
 * Results are cached in the optional `cache` map to avoid redundant
 * dependency lookups across a candidate pool.
 *
 * @returns Object with numeric value, human-readable reason, and optional
 *          inheritedFrom item ID
 */
export function computeEffectivePriority(
  ctx: WorklogDatabaseContext,
  hooks: SelectionHooks,
  item: WorkItem,
  cache?: Map<string, { value: number; reason: string; inheritedFrom?: string }>,
  edgeCache?: EdgeCache,
  items?: WorkItem[]
): { value: number; reason: string; inheritedFrom?: string } {
  // Check cache first
  if (cache) {
    const cached = cache.get(item.id);
    if (cached) return cached;
  }

  const ownValue = getPriorityValue(item.priority);
  let maxInheritedValue = 0;
  let inheritedFromId: string | undefined;
  let inheritedFromPriority: string | undefined;

  // Check inbound dependency edges: items that depend on this item
  const inboundEdges = edgeCache
    ? (edgeCache.inbound.get(item.id) ?? [])
    : ctx.store.getDependencyEdgesTo(item.id);
  for (const edge of inboundEdges) {
    const dependent = edgeCache
      ? (edgeCache.itemsById.get(edge.fromId) ?? null)
      : ctx.store.getWorkItem(edge.fromId);
    if (!dependent) continue;
    // Only inherit from active items (not completed or deleted)
    if (dependent.status === 'completed' || dependent.status === 'deleted') continue;
    // Skip dependents that are in an in-progress parent subtree —
    // children of in-progress parents must not influence priority
    // inheritance for their blockers, as they should be invisible to
    // the selection algorithm.
    if (items && hooks.isInProgressSubtree(dependent, items)) continue;
    const depValue = getPriorityValue(dependent.priority);
    if (depValue > maxInheritedValue) {
      maxInheritedValue = depValue;
      inheritedFromId = dependent.id;
      inheritedFromPriority = dependent.priority;
    }
  }

  // Also check if this item is a child that implicitly blocks its parent
  if (item.parentId) {
    const parent = edgeCache
      ? (edgeCache.itemsById.get(item.parentId) ?? null)
      : ctx.store.getWorkItem(item.parentId);
    if (parent && parent.status !== 'completed' && parent.status !== 'deleted') {
      // A non-closed child blocks its parent — inherit parent's priority
      const parentValue = getPriorityValue(parent.priority);
      if (parentValue > maxInheritedValue) {
        maxInheritedValue = parentValue;
        inheritedFromId = parent.id;
        inheritedFromPriority = parent.priority;
      }
    }
  }

  const effectiveValue = Math.max(ownValue, maxInheritedValue);

  let result: { value: number; reason: string; inheritedFrom?: string };
  if (effectiveValue > ownValue && inheritedFromId) {
    result = {
      value: effectiveValue,
      reason: `effective priority: ${inheritedFromPriority}, inherited from ${inheritedFromId}`,
      inheritedFrom: inheritedFromId,
    };
  } else {
    result = {
      value: ownValue,
      reason: `own priority: ${item.priority || 'none'}`,
    };
  }

  // Cache the result
  if (cache) {
    cache.set(item.id, result);
  }

  return result;
}
