import { describe, expect, it } from 'vitest';
import { buildAuditEntry, formatInvalidAuditFirstLineMessage, inspectAuditFirstLine } from '../src/audit.js';

describe('buildAuditEntry', () => {
  it('builds an audit entry with generated time and author', () => {
    const entry = buildAuditEntry('Ready to close: Yes\nApplied DB migration');

    expect(entry.text).toBe('Ready to close: Yes\nApplied DB migration');
    expect(entry.author).toBeTruthy();
    expect(entry.time).toMatch(/Z$/);
    expect(entry.status).toBe('Complete');
  });

  it('uses explicit author when provided', () => {
    const entry = buildAuditEntry('Ready to close: No\nManual handoff', 'cli-user');

    expect(entry.author).toBe('cli-user');
    expect(entry.text).toBe('Ready to close: No\nManual handoff');
    expect(entry.status).toBe('Partial');
  });

  it('sets Missing Criteria status for invalid first line', () => {
    const entry = buildAuditEntry('Any text');
    expect(entry.status).toBe('Missing Criteria');
  });

  it('inspects first line and formats detailed invalid message', () => {
    const inspection = inspectAuditFirstLine('┃ Ready to close: No');
    expect(inspection.isValid).toBe(false);
    expect(inspection.trimmedFirstNonEmptyLine).toBe('┃ Ready to close: No');
    expect(inspection.hasGutterChars).toBe(true);

    const message = formatInvalidAuditFirstLineMessage(inspection);
    expect(message).toContain("First non-empty line must be 'Ready to close: Yes' or 'Ready to close: No'");
    expect(message).toContain("Found: '┃ Ready to close: No'");
    expect(message).toContain('gutterChars=yes');
  });
});
