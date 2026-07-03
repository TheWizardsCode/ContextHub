/**
 * lib/shortcuts.ts — Keyboard shortcut detection and navigation helpers
 *
 * Extracted from the monolithic index.ts. Provides raw terminal input
 * matching functions and the set of reserved navigation keys that cannot
 * be overridden by config-driven shortcuts.
 */

/**
 * Lazy-loaded reference to Pi's matchesKey() for cross-platform keyboard input.
 * When the extension runs inside Pi, this uses @earendil-works/pi-tui's
 * matchesKey() which handles all terminal escape sequences (legacy and Kitty
 * protocol). Falls back to raw ANSI comparison when Pi's TUI is not available
 * (e.g., during testing outside the Pi runtime).
 */
export let _matchesKey: ((data: string, keyId: string) => boolean) | null = null;

try {
  const { matchesKey } = await import('@earendil-works/pi-tui');
  _matchesKey = matchesKey;
} catch {
  // Pi TUI not available — fall back to raw ANSI sequence comparison
}

/**
 * Set of single-character keys that are reserved for navigation and MUST NOT
 * be overridable by config-driven shortcuts.
 *
 * Currently:
 * - `g` — scroll to top (detail view scrollable widget)
 * - `G` — scroll to bottom (detail view scrollable widget)
 * - ` ` — page down (detail view scrollable widget, via isPageDownKey)
 *
 * Multi-character navigation keys (e.g., escape sequences for arrow keys,
 * key-id strings like "enter", "escape", "up", "down") are already excluded
 * from shortcut lookup because the dispatcher only checks `data.length === 1`.
 */
export const RESERVED_NAVIGATION_KEYS = new Set(['g', 'G', ' ']);

// ── Keyboard helpers ──────────────────────────────────────────────────

export function isUpKey(data: string): boolean {
  if (_matchesKey) return _matchesKey(data, 'up');
  return data === '\u001b[A' || data === 'up' || /^\u001b\[1;\d+(?::\d+)?A$/.test(data);
}

export function isDownKey(data: string): boolean {
  if (_matchesKey) return _matchesKey(data, 'down');
  return data === '\u001b[B' || data === 'down' || /^\u001b\[1;\d+(?::\d+)?B$/.test(data);
}

export function isPageUpKey(data: string): boolean {
  if (_matchesKey) return _matchesKey(data, 'pageUp');
  return (
    data === '\u001b[5~'
    || data === '\u001b[[5~'
    || data === 'pageup'
    || data === 'pageUp'
    || /^\u001b\[5;\d+(?::\d+)?~$/.test(data)
  );
}

export function isPageDownKey(data: string): boolean {
  if (_matchesKey) return _matchesKey(data, 'pageDown');
  return (
    data === '\u001b[6~'
    || data === '\u001b[[6~'
    || data === 'pagedown'
    || data === 'pageDown'
    || data === ' '
    || data === 'space'
    || /^\u001b\[6;\d+(?::\d+)?~$/.test(data)
  );
}

export function isEnterKey(data: string): boolean {
  if (_matchesKey) return _matchesKey(data, 'enter');
  return data === '\r' || data === '\n' || data === 'enter' || data === 'return';
}

export function isCtrlEnterKey(data: string): boolean {
  if (_matchesKey) return _matchesKey(data, 'ctrl+enter');
  // Fallback: Kitty protocol CSI-u sequences for Ctrl+Enter
  // Also support raw ANSI with modifyOtherKeys (CSI 27;5;13~)
  return (
    data === '\u001b[13;5u'
    || data === '\u001b[27;5;13~'
    || data === 'ctrl+enter'
    || data === 'ctrl+return'
  );
}

export function isEscapeKey(data: string): boolean {
  if (_matchesKey) return _matchesKey(data, 'escape');
  return data === '\u001b' || data === 'escape';
}
