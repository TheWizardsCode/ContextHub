/**
 * packages/shared/src/icons.ts — Shared icon/colour data for Worklog
 *
 * Dependency-free module providing icon maps, icon functions, stage-colour
 * helpers, and display-width utilities.  This is the single source of truth
 * for icon/colour data consumed by both the CLI (src/theme.ts re-exports)
 * and the herdr plugin (packages/herdr).
 *
 * No external dependencies — pure data + functions.
 */

// ── Options ───────────────────────────────────────────────────────────

export interface IconOptions {
  /** When true, use text fallback instead of emoji/icon glyph. */
  noIcons?: boolean;
}

// ── Priority Icons ────────────────────────────────────────────────────

const PRIORITY_ICONS: Record<string, string> = {
  critical: '\u{1F6A8}',  // 🚨 Rotating light
  high:     '\u{2B50}',   // ⭐ Star
  medium:   '\u{1F4CB}',  // 📋 Clipboard
  low:      '\u{1F422}',  // 🐢 Turtle
};

const PRIORITY_FALLBACK: Record<string, string> = {
  critical: '[CRIT]',
  high:     '[HIGH]',
  medium:   '[MED ]',
  low:      '[LOW ]',
};

const PRIORITY_LABEL: Record<string, string> = {
  critical: 'Critical priority',
  high:     'High priority',
  medium:   'Medium priority',
  low:      'Low priority',
};

// ── Status Icons ───────────────────────────────────────────────────────

const STATUS_ICONS: Record<string, string> = {
  open:          '\u{1F513}',   // 🔓 Unlocked
  'in-progress': '\u{1F504}',  // 🔄 Arrows
  completed:     '\u{2714}\u{FE0F}', // ✔️ Heavy check mark
  blocked:       '\u{26D4}',   // ⛔ No entry
  deleted:       '\u{1F5D1}\u{FE0F}', // 🗑️ Wastebasket
  input_needed:  '\u{1F4AC}',  // 💬 Speech balloon
};

const STATUS_FALLBACK: Record<string, string> = {
  open:          '[OPEN]',
  'in-progress': '[INPR]',
  completed:     '[DONE]',
  blocked:       '[BLKD]',
  deleted:       '[DEL ]',
  input_needed:  '[HELP]',
};

const STATUS_LABEL: Record<string, string> = {
  open:          'Status: Open',
  'in-progress': 'Status: In progress',
  completed:     'Status: Completed',
  blocked:       'Status: Blocked',
  deleted:       'Status: Deleted',
  input_needed:  'Status: Input needed',
};

// ── Risk Icons ─────────────────────────────────────────────────────────

const RISK_ICONS: Record<string, string> = {
  low:    '\u{1F331}',  // 🌱 Seedling
  medium: '\u{26A0}\u{FE0F}', // ⚠️ Warning
  high:   '\u{1F525}',  // 🔥 Fire
  severe: '\u{1F6A8}',  // 🚨 Rotating light
};

const RISK_FALLBACK: Record<string, string> = {
  low:    '[LOW]',
  medium: '[MED]',
  high:   '[HIGH]',
  severe: '[SEV]',
};

const RISK_LABEL: Record<string, string> = {
  low:    'Risk: Low',
  medium: 'Risk: Medium',
  high:   'Risk: High',
  severe: 'Risk: Severe',
};

// ── Effort Icons ───────────────────────────────────────────────────────

const EFFORT_ICONS: Record<string, string> = {
  xs:        '\u{1F41C}',  // 🐜 Ant
  s:         '\u{1F407}',  // 🐇 Rabbit
  m:         '\u{1F415}',  // 🐕 Dog
  l:         '\u{1F418}',  // 🐘 Elephant
  xl:        '\u{1F40B}',  // 🐋 Whale
  'extra small': '\u{1F41C}',
  small:       '\u{1F407}',
  medium:      '\u{1F415}',
  large:       '\u{1F418}',
  'extra large': '\u{1F40B}',
  xlarge:      '\u{1F40B}',
};

