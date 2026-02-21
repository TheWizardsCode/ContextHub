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
  reset: () => void;
  dispose: () => void;
};

export function initAutocomplete(
  widgets: { textarea: any; suggestionHint: any },
  options?: { availableCommands?: string[] }
): AutocompleteInstance {
  const { textarea, suggestionHint } = widgets;
  let availableCommands: string[] = options?.availableCommands ?? [];
  let currentSuggestion: string | null = null;

  const renderSuggestion = () => {
    try {
      if (currentSuggestion) {
        suggestionHint.setContent(`{gray-fg}↳ ${currentSuggestion}{/gray-fg}`);
      } else {
        suggestionHint.setContent('');
      }
    } catch (_) {}
  };

  const updateFromValue = () => {
    try {
      const value = typeof textarea.getValue === 'function' ? textarea.getValue() : '';
      const suggestion = computeSuggestion(value, availableCommands);
      currentSuggestion = suggestion;
      renderSuggestion();
    } catch (_) {}
  };

  const applySuggestion = (target: any) => {
    if (!currentSuggestion) return null;
    const nextValue = currentSuggestion + ' ';
    try { if (typeof target.setValue === 'function') target.setValue(nextValue); } catch (_) {}
    // leave cursor positioning to the caller (controller) since it has
    // the helper to map visual cursor indices.
    currentSuggestion = null;
    renderSuggestion();
    return nextValue;
  };

  const updateAvailableCommands = (commands: string[]) => {
    availableCommands = Array.isArray(commands) ? commands.slice() : [];
  };

  const reset = () => {
    currentSuggestion = null;
    try { suggestionHint.setContent(''); } catch (_) {}
  };

  const dispose = () => {
    // No event listeners attached by this module — controller wires input
    // events and calls updateFromValue as needed. Keep API for symmetry.
    reset();
  };

  return { updateFromValue, applySuggestion, updateAvailableCommands, reset, dispose };
}

export default initAutocomplete;
