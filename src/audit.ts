/**
 * Audit entry utilities for Worklog.
 *
 * Provides helpers for building structured AuditEntry objects from
 * freeform audit text, including conservative status derivation.
 *
 * Status derivation is intentionally conservative:
 *  - If the work item description lacks explicit success criteria, status
 *    is set to 'Missing Criteria' rather than inferring from audit text.
 *  - Keyword matching uses conservative thresholds to prefer 'Partial' or
 *    'Not Started' over 'Complete' when uncertain.
 */

import * as os from 'os';
import type { AuditEntry, AuditStatus } from './types.js';

/**
 * Patterns that indicate explicit success criteria in a work item description.
 * At least one must match for the description to be considered criteria-bearing.
 */
const CRITERIA_PATTERNS = [
  /success criteria/i,
  /acceptance criteria/i,
  /\bAC\s*\d+/,
  /\bdone when\b/i,
  /\bcomplete when\b/i,
  /\bshould\b.*\bcan\b/i,
  /\bmust\b.*\bwhen\b/i,
  /- \[[ xX]\]/,  // checkbox list items often indicate criteria
];

/**
 * Returns true if the description appears to contain explicit success criteria.
 */
export function hasExplicitCriteria(description: string): boolean {
  if (!description || description.trim() === '') return false;
  return CRITERIA_PATTERNS.some(p => p.test(description));
}

/**
 * Conservatively derive an AuditStatus from audit text and item description.
 *
 * Rules (applied in order):
 *  1. If description lacks explicit success criteria → 'Missing Criteria'
 *  2. If audit text contains strong completion signals → 'Complete'
 *  3. If audit text contains partial-progress signals → 'Partial'
 *  4. Default → 'Not Started'
 */
export function deriveAuditStatus(auditText: string, description: string): AuditStatus {
  if (!hasExplicitCriteria(description)) {
    return 'Missing Criteria';
  }

  const text = auditText.toLowerCase();

  // Strong completion signals (all criteria must be satisfied)
  const completePatterns = [
    /\ball criteria (met|satisfied|complete)\b/,
    /\bfully (complete|done|finished|implemented)\b/,
    /\bcomplete\b.*\ball\b/,
    /\ball (done|complete|finished)\b/,
    /\bimplementation complete\b/,
    /\bdelivery complete\b/,
  ];
  if (completePatterns.some(p => p.test(text))) {
    return 'Complete';
  }

  // Partial-progress signals
  const partialPatterns = [
    /\bpartially\b/,
    /\bin progress\b/,
    /\bsome criteria\b/,
    /\bpartial\b/,
    /\bincomplete\b/,
    /\bremaining\b/,
    /\bnot all\b/,
    /\bpending\b/,
    /\bwork in progress\b/,
    /\bwip\b/,
  ];
  if (partialPatterns.some(p => p.test(text))) {
    return 'Partial';
  }

  // Default conservative
  return 'Not Started';
}

/**
 * Get the current user identity for audit authorship.
 * Returns the OS username, falling back to 'unknown' if unavailable.
 */
export function getCurrentUser(): string {
  try {
    return os.userInfo().username || 'unknown';
  } catch {
    return process.env.USER || process.env.USERNAME || 'unknown';
  }
}

/**
 * Build a complete AuditEntry from freeform text and the work item description.
 * Populates `time` from now, `author` from the current OS user,
 * and derives `status` conservatively.
 */
export function buildAuditEntry(auditText: string, description: string): AuditEntry {
  return {
    time: new Date().toISOString(),
    author: getCurrentUser(),
    text: auditText,
    status: deriveAuditStatus(auditText, description),
  };
}
