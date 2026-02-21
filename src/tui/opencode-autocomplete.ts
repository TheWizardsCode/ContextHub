/**
 * Extracted OpenCode autocomplete logic.
 * Provides a small, testable API for computing and rendering slash-command
 * suggestions for the TUI input widget.
 */

// Avoid importing Pane type from controller to prevent circular/type issues.

export function computeSuggestion(input: string, commands: string[]): string | null {
  if (!input) return null;
  const lines = input.split('\n');
  const first = lines[0] ?? '';
  if (!first.startsWith('/') || lines.length !== 1) return null;
  const low = first.toLowerCase();
  const matches = commands.filter(cmd => cmd.toLowerCase().startsWith(low));
  if (matches.length === 0) return null;
  if (matches[0] === low) return null;
  return matches[0];
}

export type AutocompleteInstance = {
  updateFromValue: () => void;
  applySuggestion: (target: any) => string | null;
  updateAvailableCommands: (commands: string[]) => void;
  hasSuggestion: () => boolean;
  reset: () => void;
  dispose: () => void;
};

export function initAutocomplete(
  widgets: { textarea: any; suggestionHint: any },
  options?: { availableCommands?: string[]; onSuggestionChange?: (active: boolean) => void }
): AutocompleteInstance {
  const { textarea, suggestionHint } = widgets;
  let availableCommands: string[] = options?.availableCommands ?? [];
  let currentSuggestion: string | null = null;
  const onSuggestionChange = options?.onSuggestionChange;

  const renderSuggestion = () => {
    try {
      if (currentSuggestion) {
        suggestionHint.setContent(`{gray-fg}↳ ${currentSuggestion}{/gray-fg}`);
        try { suggestionHint.show?.(); } catch (_) {}
      } else {
        suggestionHint.setContent('');
        try { suggestionHint.hide?.(); } catch (_) {}
      }
    } catch (_) {}
  };

  const updateFromValue = () => {
    try {
      const value = typeof textarea.getValue === 'function' ? textarea.getValue() : '';
      const suggestion = computeSuggestion(value, availableCommands);
      const wasActive = currentSuggestion !== null;
      currentSuggestion = suggestion;
      renderSuggestion();
      const isActive = currentSuggestion !== null;
      if (wasActive !== isActive) {
        try { onSuggestionChange?.(isActive); } catch (_) {}
      }
    } catch (_) {}
  };

  const applySuggestion = (target: any) => {
    if (!currentSuggestion) return null;
    const nextValue = currentSuggestion + ' ';
    try { if (typeof target.setValue === 'function') target.setValue(nextValue); } catch (_) {}
    // leave cursor positioning to the caller (controller) since it has
    // the helper to map visual cursor indices.
    const wasActive = true;
    currentSuggestion = null;
    renderSuggestion();
    try { onSuggestionChange?.(false); } catch (_) {}
    return nextValue;
  };

  const updateAvailableCommands = (commands: string[]) => {
    availableCommands = Array.isArray(commands) ? commands.slice() : [];
  };

  const hasSuggestion = () => currentSuggestion !== null;

  const reset = () => {
    const wasActive = currentSuggestion !== null;
    currentSuggestion = null;
    try { suggestionHint.setContent(''); } catch (_) {}
    try { suggestionHint.hide?.(); } catch (_) {}
    if (wasActive) {
      try { onSuggestionChange?.(false); } catch (_) {}
    }
  };

  const dispose = () => {
    // No event listeners attached by this module — controller wires input
    // events and calls updateFromValue as needed. Keep API for symmetry.
    reset();
  };

  return { updateFromValue, applySuggestion, updateAvailableCommands, hasSuggestion, reset, dispose };
}

export default initAutocomplete;