const EFFORT_FALLBACK: Record<string, string> = {
  xs:        '[XS]',
  s:         '[S]',
  m:         '[M]',
  l:         '[L]',
  xl:        '[XL]',
  'extra small': '[XS]',
  small:       '[S]',
  medium:      '[M]',
  large:       '[L]',
  'extra large': '[XL]',
  xlarge:      '[XL]',
};

const EFFORT_LABEL: Record<string, string> = {
  xs:        'Effort: XS (extra small)',
  s:         'Effort: S (small)',
  m:         'Effort: M (medium)',
  l:         'Effort: L (large)',
  xl:        'Effort: XL (extra large)',
  'extra small': 'Effort: XS (extra small)',
  small:       'Effort: S (small)',
  medium:      'Effort: M (medium)',
  large:       'Effort: L (large)',
  'extra large': 'Effort: XL (extra large)',
  xlarge:      'Effort: XL (extra large)',
};

// ── Epic Icons ──────────────────────────────────────────────────────────

const EPIC_ICON = '\u{1F3F0}';  // 🏰 Castle
const EPIC_FALLBACK = '[EPIC]';
const EPIC_LABEL = 'Issue Type: Epic';

// ── Stage Icons ───────────────────────────────────────────────────────

const STAGE_ICONS: Record<string, string> = {
  idea:            '\u{1F4A1}',          // 💡
  intake_complete: '\u{1F4E5}',          // 📥
  plan_complete:   '\u{1F4CB}',          // 📋
  in_progress:     '\u{1F6E0}\u{FE0F}', // 🛠️
  in_review:       '\u{1F50D}',          // 🔍
  done:            '\u{1F3C1}',          // 🏁
};

const STAGE_FALLBACK: Record<string, string> = {
  idea:            '[IDEA]',
  intake_complete: '[INTAKE]',
  plan_complete:   '[PLAN]',
  in_progress:     '[PROG]',
  in_review:       '[REVIEW]',
  done:            '[DONE]',
};

const STAGE_LABEL: Record<string, string> = {
  idea:            'Stage: Idea',
  intake_complete: 'Stage: Intake Complete',
  plan_complete:   'Stage: Plan Complete',
  in_progress:     'Stage: In Progress',
  in_review:       'Stage: In Review',
  done:            'Stage: Done',
};

// ── Audit Result Icons ────────────────────────────────────────────────

function auditKey(result: boolean | null | undefined): string {
  if (result === true) return 'yes';
  if (result === false) return 'no';
  return 'unknown';
}

const AUDIT_ICON: Record<string, string> = {
  yes:     '\u{2705}',  // ✅
  no:      '\u{274C}',  // ❌
  unknown: '\u{2754}',  // ❔
};

const AUDIT_FALLBACK: Record<string, string> = {
  yes:     '[YES]',
  no:      '[NO]',
  unknown: '[UNKN]',
};

const AUDIT_LABEL: Record<string, string> = {
  yes:     'Audit: Passed',
  no:      'Audit: Failed',
  unknown: 'Audit: Not run',
};

// ── Stale Audit Result Icons ───────────────────────────────────────────

const STALE_AUDIT_ICON: Record<string, string> = {
  yes: '\u{1F7E9}',  // 🟩 Green square button
};

const STALE_AUDIT_FALLBACK: Record<string, string> = {
  yes: '[YES_STALE]',
};

const STALE_AUDIT_LABEL: Record<string, string> = {
  yes: 'Audit: Passed (stale)',
};

// ── Producer Review Flag Icons ────────────────────────────────────────

function producerReviewKey(needsProducerReview: boolean | null | undefined): string {
  if (needsProducerReview === true) return 'needed';
  return 'not_needed';
}

