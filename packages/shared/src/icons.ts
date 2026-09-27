/**
 * packages/shared/src/icons.ts — Shared icon/colour data for the herdr plugin
 *
 * Dependency-free module providing icon maps, icon functions, stage-colour
 * helpers, and display-width utilities.  Herdr imported its own adapted copy
 * (packages/herdr/src/icons.ts); this module is that data's single canonical
 * home so the plugin no longer carries a duplicate that can drift.
 *
 * The icon glyphs deliberately preserve the values the herdr worklist has
 * always rendered (❓ unknown audit, ⏳ stale-passed, ⊙ epic, 💥 critical
 * risk, `[ready]`/`[?]` text fallbacks) so removing the local copy does not
 * change any rendered output (parent WL-0MSJ4BT4Z002HH9B AC3: "the worklist
 * renders icons/colours identically").
 *
 * The CLI (src/theme.ts) keeps its own self-contained icons with slightly
 * different glyph choices; this module serves herdr's needs without pulling
 * in chalk or other Pi dependencies.
 *
 * No external dependencies — pure data + functions.
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
  done:             '\u{2714}\u{FE0F}',   // ✔️ (legacy alias for completed, WL-0MU3U1AMP0044WUX)
};

const STAGE_FALLBACK: Record<string, string> = {
  idea:             '[IDEA]',
  intake_complete:  '[INTAKE]',
  plan_complete:    '[PLAN]',
  in_progress:      '[IN PR]',
  in_review:        '[REVIEW]',
  completed:        '[DONE]',
  done:             '[DONE]',             // legacy alias for completed (WL-0MU3U1AMP0044WUX)
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

/**
 * Text fallback for the derived child-coverage indicator (`noIcons` mode) so
 * a covered child is never silently dropped from the list row
 * (WL-0MUBVH8QG0020H9L).
 */
const AUDIT_COVERED_FALLBACK = '[COVERED]';

const NEEDS_REVIEW_ICON = '\u{274C}';  // ❌
const REVIEW_DONE_ICON = '\u{2705}';    // ✅

// Agent-status icons (WL-0MSBQUJQX005RAT9). Glyph mapping confirmed by the
// user: working → 🟢 (green circle), blocked → ⛔ (no-entry sign), idle → ⚪
// (white circle). `done`/`unknown`/absent → no icon.
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
 * slot at the start of the icon prefix. Rows with and without an agent keep
 * the remaining icons and the item-ID column at identical columns (AC3).
 */
export const AGENT_SLOT_WIDTH = 2;

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
export function stageIcon(stage: string | undefined | null, opts?: IconOptions): string {
  const key = (stage || '').toLowerCase();
  if (opts?.noIcons) {
    return STAGE_FALLBACK[key] || `[${key.toUpperCase()}]`;
  }
  return STAGE_ICONS[key] || '\u{2753}'; // ❓
}

/**
 * Get the icon for a work item priority.
 */
