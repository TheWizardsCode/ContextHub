import { describe, it, expect, vi } from 'vitest';
import initAutocomplete, { computeSuggestion } from '../../src/tui/opencode-autocomplete.js';

describe('opencode autocomplete widget integration', () => {
  it('updates suggestionHint when textarea value changes', () => {
    const textarea = { getValue: () => '/c' } as any;
    const suggestionHint = { setContent: vi.fn() } as any;
    const inst = initAutocomplete({ textarea, suggestionHint }, { availableCommands: ['/create', '/commit'] });
    inst.updateFromValue();
    expect(suggestionHint.setContent).toHaveBeenCalledWith('{gray-fg}↳ /create [Tab]{/gray-fg}');
    inst.dispose();
  });

  it('applySuggestion sets textarea value and clears hint', () => {
    const textarea = { getValue: () => '/c', setValue: vi.fn() } as any;
    const suggestionHint = { setContent: vi.fn() } as any;
    const inst = initAutocomplete({ textarea, suggestionHint }, { availableCommands: ['/create', '/commit'] });
    inst.updateFromValue();
    const res = inst.applySuggestion(textarea);
    expect(textarea.setValue).toHaveBeenCalledWith('/create ');
    expect(res).toBe('/create ');
    expect(suggestionHint.setContent).toHaveBeenCalledWith('');
    inst.dispose();
  });
});
