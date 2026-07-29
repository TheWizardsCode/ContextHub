/**
 * packages/herdr/src/icons.ts — Icon utilities for Herdr work item display
 *
 * Provides consistent icon rendering (emoji or text fallback) for work
 * item status, priority, stage, audit results, and metadata indicators.
 * Adapted from the main project src/icons.ts without Pi dependencies.
 */

// ── Options ───────────────────────────────────────────────────────────

export interface IconOptions {
  /** When true, use text fallback instead of emoji/icon glyph. */
  noIcons?: boolean;
}

// ── Icon maps ─────────────────────────────────────────────────────────

const STATUS_ICONS: Record<string, string> = {
  open:          '\u{1F513}',   // 🔓
  'in-progress': '\u{1F504}',  // 🔄
  completed:     '\u{2714}\u{FE0F}', // ✔️
  blocked:       '\u{26D4}',   // ⛔
  deleted:       '\u{1F5D1}\u{FE0F}', // 🗑️
  input_needed:  '\u{1F4AC}',  // 💬
};

const STATUS_FALLBACK: Record<string, string> = {
  open:          '[OPEN]',
  'in-progress': '[INPR]',
  completed:     '[DONE]',
  blocked:       '[BLKD]',
  deleted:       '[DEL ]',
  input_needed:  '[HELP]',
};

const STAGE_ICONS: Record<string, string> = {
  idea:             '\u{1F4A1}',           // 💡
  intake_complete:  '\u{1F4E5}',           // 📥
  plan_complete:    '\u{1F4CB}',           // 📋
  in_progress:      '\u{1F6E0}\u{FE0F}',  // 🛠️
  in_review:        '\u{1F50D}',           // 🔍
  completed:        '\u{2714}\u{FE0F}',   // ✔️
};

const STAGE_FALLBACK: Record<string, string> = {
  idea:             '[IDEA]',
  intake_complete:  '[INTAKE]',
  plan_complete:    '[PLAN]',
  in_progress:      '[IN PR]',
  in_review:        '[REVIEW]',
  completed:        '[DONE]',
};

const PRIORITY_ICONS: Record<string, string> = {
  critical: '\u{1F6A8}',  // 🚨
  high:     '\u{2B50}',   // ⭐
  medium:   '\u{1F4CB}',  // 📋
  low:      '\u{1F422}',  // 🐢
};

const PRIORITY_FALLBACK: Record<string, string> = {
  critical: '[CRIT]',
  high:     '[HIGH]',
  medium:   '[MED ]',
  low:      '[LOW ]',
};

const RISK_ICONS: Record<string, string> = {
  low:      '\u{1F7E2}',  // 🟢
  medium:   '\u{1F7E1}',  // 🟡
  high:     '\u{1F534}',  // 🔴
  critical: '\u{1F4A5}',  // 💥
};

const EFFORT_ICONS: Record<string, string> = {
  small:   '\u{1F539}',  // 🔹
  medium:  '\u{1F537}',  // 🔷
  large:   '\u{1F536}',  // 🔶
  xlarge:  '\u{1F4A0}',  // 💠
};

const EPIC_ICON = '\u{2299}';    // ⊙
const EPIC_FALLBACK = '[EPIC]';

const AUDIT_READY = '\u{2705}';      // ✅
const AUDIT_NOT_READY = '\u{274C}';  // ❌
const AUDIT_UNKNOWN = '\u{2753}';     // ❓

const AUDIT_STALE_PASSED = '\u{23F3}';  // ⏳
const AUDIT_STALE_FAILED = '\u{26A0}';   // ⚠️

const NEEDS_REVIEW_ICON = '\u{274C}';  // ❌
const REVIEW_DONE_ICON = '\u{2705}';    // ✅

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Check whether icons should be rendered.
 */
export function iconsEnabled(opts?: { noIcons?: boolean }): boolean {
  if (opts?.noIcons === true) return false;
  return true;
}

/**
 * Get the icon for a work item status.
 */
export function statusIcon(status: string, opts?: IconOptions): string {
  const key = (status || '').toLowerCase().replace(/_/g, '-');
  if (opts?.noIcons) {
    return STATUS_FALLBACK[key] || `[${key.toUpperCase()}]`;
  }
  return STATUS_ICONS[key] || '\u{2753}'; // ❓
}

/**
 * Get the icon for a work item stage.
 */