const PRODUCER_REVIEW_ICON: Record<string, string> = {
  needed:    '\u{274C}',   // ❌
  not_needed: '\u{2705}',  // ✅
};

const PRODUCER_REVIEW_FALLBACK: Record<string, string> = {
  needed:    '[NEEDS_PRODUCER]',
  not_needed: '[PRODUCER_OK]',
};

const PRODUCER_REVIEW_LABEL: Record<string, string> = {
  needed:     'Needs producer review',
  not_needed: 'Producer review complete',
};

// ── Agent-State Icons ──────────────────────────────────────────────────

/**
 * Agent-status icons (WL-0MSBQUJQX005RAT9).
 * working → 🟢, blocked → ⛔, idle → ⚪.
 * done/unknown/absent → no icon.
 */
const AGENT_STATE_ICONS: Record<string, string> = {
  idle:    '\u{26AA}',   // ⚪
  working: '\u{1F7E2}',  // 🟢
  blocked: '\u{26D4}',   // ⛔
};

const AGENT_STATE_FALLBACK: Record<string, string> = {
  idle:    '[IDLE]',
  working: '[WORK]',
  blocked: '[BLKD]',
};

/**
 * Fixed display width (in terminal cells) of the reserved agent-status
 * slot at the start of the icon prefix.
 */
export const AGENT_SLOT_WIDTH = 2;

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Check whether icons should be rendered.
 */
export function iconsEnabled(opts?: { noIcons?: boolean }): boolean {
  if (opts?.noIcons === true) return false;
  if (opts?.noIcons === false) return true;
  if (typeof process !== 'undefined' && process.env?.WL_NO_ICONS === '1') return false;
  return true;
}

// ── Priority API ───────────────────────────────────────────────────────

export function priorityIcon(priority: string, opts?: IconOptions): string {
  const key = (priority || '').toLowerCase().trim();
  if (opts?.noIcons === true) return PRIORITY_FALLBACK[key] ?? '';
  return PRIORITY_ICONS[key] ?? '';
}

export function priorityLabel(priority: string): string {
  return PRIORITY_LABEL[(priority || '').toLowerCase().trim()] ?? '';
}

export function priorityFallback(priority: string): string {
  return PRIORITY_FALLBACK[(priority || '').toLowerCase().trim()] ?? '';
}

// ── Status API ──────────────────────────────────────────────────────────

export function statusIcon(status: string, opts?: IconOptions): string {
  const key = (status || '').toLowerCase().trim();
  if (opts?.noIcons === true) return STATUS_FALLBACK[key] ?? '';
  return STATUS_ICONS[key] ?? '';
}

export function statusLabel(status: string): string {
  return STATUS_LABEL[(status || '').toLowerCase().trim()] ?? '';
}

export function statusFallback(status: string): string {
  return STATUS_FALLBACK[(status || '').toLowerCase().trim()] ?? '';
}

// ── Risk API ────────────────────────────────────────────────────────────

export function riskIcon(risk: string | undefined | null, opts?: IconOptions): string {
  const key = (risk || '').toLowerCase().trim();
  if (opts?.noIcons === true) return RISK_FALLBACK[key] ?? '';
  return RISK_ICONS[key] ?? '';
}

export function riskLabel(risk: string | undefined | null): string {
  return RISK_LABEL[(risk || '').toLowerCase().trim()] ?? '';
}

export function riskFallback(risk: string | undefined | null): string {
  return RISK_FALLBACK[(risk || '').toLowerCase().trim()] ?? '';
}

// ── Effort API ──────────────────────────────────────────────────────────

export function effortIcon(effort: string | undefined | null, opts?: IconOptions): string {
  const key = (effort || '').toLowerCase().trim();
  if (opts?.noIcons === true) return EFFORT_FALLBACK[key] ?? '';
  return EFFORT_ICONS[key] ?? '';
}

export function effortLabel(effort: string | undefined | null): string {
  return EFFORT_LABEL[(effort || '').toLowerCase().trim()] ?? '';
}

