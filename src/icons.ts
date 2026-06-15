/**
 * Icon utilities for work item priority and status.
 *
 * Provides consistent icon rendering (emoji or text fallback) across
 * the TUI (blessed) and CLI (chalk) output paths, with accessible
 * labels for screen readers.
 *
 * Design spec: docs/icons-design.md
 */

/**
 * Options for icon rendering.
 */
export interface IconOptions {
  /** When true, use text fallback instead of emoji/icon glyph. */
  noIcons?: boolean;
}

// ─── Priority Icons ────────────────────────────────────────────────────
// More graphical icons that visually convey priority levels

const PRIORITY_ICON: Record<string, string> = {
  critical: '\u{1F6A8}',   // 🚨 Rotating light - urgent/danger
  high:     '\u{2B50}',    // ⭐ Star - important
  medium:   '\u{1F4CB}',   // 📋 Clipboard - standard task
  low:      '\u{1F422}',   // 🐢 Turtle - slow/low priority
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

// ─── Status Icons ───────────────────────────────────────────────────────

const STATUS_ICON: Record<string, string> = {
  open:          '\u{1F7E2}',   // 🟢 Green circle
  'in-progress': '\u{1F504}',  // 🔄 Arrows (recycling)
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

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Check whether icons should be rendered.
 *
 * Icons are enabled by default when running in a TTY. They can be
 * disabled via the `WL_NO_ICONS` environment variable or the
 * `noIcons` option.
 */
export function iconsEnabled(opts?: { noIcons?: boolean }): boolean {
  // Explicit opt-out via option (takes priority over everything).
  if (opts?.noIcons === true) return false;
  // Explicit opt-in via option overrides env var.
  if (opts?.noIcons === false) return true;
  // Global env var opt-out.
  if (typeof process !== 'undefined' && process.env?.WL_NO_ICONS === '1') return false;
  // Default to enabled; callers can further restrict based on TTY.
  return true;
}

/**
 * Get the icon string (emoji or text fallback) for a work item priority.
 *
 * @param priority - The priority value (e.g. 'critical', 'high', 'medium', 'low').
 * @param opts - Options controlling fallback behaviour.
 * @returns The icon string (emoji or bracketed text).
 */
export function priorityIcon(priority: string, opts?: IconOptions): string {
  const key = (priority || '').toLowerCase().trim();
  if (opts?.noIcons === true) {
    return PRIORITY_FALLBACK[key] ?? '';
  }
  return PRIORITY_ICON[key] ?? '';
}

/**
 * Get the icon string (emoji or text fallback) for a work item status.
 *
 * @param status - The status value (e.g. 'open', 'in-progress', 'completed').
 * @param opts - Options controlling fallback behaviour.
 * @returns The icon string (emoji or bracketed text).
 */
export function statusIcon(status: string, opts?: IconOptions): string {
  const key = (status || '').toLowerCase().trim();
  if (opts?.noIcons === true) {
    return STATUS_FALLBACK[key] ?? '';
  }
  return STATUS_ICON[key] ?? '';
}

/**
 * Get the accessible label for a priority icon.
 *
 * @param priority - The priority value.
 * @returns A human-readable label describing the priority (e.g. "High priority").
 */
export function priorityLabel(priority: string): string {
  return PRIORITY_LABEL[(priority || '').toLowerCase().trim()] ?? '';
}

/**
 * Get the accessible label for a status icon.
 *
 * @param status - The status value.
 * @returns A human-readable label describing the status (e.g. "Status: Open").
 */
export function statusLabel(status: string): string {
  return STATUS_LABEL[(status || '').toLowerCase().trim()] ?? '';
}

/**
 * Get the text fallback for a priority icon.
 *
 * @param priority - The priority value.
 * @returns The bracketed text label (e.g. "[CRIT]").
 */
export function priorityFallback(priority: string): string {
  return PRIORITY_FALLBACK[(priority || '').toLowerCase().trim()] ?? '';
}

/**
 * Get the text fallback for a status icon.
 *
 * @param status - The status value.
 * @returns The bracketed text label (e.g. "[OPEN]").
 */
export function statusFallback(status: string): string {
  return STATUS_FALLBACK[(status || '').toLowerCase().trim()] ?? '';
}

// ─── Stage Icons ───────────────────────────────────────────────────────

const STAGE_ICON: Record<string, string> = {
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

// ─── Audit Result Icons ────────────────────────────────────────────────

/**
 * Audit result key for icon lookup.
 * true → 'yes', false → 'no', null/undefined → 'unknown'
 */
function auditKey(result: boolean | null | undefined): string {
  if (result === true) return 'yes';
  if (result === false) return 'no';
  return 'unknown';
}

const AUDIT_ICON: Record<string, string> = {
  yes:     '\u{2705}',  // ✅
  no:      '\u{274C}',  // ❌
  unknown: '\u{2753}',  // ❓
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

// ─── Stage Public API ──────────────────────────────────────────────────

/**
 * Get the icon string (emoji or text fallback) for a work item stage.
 *
 * @param stage - The stage value (e.g. 'idea', 'in_progress', 'done').
 * @param opts - Options controlling fallback behaviour.
 * @returns The icon string (emoji or bracketed text).
 */
export function stageIcon(stage: string | undefined | null, opts?: IconOptions): string {
  const key = (stage || '').toLowerCase().trim();
  if (opts?.noIcons === true) {
    return STAGE_FALLBACK[key] ?? '';
  }
  return STAGE_ICON[key] ?? '';
}

/**
 * Get the accessible label for a stage icon.
 *
 * @param stage - The stage value.
 * @returns A human-readable label describing the stage (e.g. "Stage: In Progress").
 */
export function stageLabel(stage: string | undefined | null): string {
  return STAGE_LABEL[(stage || '').toLowerCase().trim()] ?? '';
}

/**
 * Get the text fallback for a stage icon.
 *
 * @param stage - The stage value.
 * @returns The bracketed text label (e.g. "[PROG]").
 */
export function stageFallback(stage: string | undefined | null): string {
  return STAGE_FALLBACK[(stage || '').toLowerCase().trim()] ?? '';
}

// ─── Audit Result Public API ───────────────────────────────────────────

/**
 * Get the icon string (emoji or text fallback) for an audit result.
 *
 * @param result - The audit result: true (yes/passed), false (no/failed), null/undefined (unknown).
 * @param opts - Options controlling fallback behaviour.
 * @returns The icon string (emoji or bracketed text).
 */
export function auditIcon(result: boolean | null | undefined, opts?: IconOptions): string {
  const key = auditKey(result);
  if (opts?.noIcons === true) {
    return AUDIT_FALLBACK[key] ?? '';
  }
  return AUDIT_ICON[key] ?? '';
}

/**
 * Get the accessible label for an audit result icon.
 *
 * @param result - The audit result value.
 * @returns A human-readable label (e.g. "Audit: Passed").
 */
export function auditLabel(result: boolean | null | undefined): string {
  return AUDIT_LABEL[auditKey(result)] ?? '';
}

/**
 * Get the text fallback for an audit result icon.
 *
 * @param result - The audit result value.
 * @returns The bracketed text label (e.g. "[YES]").
 */
export function auditFallback(result: boolean | null | undefined): string {
  return AUDIT_FALLBACK[auditKey(result)] ?? '';
}