export function stageIcon(stage: string | undefined, opts?: IconOptions): string {
  const key = (stage || '').toLowerCase();
  if (opts?.noIcons) {
    return STAGE_FALLBACK[key] || `[${key.toUpperCase()}]`;
  }
  return STAGE_ICONS[key] || '\u{2753}';
}

/**
 * Get the icon for a work item priority.
 */
export function priorityIcon(priority: string | undefined, opts?: IconOptions): string {
  const key = (priority || '').toLowerCase().trim();
  if (opts?.noIcons) {
    return PRIORITY_FALLBACK[key] || '';
  }
  return PRIORITY_ICONS[key] || '';
}

/**
 * Get the audit icon based on audit result.
 * @param result - true = ready to close, false = not ready, null = unknown
 */
export function auditIcon(result: boolean | null | undefined, opts?: IconOptions): string {
  if (opts?.noIcons) {
    if (result === true) return '[ready]';
    if (result === false) return '[fail]';
    return '[?]';
  }
  if (result === true) return AUDIT_READY;
  if (result === false) return AUDIT_NOT_READY;
  return AUDIT_UNKNOWN;
}

/**
 * Get the stale audit icon.
 * @param result - true means the last audit passed, false/null means it didn't
 */
export function auditStaleIcon(result: boolean | null | undefined, opts?: IconOptions): string {
  if (opts?.noIcons) {
    return result === true ? '[stale ok]' : '[stale]';
  }
  if (result === true) return AUDIT_STALE_PASSED;
  return AUDIT_STALE_FAILED;
}

/**
 * Get the epic icon.
 */
export function epicIcon(opts?: IconOptions): string {
  if (opts?.noIcons) return EPIC_FALLBACK;
  return EPIC_ICON;
}

/**
 * Get the risk icon.
 */
export function riskIcon(risk: string | undefined, opts?: IconOptions): string {
  const key = (risk || '').toLowerCase().trim();
  if (!key) return '';
  if (opts?.noIcons) return `[${key.toUpperCase()}]`;
  return RISK_ICONS[key] || '';
}

/**
 * Get the effort icon.
 */
export function effortIcon(effort: string | undefined, opts?: IconOptions): string {
  const key = (effort || '').toLowerCase().trim();
  if (!key) return '';
  if (opts?.noIcons) return `[${key.toUpperCase()}]`;
  return EFFORT_ICONS[key] || '';
}

/**
 * Get the "needs producer review" icon.
 */
export function needsProducerReviewIcon(
  needsReview: boolean | undefined,
  opts?: IconOptions,
): string {
  if (needsReview === undefined) return '';
  if (opts?.noIcons) {
    return needsReview ? '[REVIEW]' : '[OK]';
  }
  return needsReview ? NEEDS_REVIEW_ICON : REVIEW_DONE_ICON;
}

// ── Audit freshness ───────────────────────────────────────────────────

/**
 * Determine whether an audit result is fresh (not stale) based on the
 * 60-second staleness buffer.
 */
export function isAuditFresh(
  auditedAt: string | null | undefined,
  updatedAt: string | undefined,
): boolean {
  if (!auditedAt || !updatedAt) return false;
  const auditTime = new Date(auditedAt).getTime();
  const updateTime = new Date(updatedAt).getTime();
  if (isNaN(auditTime) || isNaN(updateTime)) return false;
  return auditTime > updateTime - 60000;
}

// ── Stage colour ──────────────────────────────────────────────────────

/**
 * Map stage to ANSI 256-color code.
 */
export function stageColor(stage: string | undefined): number {
  const colors: Record<string, number> = {
    idea: 241,             // grey
    intake_complete: 68,   // blue-ish
    plan_complete: 172,    // orange-ish
    in_progress: 76,       // green-ish
    in_review: 220,        // yellow-ish
    completed: 33,         // cyan-ish
  };
  return colors[stage || ''] ?? 241;
}

/**
 * Apply stage colour to text using ANSI escape codes.
 */
export function applyStageColour(text: string, stage: string | undefined): string {
  const color = stageColor(stage);
  return `\x1b[38;5;${color}m${text}\x1b[0m`;
}

// ── Terminal display width helpers ────────────────────────────────────

