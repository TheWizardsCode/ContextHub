import { describe, it, expect } from 'vitest';
import { parseReadinessLine } from '../../src/audit.js';

describe('parseReadinessLine', () => {
  it('returns Complete for exact first-line token Ready to close: Yes', () => {
    expect(parseReadinessLine('Ready to close: Yes\nDetails here')).toBe('Complete');
    expect(parseReadinessLine('   Ready to close: Yes   \nmore')).toBe('Complete');
    expect(parseReadinessLine('\n\nReady to close: Yes')).toBe('Complete');
  });

  it('returns Partial for exact first-line token Ready to close: No', () => {
    expect(parseReadinessLine('Ready to close: No\nDetails here')).toBe('Partial');
    expect(parseReadinessLine('   Ready to close: No   ')).toBe('Partial');
    expect(parseReadinessLine('\nReady to close: No')).toBe('Partial');
  });

  it('returns Missing Criteria for missing/invalid first line', () => {
    expect(parseReadinessLine('Some freeform note without status')).toBe('Missing Criteria');
    expect(parseReadinessLine('Ready to close')).toBe('Missing Criteria');
    expect(parseReadinessLine('ready to close: yes')).toBe('Missing Criteria');
    expect(parseReadinessLine('┃ Ready to close: No')).toBe('Missing Criteria');
    expect(parseReadinessLine('')).toBe('Missing Criteria');
  });
});