export function effortFallback(effort: string | undefined | null): string {
  return EFFORT_FALLBACK[(effort || '').toLowerCase().trim()] ?? '';
}

// ── Epic API ────────────────────────────────────────────────────────────

export function epicIcon(opts?: IconOptions): string {
  if (opts?.noIcons === true) return EPIC_FALLBACK;
  return EPIC_ICON;
}

export function epicLabel(): string {
  return EPIC_LABEL;
}

export function epicFallback(): string {
  return EPIC_FALLBACK;
}

// ── Stage API ──────────────────────────────────────────────────────────

export function stageIcon(stage: string | undefined | null, opts?: IconOptions): string {
  const key = (stage || '').toLowerCase().trim();
  if (opts?.noIcons === true) return STAGE_FALLBACK[key] ?? '';
  return STAGE_ICONS[key] ?? '';
}

export function stageLabel(stage: string | undefined | null): string {
  return STAGE_LABEL[(stage || '').toLowerCase().trim()] ?? '';
}

export function stageFallback(stage: string | undefined | null): string {
  return STAGE_FALLBACK[(stage || '').toLowerCase().trim()] ?? '';
}

// ── Audit API ──────────────────────────────────────────────────────────

export function auditIcon(result: boolean | null | undefined, opts?: IconOptions): string {
  const key = auditKey(result);
  if (opts?.noIcons === true) return AUDIT_FALLBACK[key] ?? '';
  return AUDIT_ICON[key] ?? '';
}

export function auditLabel(result: boolean | null | undefined): string {
  return AUDIT_LABEL[auditKey(result)] ?? '';
}

export function auditFallback(result: boolean | null | undefined): string {
  return AUDIT_FALLBACK[auditKey(result)] ?? '';
}

// ── Stale Audit API ────────────────────────────────────────────────────

export function auditStaleIcon(result: boolean | null | undefined, opts?: IconOptions): string {
  if (result === true) {
    if (opts?.noIcons === true) return STALE_AUDIT_FALLBACK.yes;
    return STALE_AUDIT_ICON.yes;
  }
  return auditIcon(result, opts);
}

export function auditStaleLabel(result: boolean | null | undefined): string {
  if (result === true) return STALE_AUDIT_LABEL.yes;
  return auditLabel(result);
}

export function auditStaleFallback(result: boolean | null | undefined): string {
  if (result === true) return STALE_AUDIT_FALLBACK.yes;
  return auditFallback(result);
}

// ── Producer Review API ────────────────────────────────────────────────

export function needsProducerReviewIcon(needsProducerReview: boolean | null | undefined, opts?: IconOptions): string {
  const key = producerReviewKey(needsProducerReview);
  if (opts?.noIcons === true) return PRODUCER_REVIEW_FALLBACK[key] ?? '';
  return PRODUCER_REVIEW_ICON[key] ?? '';
}

export function needsProducerReviewLabel(needsProducerReview: boolean | null | undefined): string {
  return PRODUCER_REVIEW_LABEL[producerReviewKey(needsProducerReview)] ?? '';
}

export function needsProducerReviewFallback(needsProducerReview: boolean | null | undefined): string {
  return PRODUCER_REVIEW_FALLBACK[producerReviewKey(needsProducerReview)] ?? '';
}

// ── Agent Status API ───────────────────────────────────────────────────

/**
 * Get the icon for a tracked agent's current state.
 *
 * `working → 🟢`, `blocked → ⛔`, `idle → ⚪`. `done`, `unknown`, or an
 * absent state render no icon.
 */
