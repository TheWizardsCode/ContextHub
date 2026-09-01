/**
 * pickFields — field-selective projection helper.
 *
 * Projects a work-item object down to only the requested fields, with
 * validation against a known field whitelist. The `id` field is **always**
 * included (even if not requested) so consumers never lose the primary key.
 *
 * Valid field names:
 *   id, title, description, status, stage, priority, issueType,
 *   assignee, tags, createdAt, updatedAt, parentId,
 *   needsProducerReview, sortIndex
 *
 * Usage:
 *   const compact = pickFields(fullItem, ['id', 'title', 'status']);
 *   const full   = pickFields(fullItem);               // returns item as-is
 *
 * @param item  — the source work-item object
 * @param fields — array of field names to include (undefined = return full item)
 * @returns a new object containing only the requested fields (+ id)
 * @throws   when an unknown field name is encountered
 */

import type { WorkItem } from './types.js';

/**
 * Whitelist of field names that may be requested via --fields.
 * This list is the single source of truth for CLI --fields validation.
 */
export const VALID_FIELDS = [
  'id',
  'title',
  'description',
  'status',
  'stage',
  'priority',
  'issueType',
  'assignee',
  'tags',
  'createdAt',
  'updatedAt',
  'parentId',
  'needsProducerReview',
  'sortIndex',
] as const;

/**
 * Project an item to only the requested fields.
 *
 * @param item      — any object shaped like a WorkItem
 * @param fields    — list of field names to keep; `undefined` returns the full item
 * @returns a new object with only the projected fields
 * @throws {Error} — when an unknown field name is provided
 */
export function pickFields(
  item: WorkItem,
  fields?: readonly string[]
): Record<string, unknown> {
  // No fields specified → return the original item unchanged.
  if (fields === undefined || fields === null) {
    return item as unknown as Record<string, unknown>;
  }

  const fieldSet = new Set<string>(fields);

  // Validate: reject unknown field names.
  const unknown = fields.filter((f) => !VALID_FIELDS.includes(f as (typeof VALID_FIELDS)[number]));
  if (unknown.length > 0) {
    const validList = VALID_FIELDS.join(', ');
    throw new Error(
      `Unknown fields: ${unknown.join(', ')}. Valid fields: ${validList}`
    );
  }

  // Guarantee that `id` is always included.
  if (!fieldSet.has('id')) {
    fieldSet.add('id');
  }

  // Project: build a new object with only the selected fields.
  const result: Record<string, unknown> = {};
  for (const key of VALID_FIELDS) {
    if (fieldSet.has(key) && key in item) {
      result[key] = item[key];
    }
  }

  return result;
}
