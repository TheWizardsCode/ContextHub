import { describe, it, expect } from 'vitest';
import { computeSuggestion } from '../../src/tui/opencode-autocomplete.js';

describe('opencode autocomplete computeSuggestion', () => {
  const commands = ['/create', '/commit', '/help', '/open'];

  it('returns null for empty input', () => {
    expect(computeSuggestion('', commands)).toBeNull();
  });

  it('returns null when not in command mode', () => {
    expect(computeSuggestion('hello', commands)).toBeNull();
    expect(computeSuggestion('/multi\nline', commands)).toBeNull();
  });

  it('finds matching command', () => {
    expect(computeSuggestion('/c', commands)).toBe('/create');
    expect(computeSuggestion('/co', commands)).toBe('/commit');
  });

  it('returns null when exact command typed', () => {
    expect(computeSuggestion('/create', commands)).toBeNull();
  });
});
