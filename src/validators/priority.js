export const CANONICAL_PRIORITIES = ['critical', 'high', 'medium', 'low'];
export const PRIORITY_MAP = {
    P0: 'critical',
    P1: 'high',
    P2: 'medium',
    P3: 'low',
};
const MAPPABLE_KEYS = new Set(Object.keys(PRIORITY_MAP));
function trimmed(raw) {
    if (!raw)
        return '';
    const t = raw.trim();
    return t;
}
export function normalizePriority(raw) {
    const t = trimmed(raw);
    if (!t)
        return null;
    const lower = t.toLowerCase();
    if (CANONICAL_PRIORITIES.includes(lower)) {
        return lower;
    }
    const upper = t.toUpperCase();
    if (MAPPABLE_KEYS.has(upper)) {
        return PRIORITY_MAP[upper];
    }
    return null;
}
export function isValidPriority(raw) {
    const t = trimmed(raw);
    if (!t)
        return false;
    const lower = t.toLowerCase();
    return CANONICAL_PRIORITIES.includes(lower);
}
export function isMappablePriority(raw) {
    const t = trimmed(raw);
    if (!t)
        return false;
    const upper = t.toUpperCase();
    return MAPPABLE_KEYS.has(upper);
}
//# sourceMappingURL=priority.js.map