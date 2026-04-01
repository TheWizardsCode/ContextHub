import os from 'node:os';
import type { WorkItemAudit } from './types.js';

const READY_TO_CLOSE_YES = 'Ready to close: Yes';
const READY_TO_CLOSE_NO = 'Ready to close: No';
const GUTTER_CHAR_RE = /[│┃┆┇╎╏]/u;
const NON_PRINTABLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\u200C\u200D\u2060]/u;

export type AuditFirstLineInspection = {
  firstNonEmptyLine: string;
  trimmedFirstNonEmptyLine: string;
  hasBom: boolean;
  hasNonPrintable: boolean;
  hasGutterChars: boolean;
  isValid: boolean;
};

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

  return {
    time: new Date().toISOString(),
    author: author && author.trim() ? author.trim() : resolveAuditAuthor(),
    text: redacted,
    status: parsed,
  };
}

export function inspectAuditFirstLine(auditText: string): AuditFirstLineInspection {
  const firstNonEmptyLine = (auditText || '').split(/\r?\n/).find(l => l.trim() !== '') || '';
  const trimmedFirstNonEmptyLine = firstNonEmptyLine.trim();
  const hasBom = firstNonEmptyLine.includes('\uFEFF');
  const hasNonPrintable = NON_PRINTABLE_RE.test(firstNonEmptyLine);
  const hasGutterChars = GUTTER_CHAR_RE.test(firstNonEmptyLine);
  const isValid = trimmedFirstNonEmptyLine === READY_TO_CLOSE_YES || trimmedFirstNonEmptyLine === READY_TO_CLOSE_NO;

  return {
    firstNonEmptyLine,
    trimmedFirstNonEmptyLine,
    hasBom,
    hasNonPrintable,
    hasGutterChars,
    isValid,
  };
}

export function formatInvalidAuditFirstLineMessage(inspection: AuditFirstLineInspection): string {
  const found = inspection.trimmedFirstNonEmptyLine === '' ? '<empty>' : inspection.trimmedFirstNonEmptyLine;
  return `First non-empty line must be '${READY_TO_CLOSE_YES}' or '${READY_TO_CLOSE_NO}'. Found: '${found}'. Indicators: bom=${inspection.hasBom ? 'yes' : 'no'}, nonPrintable=${inspection.hasNonPrintable ? 'yes' : 'no'}, gutterChars=${inspection.hasGutterChars ? 'yes' : 'no'}`;
}

/**
 * Parse the first line of an audit text to derive readiness status.
 *
 * Rules:
 * - Inspect only the first non-empty line.
 * - Trim whitespace around that line.
 * - Accept only exact matches:
 *   - `Ready to close: Yes` -> `Complete`
 *   - `Ready to close: No` -> `Partial`
 * - Otherwise return `Missing Criteria`.
 */
export function parseReadinessLine(auditText: string): WorkItemAudit['status'] {
  const inspection = inspectAuditFirstLine(auditText);
  if (inspection.trimmedFirstNonEmptyLine === READY_TO_CLOSE_YES) return 'Complete';
  if (inspection.trimmedFirstNonEmptyLine === READY_TO_CLOSE_NO) return 'Partial';
  return 'Missing Criteria';
}