/**
 * Estimate the terminal display width of a string (cells/columns).
 *
 * Accounts for:
 *   - Supplementary-plane characters (> U+FFFF): 2 cells
 *   - Emoticons/dingbats (U+2300-U+27BF, U+2934-U+2935, U+2B05-U+2B55,
 *     U+3030 etc.): 2 cells (modern terminals render these as emoji)
 *   - CJK fullwidth ranges: 2 cells
 *   - Variation Selectors (U+FE00-U+FE0F), ZWJ (U+200D): 0 cells
 *   - Everything else: 1 cell
 */
export function stringDisplayWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    // Zero-width characters
    if (cp === 0x200D || (cp >= 0xFE00 && cp <= 0xFE0F)) continue;
    // Supplementary plane — almost always 2 cells (modern emoji)
    if (cp > 0xFFFF) { width += 2; continue; }
    // Emoji / Dingbat ranges that render as 2 cells in modern terminals
    if ((cp >= 0x2300 && cp <= 0x27BF) ||
        (cp >= 0x2934 && cp <= 0x2935) ||
        (cp >= 0x2B05 && cp <= 0x2B55) ||
        (cp >= 0x3030 && cp <= 0x303D) ||
        (cp >= 0x3297 && cp <= 0x3299)) {
      width += 2; continue;
    }
    // CJK fullwidth ranges
    if ((cp >= 0x1100 && cp <= 0x115F) ||
        (cp >= 0x2E80 && cp <= 0x9FFF) ||
        (cp >= 0xAC00 && cp <= 0xD7AF) ||
        (cp >= 0xF900 && cp <= 0xFAFF) ||
        (cp >= 0xFE10 && cp <= 0xFE1F) ||
        (cp >= 0xFE30 && cp <= 0xFE6F) ||
        (cp >= 0xFF01 && cp <= 0xFF60) ||
        (cp >= 0xFFE0 && cp <= 0xFFE6)) {
      width += 2; continue;
    }
    // Default: 1 cell
    width += 1;
  }
  return width;
}

/** Fixed target width for icon prefix alignment (terminal cells). */
const ICON_PREFIX_WIDTH = 12;

// ── Icon prefix composition ───────────────────────────────────────────

/**
 * Compute the icon prefix string for a work item (just icon characters,
 * no trailing space).  Icons are concatenated without spaces and padded
 * to a fixed display width so the item-ID column aligns vertically
 * regardless of how many icon fields are present.
 *
 * Column layout (left to right):
 *   1. Status icon
 *   2. Stage icon (for in_review items, shows audit-aware icon instead)
 *   3. Producer review flag
 *   4. Optional epic icon + child count
 */
export function getIconPrefix(
  item: { status: string; stage?: string; priority?: string; auditResult?: boolean | null; auditedAt?: string | null; needsProducerReview?: boolean; updatedAt?: string; issueType?: string; childCount?: number },
  opts?: IconOptions,
): string {
  const noIcons = opts?.noIcons ?? false;
  const sIcon = statusIcon(item.status, { noIcons });

  // Column 2: stage or audit-aware icon for in_review
  let secondIcon: string;
  if (item.stage === 'in_review') {
    const fresh = isAuditFresh(item.auditedAt, item.updatedAt);
    if (fresh) {
      // Fresh audit: show based on audit result
      secondIcon = auditIcon(item.auditResult, { noIcons });
    } else {
      // No audit or stale audit: show stale-passed icon if passed, else stage icon
      if (item.auditResult === true) {
        secondIcon = auditStaleIcon(item.auditResult, { noIcons });
      } else {
        secondIcon = stageIcon(item.stage, { noIcons });
      }
    }
  } else {
    secondIcon = stageIcon(item.stage, { noIcons });
  }

  // Column 3: producer review flag
  const prIcon = needsProducerReviewIcon(item.needsProducerReview, { noIcons });

  // Concatenate core icons without spaces between them
  const coreIcons = [sIcon, secondIcon, prIcon].filter(Boolean).join('');

  // Column 4: epic icon (child count is no longer shown in prefix)
  const epicSuffix = item.issueType === 'epic' ? epicIcon({ noIcons }) : '';

  // Build full prefix and pad to fixed width for alignment
  let prefix = [coreIcons, epicSuffix].filter(Boolean).join('');
  const width = stringDisplayWidth(prefix);
  if (width < ICON_PREFIX_WIDTH) {
    const padCount = ICON_PREFIX_WIDTH - width;
    prefix = prefix.padEnd(prefix.length + padCount, ' ');
  }

  return prefix;
}
