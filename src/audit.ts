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

export function buildAuditEntry(auditText: string, author?: string): WorkItemAudit {
  // Ensure audit text is redacted before persistence to avoid storing raw PII
  const redacted = redactAuditText(auditText);
  return {
    time: new Date().toISOString(),
    author: author && author.trim() ? author.trim() : resolveAuditAuthor(),
    text: redacted,
  };
}