export function priorityIcon(priority: string | undefined | null, opts?: IconOptions): string {
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
 * Get the icon for a tracked agent's current state.
 *
 * `working → 🟢`, `blocked → ⛔`, `idle → ⚪`. `done`, `unknown`, or an
 * absent state render no icon (the agent finished or the pane is gone).
 * Text fallbacks follow the `[TEXT]` convention for noIcons mode.
 */
export function agentStatusIcon(state: string | undefined, opts?: IconOptions): string {
  const key = (state || '').toLowerCase();
  if (opts?.noIcons) {
    return AGENT_STATE_FALLBACK[key] || '';
  }
  return AGENT_STATE_ICONS[key] || '';
}

/**
 * Get the risk icon.
 */
export function riskIcon(risk: string | undefined | null, opts?: IconOptions): string {
  const key = (risk || '').toLowerCase().trim();
  if (!key) return '';
  if (opts?.noIcons) return `[${key.toUpperCase()}]`;
  return RISK_ICONS[key] || '';
}

/**
 * Get the effort icon.
 */
export function effortIcon(effort: string | undefined | null, opts?: IconOptions): string {
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
 * Named tolerance (ms) for treating an audit as fresh when `auditedAt` and
 * `updatedAt` are within the same atomic persistence window.  Covers the
 * just-persisted case where `auditedAt ≈ updatedAt` (delta well under 1 s)
 * as well as brief comment-only bumps that stay within the 60 s window.
 *
 * Single source of truth: the icon path (`stageDisplayIcon` / `auditIcon`), the
 * audit-dispatch path (`selectAuditCandidate` / `classifyItemForDispatch`) and
 * the ordering path (`sortItemsByScore` / `computeScore` /
 * `compareAuditNotReadyTier` via `isAuditNotReadyFresh`) all import this
 * predicate — no competing `auditedAt`-vs-`updatedAt` comparison exists
 * anywhere (WL-0MSIAOFI70075REE, WL-0MUBVH7ZR009PP80).
 */
export const AUDIT_FRESHNESS_AT_NEAR_TOLERANCE_MS = 60000;

/**
 * The direct parent's audit state, supplied to the display helpers to derive
 * child coverage at read time (WL-0MUBVH8QG0020H9L). Mirrors the audit
 * freshness inputs consumed by {@link isAuditFresh}; no new persisted state.
 */
export interface ParentAuditState {
  auditResult?: boolean | null;
  auditedAt?: string | null;
  updatedAt?: string;
  fingerprint?: string | null;
  currentFingerprint?: string | null;
}

/**
 * Determine whether an audit result is fresh (not stale).
 *
 * Primary gate (content-fingerprint, SA-0MSKB6US1009CNHT / WL-0MUBVH5S0008NQ9K):
 * When a stored fingerprint is present, freshness is decided by content match
 * — the audit is fresh iff the stored fingerprint equals the current fingerprint,
 * regardless of `updatedAt` movement caused by comments, sync merges, or
 * lifecycle transitions.
 *
 * Fallback (legacy time gate): When the stored fingerprint is absent, the
 * 60 s symmetric at-or-near gate is used — an audit is fresh when
 * `|auditedAt - updatedAt| < AUDIT_FRESHNESS_AT_NEAR_TOLERANCE_MS`
 * (WL-0MUBVH7ZR009PP80). The previous one-sided
 * `auditedAt > updatedAt - 60 s` form was a competing definition; this
 * symmetric form is the single freshness comparison shared by the icon,
 * dispatch and ordering paths.
 *
 * Guarantees:
 *   • `updatedAt` churn alone (post-audit comment, sync merge re-timestamp,
 *     sortIndex re-sort) does **not** mark a fingerprinted audit stale (AC4).
 *   • A change to the description/ACs, Key Files, HEAD sha, or working-tree
 *     state marks the audit stale (AC5).
 *   • Legacy audits with no stored fingerprint fall back to the time gate
 *     (unchanged behaviour, AC6). The fallback also applies when the caller
 *     cannot supply a current fingerprint (e.g. a TUI render) so existing
 *     two-argument callers are never regressed.
 *
 * Atomic freshness (WL-0MT8KTE3E001Q1D9 / WL-0MTHRW3770014H51): `saveAuditResult`
 * (and therefore `wl audit-set` and `wl update --audit-text`) atomically sets
 * `updatedAt = auditedAt` in the same transaction that writes the
 * `audit_results` row. Subsequent comments do bump `updatedAt`, but the
 * fingerprint gate keeps fingerprinted audits fresh, and the legacy time gate
 * keeps non-fingerprinted audits fresh within the 60 s window.
 * The audit record in `audit_results` is the canonical source of truth;
 * audit-content comments are deprecated and not consumed by any flow
 * (ship/heartbeat/TUI/implement).
 */
export function isAuditFresh(
  auditedAt: string | null | undefined,
  updatedAt: string | undefined,
  storedFingerprint: string | null | undefined = undefined,
  currentFingerprint: string | null | undefined = undefined,
): boolean {
  if (!auditedAt || !updatedAt) return false;

  // ── Primary gate: content-fingerprint match ──────────────────────────
  // Only usable when BOTH fingerprints are present. A match → fresh
  // regardless of updatedAt; a mismatch → stale (content changed). When
  // either side is unavailable the gate degrades to the legacy time floor
  // (fail-safe: never claim fresh on incomplete fingerprint data).
  if (storedFingerprint && currentFingerprint) {
    return storedFingerprint === currentFingerprint;
  }

  // ── Fallback: legacy 60 s time gate ──────────────────────────────
  const auditTime = new Date(auditedAt).getTime();
  const updateTime = new Date(updatedAt).getTime();
  if (isNaN(auditTime) || isNaN(updateTime)) return false;
  // Symmetric at-or-near: fresh only when the two timestamps are within the
  // tolerance band (strict `<`, so an exact 60 s gap is stale).
  return Math.abs(auditTime - updateTime) < AUDIT_FRESHNESS_AT_NEAR_TOLERANCE_MS;
}

/**
 * Derived child coverage (WL-0MUBVH8QG0020H9L): a child (`parentId` set) is
 * covered iff its DIRECT parent (depth 1 only) has a fresh audit, decided by
 * the single shared {@link isAuditFresh} predicate over the parent's
 * `auditedAt`/`updatedAt`/`fingerprint`/`currentFingerprint`. That predicate
 * is the only freshness comparison in the codebase — this helper must never
 * introduce a competing `auditedAt` vs `updatedAt` check
 * (WL-0MUBVH7ZR009PP80).
 *
 * Coverage is derived at read time for DISPLAY only; nothing is persisted,
 * there is no `audit_results` coverage column, and no schema migration. The
 * audit-dispatch path stays root-only (WL-0MSTLFW14000KPEC), so a covered
 * child is never dispatched independently.
 *
 * Returns `false` for a root item (no `parentId`) or when the parent audit
 * state is unavailable (fail-safe: never claim covered without evidence).
 */
export function isCoveredByParent(
  item: { parentId?: string | null },
  parent: ParentAuditState | null | undefined,
): boolean {
  if (!item.parentId || !parent) return false;
  return isAuditFresh(parent.auditedAt, parent.updatedAt, parent.fingerprint, parent.currentFingerprint);
}

/**
 * Get the display icon for an item's stage with the list's audit-aware
 * `in_review` handling: a fresh audit shows the audit-result icon
 * (✅/❌/❓), a stale-but-passed audit shows the stale-passed hourglass
 * (⏳), a stale or missing audit on an `in_review` item falls back to the
 * plain stage icon (🔍), and every other stage shows the plain stage icon.
 *
 * Derived child coverage (WL-0MUBVH8QG0020H9L): when the item is a child
 * (`parentId` set) with no own audit and its direct parent has a fresh audit
 * (per the shared {@link isAuditFresh} predicate over the supplied
 * `parentAudit`), the parent's audit-result symbol is returned instead of the
 * plain stage icon. In `noIcons` mode the covered indicator renders as the
 * `[COVERED]` text fallback so it is never silently dropped. Coverage is
 * display-only and derived at read time; an item's OWN audit result always
 * wins over inherited coverage.
 *
 * The caller applies the dim/grey styling around the covered indicator
 * (the list row and metadata panel use `ANSI.dim`); this dependency-free
 * helper returns the plain glyph only so display-width maths is never
 * corrupted by ANSI escapes.
 *
 * Shared by the list row prefix (`getIconPrefix`) and the metadata Stage
 * row so the two sections can never diverge (WL-0MSGIXHHI009KFW9 AC2).
 */
export function stageDisplayIcon(
  item: {
    stage?: string;
    parentId?: string | null;
    auditResult?: boolean | null;
    auditedAt?: string | null;
    updatedAt?: string;
    /** Stored content fingerprint from the audit result (optional). */
    fingerprint?: string | null;
    /** Current content fingerprint for the item, when the caller can compute it. */
    currentFingerprint?: string | null;
    /** The direct parent's audit state, when the caller has it (derived coverage). */
    parentAudit?: ParentAuditState | null;
  },
  opts?: IconOptions,
): string {
  const noIcons = opts?.noIcons ?? false;
  if (item.stage === 'in_review') {
    const fresh = isAuditFresh(item.auditedAt, item.updatedAt, item.fingerprint, item.currentFingerprint);
    if (fresh) {
      return auditIcon(item.auditResult, { noIcons });
    }
    if (item.auditResult === true) {
      return auditStaleIcon(item.auditResult, { noIcons });
    }
    // A child's own (non-fresh) audit result wins over inherited coverage;
    // only a child with NO own audit can inherit the parent's verdict.
    if (item.auditResult == null && isCoveredByParent(item, item.parentAudit)) {
      if (noIcons) return AUDIT_COVERED_FALLBACK;
      return auditIcon(item.parentAudit?.auditResult, { noIcons: false });
    }
  }
  return stageIcon(item.stage, { noIcons });
}

// ── Stage colour ──────────────────────────────────────────────────────

/**
 * Map stage to ANSI 256-color code.
 */
export function stageColor(stage: string | undefined): number {
  const colors: Record<string, number> = {
    idea: 247,             // grey
    intake_complete: 68,   // blue-ish
    plan_complete: 172,    // orange-ish
    in_progress: 76,       // green-ish
    in_review: 220,        // yellow-ish
    completed: 33,         // cyan-ish
    done: 33,              // cyan-ish (legacy alias for completed, WL-0MU3U1AMP0044WUX)
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

// ── Priority colour ───────────────────────────────────────────────────

/**
 * Map priority to ANSI 256-color code.
 *
 * Critical → red (196), high → orange (208), medium → yellow (220),
 * low → white (15). Unknown/missing priority falls back to medium (220).
 */
export function priorityColor(priority: string | undefined): number {
  const colors: Record<string, number> = {
    critical: 196, // bright red
    high: 208,     // orange
    medium: 220,   // yellow
    low: 15,       // white
  };
  return colors[priority || ''] ?? 220; // fallback to medium/yellow
}

/**
 * Apply priority colour to text using ANSI escape codes.
 *
 * Unknown/missing priority falls back to medium/yellow (code 220).
 */
export function applyPriorityColour(text: string, priority: string | undefined): string {
  const color = priorityColor(priority);
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
 * The item fields consumed by {@link getIconPrefix} / {@link getIconPrefixParts}.
 * `parentId` / `parentAudit` carry the derived coverage inputs
 * (WL-0MUBVH8QG0020H9L); they are optional so existing root-item callers are
 * unaffected.
 */
export interface IconPrefixItem {
  status: string;
  stage?: string;
  priority?: string;
  auditResult?: boolean | null;
  auditedAt?: string | null;
  needsProducerReview?: boolean;
  updatedAt?: string;
  issueType?: string;
  childCount?: number;
  agentState?: string;
  parentId?: string | null;
  fingerprint?: string | null;
  currentFingerprint?: string | null;
  parentAudit?: ParentAuditState | null;
}

/**
 * The composed icon prefix plus the location of the stage/audit icon inside
 * it, so the renderer can apply dim/grey styling to the covered indicator
 * only (WL-0MUBVH8QG0020H9L). `stageStart`/`stageEnd` are JS string indices
 * into `text` (surrogate-pair safe for slicing).
 */
export interface IconPrefixParts {
  /** Full prefix string (no ANSI styling), padded to the fixed width. */
  text: string;
  /** JS string index where the stage/audit icon starts within `text`. */
  stageStart: number;
  /** JS string index just past the stage/audit icon within `text`. */
  stageEnd: number;
}

/**
 * Compose the icon prefix and expose the stage/audit icon's range so a caller
 * can dim just that icon (see {@link getIconPrefixParts}).
 */
export function getIconPrefixParts(
  item: IconPrefixItem,
  opts?: IconOptions,
): IconPrefixParts {
  const noIcons = opts?.noIcons ?? false;

  // Column 0: agent status — fixed-width reserved slot so rows with and
  // without an agent keep the remaining icons and the item-ID column at
  // identical columns (AC3, WL-0MSBQUJQX005RAT9).
  const agentIcon = agentStatusIcon(item.agentState, { noIcons });
  const agentSlot = agentIcon !== '' ? agentIcon : ' '.repeat(AGENT_SLOT_WIDTH);

  const sIcon = statusIcon(item.status, { noIcons });

  // Column 2: stage or audit-aware icon for in_review — via the shared
  // stageDisplayIcon helper so the list prefix and the metadata Stage row
  // can never diverge (WL-0MSGIXHHI009KFW9).
  const secondIcon = stageDisplayIcon(item, { noIcons });

  // Column 3: producer review flag
  const prIcon = needsProducerReviewIcon(item.needsProducerReview, { noIcons });

  // Concatenate core icons without spaces between them
  const coreIcons = [sIcon, secondIcon, prIcon].filter(Boolean).join('');

  // Column 4: epic icon (child count is no longer shown in prefix)
  const epicSuffix = item.issueType === 'epic' ? epicIcon({ noIcons }) : '';

  // Build full prefix and pad to fixed width for alignment. The agent slot
  // is included in the total, so rows with and without an agent still land
  // at exactly ICON_PREFIX_WIDTH cells.
  let prefix = [agentSlot, coreIcons, epicSuffix].filter(Boolean).join('');
  const width = stringDisplayWidth(prefix);
  if (width < ICON_PREFIX_WIDTH) {
    prefix = prefix.padEnd(prefix.length + (ICON_PREFIX_WIDTH - width), ' ');
  }

  // `sIcon` and `secondIcon` are always non-empty (status/stage icons have
  // fallbacks), so these indices are always valid and point at the stage
  // icon the coverage dimming wraps.
  const stageStart = agentSlot.length + sIcon.length;
  return { text: prefix, stageStart, stageEnd: stageStart + secondIcon.length };
}

/**
 * Compute the icon prefix string for a work item (just icon characters,
 * no trailing space).  Icons are concatenated without spaces and padded
 * to a fixed display width so the item-ID column aligns vertically
 * regardless of how many icon fields are present.
 *
 * Column layout (left to right):
 *   0. Agent status (fixed-width reserved slot, WL-0MSBQUJQX005RAT9)
 *   1. Status icon
 *   2. Stage icon (for in_review items, shows audit-aware icon instead)
 *   3. Producer review flag
 *   4. Optional epic icon + child count
 */
export function getIconPrefix(item: IconPrefixItem, opts?: IconOptions): string {
  return getIconPrefixParts(item, opts).text;
}