export function agentStatusIcon(state: string | undefined, opts?: IconOptions): string {
  const key = (state || '').toLowerCase();
  if (opts?.noIcons) return AGENT_STATE_FALLBACK[key] || '';
  return AGENT_STATE_ICONS[key] || '';
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

/**
 * Get the display icon for an item's stage with the list's audit-aware
 * `in_review` handling: a fresh audit shows the audit-result icon
 * (✅/❌/❓), a stale-but-passed audit shows the stale-passed icon (🟩),
 * a stale or missing audit on an `in_review` item falls back to the
 * plain stage icon (🔍), and every other stage shows the plain stage icon.
 */
export function stageDisplayIcon(
  item: { stage?: string; auditResult?: boolean | null; auditedAt?: string | null; updatedAt?: string },
  opts?: IconOptions,
): string {
  const noIcons = opts?.noIcons ?? false;
  if (item.stage === 'in_review') {
    const fresh = isAuditFresh(item.auditedAt, item.updatedAt);
    if (fresh) {
      return auditIcon(item.auditResult, { noIcons });
    }
    if (item.auditResult === true) {
      return auditStaleIcon(item.auditResult, { noIcons });
    }
  }
  return stageIcon(item.stage, { noIcons });
}

// ── Stage colour ──────────────────────────────────────────────────────

export function stageColor(stage: string | undefined): number {
  const colors: Record<string, number> = {
    idea: 247,             // grey
    intake_complete: 68,   // blue-ish
    plan_complete: 172,    // orange-ish
    in_progress: 76,       // green-ish
    in_review: 220,        // yellow-ish
    completed: 33,         // cyan-ish
  };
  return colors[stage || ''] ?? 241;
}

export function applyStageColour(text: string, stage: string | undefined): string {
  const color = stageColor(stage);
  return `\x1b[38;5;${color}m${text}\x1b[0m`;
}

// ── Terminal display width helpers ────────────────────────────────────

/**
 * Estimate the terminal display width of a string (cells/columns).
 */
export function stringDisplayWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x200D || (cp >= 0xFE00 && cp <= 0xFE0F)) continue;
    if (cp > 0xFFFF) { width += 2; continue; }
    if ((cp >= 0x2300 && cp <= 0x27BF) ||
        (cp >= 0x2934 && cp <= 0x2935) ||
        (cp >= 0x2B05 && cp <= 0x2B55) ||
        (cp >= 0x3030 && cp <= 0x303D) ||
        (cp >= 0x3297 && cp <= 0x3299)) {
      width += 2; continue;
    }
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
    width += 1;
  }
  return width;
}

/** Fixed target width for icon prefix alignment (terminal cells). */
const ICON_PREFIX_WIDTH = 12;

/**
 * Compute the icon prefix string for a work item (just icon characters,
 * no trailing space). Icons are concatenated and padded to a fixed
 * display width so the item-ID column aligns vertically.
 */
export function getIconPrefix(
  item: { status: string; stage?: string; priority?: string; auditResult?: boolean | null; auditedAt?: string | null; needsProducerReview?: boolean; updatedAt?: string; issueType?: string; childCount?: number; agentState?: string },
  opts?: IconOptions,
): string {
  const noIcons = opts?.noIcons ?? false;

  const agentIcon = agentStatusIcon(item.agentState, { noIcons });
  const agentSlot = agentIcon !== '' ? agentIcon : ' '.repeat(AGENT_SLOT_WIDTH);

  const sIcon = statusIcon(item.status, { noIcons });
  const secondIcon = stageDisplayIcon(item, { noIcons });
  const prIcon = needsProducerReviewIcon(item.needsProducerReview, { noIcons });

  const coreIcons = [sIcon, secondIcon, prIcon].filter(Boolean).join('');
  const epicSuffix = item.issueType === 'epic' ? epicIcon({ noIcons }) : '';

  let prefix = [agentSlot, coreIcons, epicSuffix].filter(Boolean).join('');
  const width = stringDisplayWidth(prefix);
  if (width < ICON_PREFIX_WIDTH) {
    const padCount = ICON_PREFIX_WIDTH - width;
    prefix = prefix.padEnd(prefix.length + padCount, ' ');
  }

  return prefix;
}
