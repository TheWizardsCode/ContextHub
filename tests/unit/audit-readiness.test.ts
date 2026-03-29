import { describe, it, expect } from 'vitest';
import { parseReadinessLine } from '../../src/audit.js';

describe('parseReadinessLine', () => {
  it('detects Complete from explicit tokens', () => {
    expect(parseReadinessLine('Complete by tests\nDetails here')).toBe('Complete');
    expect(parseReadinessLine('ready to close: yes')).toBe('Complete');
    expect(parseReadinessLine('Done - verified')).toBe('Complete');
  });

  it('detects Partial', () => {
    expect(parseReadinessLine('Partial: missing docs')).toBe('Partial');
    expect(parseReadinessLine('Needs work on the integration tests')).toBe('Partial');
  });

  it('detects Not Started', () => {
    expect(parseReadinessLine('Not started yet')).toBe('Not Started');
    expect(parseReadinessLine('TODO: implement feature')).toBe('Not Started');
  });

  it('returns Missing Criteria when ambiguous', () => {
    expect(parseReadinessLine('Some freeform note without status')).toBe('Missing Criteria');
    expect(parseReadinessLine('')).toBe('Missing Criteria');
  });
});
