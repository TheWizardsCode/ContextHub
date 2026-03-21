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

export function buildAuditEntry(auditText: string, author?: string): WorkItemAudit {
  return {
    time: new Date().toISOString(),
    author: author && author.trim() ? author.trim() : resolveAuditAuthor(),
    text: auditText,
  };
}
