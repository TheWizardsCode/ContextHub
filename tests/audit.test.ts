import { describe, expect, it } from 'vitest';
import { buildAuditEntry } from '../src/audit.js';

describe('buildAuditEntry', () => {
  it('builds an audit entry with generated time and author', () => {
    const entry = buildAuditEntry('Applied DB migration');

    expect(entry.text).toBe('Applied DB migration');
    expect(entry.author).toBeTruthy();
    expect(entry.time).toMatch(/Z$/);
  });

  it('uses explicit author when provided', () => {
    const entry = buildAuditEntry('Manual handoff', 'cli-user');

    expect(entry.author).toBe('cli-user');
    expect(entry.text).toBe('Manual handoff');
  });

  it('does not add status to audit entries', () => {
    const entry = buildAuditEntry('Any text');
    expect((entry as any).status).toBeUndefined();
  });
});
