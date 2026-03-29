import os from 'node:os';
import type { WorkItemAudit } from './types.js';

export function resolveAuditAuthor(): string {
  const explicit = process.env.WL_USER || process.env.USER || process.env.USERNAME;
  if (explicit && explicit.trim()) return explicit.trim();
  try {
    const username = os.userInfo().username;
    if (username && username.trim()) return username.trim();
  } catch {
    // fall back below
  }
  return 'worklog';
}

/**
 * Redact email-like strings in free-form audit text.
 *
 * Rules (WL-0MMNCOIYS15A1YSI):
 * - Match common email patterns where domain contains a dot (avoid localhost)
 * - Replace local part with first-character + exactly three asterisks and keep domain
 * - Deterministic and irreversible
 */
export function redactAuditText(auditText: string): string {
  if (!auditText) return auditText;

  // Match local@domain.tld where domain contains at least one dot and TLD-like tail
  const emailRe = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

  return auditText.replace(emailRe, (_match, local: string, domain: string) => {
    const first = local && local.length > 0 ? local[0] : '';
    return `${first}***@${domain}`;
  });
}

export type BuildAuditOptions = {
  /** If provided, signals whether the associated work item description includes acceptance/success criteria. */
  hasAcceptanceCriteria?: boolean;
};

export function hasAcceptanceCriteria(description?: string): boolean {
  if (!description) return false;
  // Heuristic: look for common headings/phrases that indicate acceptance or success criteria
  return /acceptance\s*criteria|acceptance_criteria|success\s*criteria|success_criteria|acceptance\s*:/i.test(description);
}

export function buildAuditEntry(auditText: string, author?: string, opts?: BuildAuditOptions): WorkItemAudit {
  // Ensure audit text is redacted before persistence to avoid storing raw PII
  const redacted = redactAuditText(auditText);
  const parsed = parseReadinessLine(redacted);

  // Conservative override: if the audit text claims readiness (Complete) but the
  // associated work item lacks explicit acceptance criteria, mark as Missing Criteria
  // to signal that we cannot deterministically verify the claim.
  let finalStatus: WorkItemAudit['status'] = parsed;
  if (parsed === 'Complete' && opts && opts.hasAcceptanceCriteria === false) {
    finalStatus = 'Missing Criteria';
  }

  return {
    time: new Date().toISOString(),
    author: author && author.trim() ? author.trim() : resolveAuditAuthor(),
    text: redacted,
    status: finalStatus,
  };
}

/**
 * Parse the first line of an audit text to derive a conservative readiness status.
 *
 * Rules (deterministic, no ML):
 * - Inspect only the first non-empty line.
 * - If the line starts with or contains explicit tokens mapping to Complete/Partial/Not Started
 *   return the mapped value. Tokens checked (case-insensitive):
 *     - Complete: `complete`, `done`, `closed`, `ready to close`, `ready`.
 *     - Partial: `partial`, `incomplete`, `needs work`, `some work`.
 *     - Not Started: `not started`, `open`, `todo`.
 * - If none match, return 'Missing Criteria' to signal conservatively that readiness
 *   couldn't be determined.
 */
export function parseReadinessLine(auditText: string): WorkItemAudit['status'] {
  if (!auditText) return 'Missing Criteria';
  const firstLine = auditText.split(/\r?\n/).find(l => l.trim() !== '') || '';
  const s = firstLine.trim().toLowerCase();

  // Map of token -> status. Order matters: check more specific phrases first.
  const checks: Array<{ re: RegExp; status: WorkItemAudit['status'] }> = [
    { re: /(^|\b)(ready to close|ready to be closed|ready to close)($|\b)/i, status: 'Complete' },
    { re: /(^|\b)(ready|complete|closed|done)($|\b)/i, status: 'Complete' },
    { re: /(^|\b)(partial|incomplete|needs work|some work)($|\b)/i, status: 'Partial' },
    { re: /(^|\b)(not started|todo|open)($|\b)/i, status: 'Not Started' },
  ];

  for (const c of checks) {
    if (c.re.test(firstLine)) return c.status;
  }

  return 'Missing Criteria';
}
