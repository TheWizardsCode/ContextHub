import { describe, it, expect } from 'vitest';
import { redactAuditText } from '../../src/audit.js';

describe('redactAuditText', () => {
  it('redacts simple email', () => {
    expect(redactAuditText('Contact alice@example.com for help')).toBe('Contact a***@example.com for help');
  });

  it('redacts complex local parts and preserves domain', () => {
    expect(redactAuditText('Notify first.last+tag@sub.domain.co.uk ASAP')).toBe('Notify f***@sub.domain.co.uk ASAP');
  });

  it('redacts single-char local part', () => {
    expect(redactAuditText('Short a@x.io end')).toBe('Short a***@x.io end');
  });

  it('does not redact invalid email-like strings', () => {
    expect(redactAuditText('not-an-email@ and user@localhost should stay')).toBe('not-an-email@ and user@localhost should stay');
  });
});
