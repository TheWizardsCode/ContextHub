import type { WorkItemPriority } from '../types.js';

export const CANONICAL_PRIORITIES: readonly WorkItemPriority[] = ['critical', 'high', 'medium', 'low'];

export const PRIORITY_MAP: Record<string, WorkItemPriority> = {
  P0: 'critical',
  P1: 'high',
  P2: 'medium',
  P3: 'low',
};

const MAPPABLE_KEYS = new Set(Object.keys(PRIORITY_MAP));

function trimmed(raw: string): string {
  if (!raw) return '';
  const t = raw.trim();
  return t;
}

export function normalizePriority(raw: string): WorkItemPriority | null {
  const t = trimmed(raw);
  if (!t) return null;

  const lower = t.toLowerCase() as string;
  if (CANONICAL_PRIORITIES.includes(lower as WorkItemPriority)) {
    return lower as WorkItemPriority;
  }

  const upper = t.toUpperCase();
  if (MAPPABLE_KEYS.has(upper)) {
    return PRIORITY_MAP[upper];
  }

  return null;
}

export function isValidPriority(raw: string): boolean {
  const t = trimmed(raw);
  if (!t) return false;
  const lower = t.toLowerCase();
  return CANONICAL_PRIORITIES.includes(lower as WorkItemPriority);
}

export function isMappablePriority(raw: string): boolean {
  const t = trimmed(raw);
  if (!t) return false;
  const upper = t.toUpperCase();
  return MAPPABLE_KEYS.has(upper);
}
