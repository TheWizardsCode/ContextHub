/**
 * editor-shortcuts.ts — Editor shortcut mode for the Worklog extension.
 *
 * Provides an in-editor shortcut mode that allows users to press a leader key
 * combination (default: Ctrl+Shift+W) to activate a shortcut mode while the
 * editor is active, then use single-key and chord shortcuts from shortcuts.json
 * to insert commands into the editor with the current work item ID.
 *
 * ## Architecture
 *
 * - **CurrentItemTracker**: Tracks the most recently interacted-with work item
 *   ID. Populated from browse selection, command detection, or explicit set.
 * - **ShortcutModeManager**: State machine managing shortcut mode lifecycle.
 *   Uses Pi's ctx.ui.onTerminalInput() API to intercept raw terminal input.
 * - **registerEditorShortcutMode()**: Registers the terminal input handler
 *   with the Pi extension on session_start.
 *
 * ## States
 *
 * - `inactive`: Normal editor mode. All keystrokes pass through unchanged.
 * - `active`: Shortcut mode. Single-key shortcuts and chord leaders are
 *   intercepted. Non-matching keys exit shortcut mode.
 * - `chord_pending`: A chord leader has been pressed; waiting for the second
 *   key in the chord sequence. Escape or non-matching key exits.
 *
 * ## Related
 *
 * - shortcuts.json — the shortcut definitions consumed by ShortcutManager
 * - shortcut-config.ts — ShortcutRegistry class with lookup/lookupChord
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { ShortcutRegistry } from './shortcut-config.js';
import {
  _matchesKey,
  isEscapeKey,
  RESERVED_NAVIGATION_KEYS,
} from './lib/shortcuts.js';

// ── Constants ─────────────────────────────────────────────────────────

/** Status key used for the shortcut mode indicator in the footer. */
export const SHORTCUT_MODE_STATUS_KEY = 'worklog-shortcut-mode';

/** Default leader key combination to toggle shortcut mode. */
const DEFAULT_LEADER_KEY = 'ctrl+shift+w';

// ── Types ─────────────────────────────────────────────────────────────

type ShortcutModeState = 'inactive' | 'active' | 'chord_pending';

export type GetCurrentIdFn = () => string | null;
export type GetShortcutRegistryFn = () => ShortcutRegistry;

/**
 * Lazy key matcher that wraps Pi's `matchesKey()` when available, falling
 * back to raw byte comparison when Pi TUI is unavailable (e.g., tests or
 * environments where `@earendil-works/pi-tui` is not installed).
 *
 * The `_matchesKey` reference is lazily evaluated at first call so that
 * module mocking in tests works correctly.
 */
function createKeyMatcher(): (data: string, keyId: string) => boolean {
  // Use Pi's matchesKey when available (handles Kitty protocol, etc.)
  if (_matchesKey) {
    return _matchesKey;
  }

  // Fallback: simple byte comparison for common key identifiers.
  // This does NOT distinguish Ctrl+Shift+W from plain Ctrl+W in most
  // terminals, but provides basic functionality for development/testing.
  return (data: string, keyId: string): boolean => {
    switch (keyId) {
      case 'ctrl+shift+w':
      case 'ctrl+w':
        return data === '\x17'; // ETB / Ctrl+W byte
      case 'escape':
        return data === '\x1b' || data === 'escape';
      case 'ctrl+a':
        return data === '\x01';
      case 'ctrl+b':
        return data === '\x02';
      case 'ctrl+c':
        return data === '\x03';
      case 'ctrl+d':
        return data === '\x04';
      case 'ctrl+e':
        return data === '\x05';
      case 'ctrl+f':
        return data === '\x06';
      default:
        return false;
    }
  };
}

// ── Current Item Tracker ──────────────────────────────────────────────

/**
 * Tracks the current work item ID for use in editor shortcuts.
 *
 * The current work item ID is determined by:
 * - Items selected in the browse list
 * - Work item IDs detected in typed commands
 * - Explicitly set via `setCurrentId()`
 *
 * This is an in-memory tracker; it does not persist across sessions.
 */
export class CurrentItemTracker {
  private currentId: string | null = null;

  /**
   * Get the current work item ID, or `null` if none is tracked.
   */
  getCurrentId(): string | null {
    return this.currentId;
  }

  /**
   * Set the current work item ID. Pass `null` to clear.
   */
  setCurrentId(id: string | null): void {
    this.currentId = id;
  }

  /**
   * Clear the current work item ID.
   */
  clear(): void {
    this.currentId = null;
  }
}

// ── Shortcut Mode Manager ─────────────────────────────────────────────

/**
 * Manages the editor shortcut mode lifecycle.
 *
 * State machine:
 *   inactive → (leader key + current ID) → active
 *   active → (leader key | Escape) → inactive
 *   active → (chord leader) → chord_pending
 *   chord_pending → (second key matches chord) → inactive + dispatch
 *   chord_pending → (Escape | non-matching key) → inactive
 *   active → (non-matching key) → inactive
 *   active → (reserved nav key) → inactive (pass through)
 *
 * The manager is typically registered via `registerEditorShortcutMode()`
 * and wired up through a Pi extension's `session_start` event.
 */
export class ShortcutModeManager {
  private state: ShortcutModeState = 'inactive';
  private pendingChordLeader: string | null = null;
  private getCurrentId: GetCurrentIdFn;
  private getShortcutRegistry: GetShortcutRegistryFn;
  private setEditorTextFn: ((text: string) => void) | null = null;
  private setStatusFn: ((key: string, text: string | undefined) => void) | null = null;
  private leaderKey: string;
  private matchesKey: (data: string, keyId: string) => boolean;

  /**
   * @param getCurrentId - Function that returns the current work item ID (or null)
   * @param getShortcutRegistry - Function that returns the ShortcutRegistry instance
   * @param options - Optional configuration
   * @param options.leaderKey - Key identifier for the leader key combo (default: 'ctrl+shift+w')
   */
  constructor(
    getCurrentId: GetCurrentIdFn,
    getShortcutRegistry: GetShortcutRegistryFn,
    options?: { leaderKey?: string },
  ) {
    this.getCurrentId = getCurrentId;
    this.getShortcutRegistry = getShortcutRegistry;
    this.leaderKey = options?.leaderKey ?? DEFAULT_LEADER_KEY;
    this.matchesKey = createKeyMatcher();
  }

  /**
   * Initialize the manager with UI functions.
   *
   * Called when the session context becomes available (e.g., in session_start).
   *
   * @param ui - Object with setEditorText and/or setStatus functions
   */
  init(ui: {
    setEditorText?: (text: string) => void;
    setStatus?: (key: string, text: string | undefined) => void;
  }): void {
    this.setEditorTextFn = ui.setEditorText ?? null;
    this.setStatusFn = ui.setStatus ?? null;
  }

  /**
   * Handle incoming terminal input.
   *
   * Called from the onTerminalInput handler. Returns `{ consume: true }` if
   * the input was consumed by shortcut mode, or `undefined` to pass through.
   *
   * @param data - Raw terminal input data
   * @returns `{ consume: true }` if consumed, `undefined` to pass through
   */
  handleInput(data: string): { consume?: boolean } | undefined {
    // ── Leader key toggle ────────────────────────────────────────
    if (this.matchesKey(data, this.leaderKey)) {
      if (this.state === 'inactive') {
        const currentId = this.getCurrentId();
        if (!currentId) {
          // No current work item context — ignore the leader key
          return undefined;
        }
        // Activate shortcut mode
        this.state = 'active';
        this.updateIndicator();
        return { consume: true };
      }

      // Deactivate shortcut mode (toggle off)
      this.state = 'inactive';
      this.pendingChordLeader = null;
      this.updateIndicator();
      return { consume: true };
    }

    // If inactive, pass all input through
    if (this.state === 'inactive') {
      return undefined;
    }

    // ── Escape exits shortcut mode ──────────────────────────────
    if (isEscapeKey(data)) {
      this.state = 'inactive';
      this.pendingChordLeader = null;
      this.updateIndicator();
      return { consume: true };
    }

    // At this point, we're in active or chord_pending state.
    // Only single-character keys are valid shortcuts.
    const lookupKey = data.length === 1 ? data : undefined;

    // ── Chord pending state ─────────────────────────────────────
    if (this.state === 'chord_pending' && this.pendingChordLeader && lookupKey) {
      const registry = this.getShortcutRegistry();
      const chordCommand = registry.lookupChord(
        [this.pendingChordLeader, lookupKey],
        'detail',
      );

      if (chordCommand) {
        const currentId = this.getCurrentId();
        if (currentId) {
          this.dispatchCommand(chordCommand, currentId);
        }
      }

      // Always exit chord state and shortcut mode
      this.state = 'inactive';
      this.pendingChordLeader = null;
      this.updateIndicator();
      return { consume: true };
    }

    // Multi-character data (arrow keys, function keys, etc.) — exit mode
    if (!lookupKey) {
      this.state = 'inactive';
      this.pendingChordLeader = null;
      this.updateIndicator();
      return undefined;
    }

    // Reserved navigation keys pass through and exit shortcut mode
    if (RESERVED_NAVIGATION_KEYS.has(lookupKey)) {
      this.state = 'inactive';
      this.pendingChordLeader = null;
      this.updateIndicator();
      return undefined;
    }

    // ── Look up shortcut from registry ───────────────────────────
    const registry = this.getShortcutRegistry();
    const currentId = this.getCurrentId();

    if (!currentId) {
      // Current item vanished between activation and dispatch
      this.state = 'inactive';
      this.pendingChordLeader = null;
      this.updateIndicator();
      return undefined;
    }

    // Try single-key lookup
    const singleCommand = registry.lookup(lookupKey, 'detail');
    if (singleCommand) {
      this.dispatchCommand(singleCommand, currentId);
      this.state = 'inactive';
      this.pendingChordLeader = null;
      this.updateIndicator();
      return { consume: true };
    }

    // Try chord leader lookup
    const chords = registry.getChordByLeader(lookupKey, 'detail');
    if (chords.length > 0) {
      this.state = 'chord_pending';
      this.pendingChordLeader = lookupKey;
      this.updateIndicator();
      return { consume: true };
    }

    // No match — exit shortcut mode and pass through
    this.state = 'inactive';
    this.pendingChordLeader = null;
    this.updateIndicator();
    return undefined;
  }

  /**
   * Whether shortcut mode is currently active (either active or chord_pending).
   */
  isActive(): boolean {
    return this.state !== 'inactive';
  }

  /**
   * Get the current state for testing/introspection.
   */
  getState(): ShortcutModeState {
    return this.state;
  }

  /**
   * Reset shortcut mode to inactive, clearing any pending chord state.
   */
  reset(): void {
    this.state = 'inactive';
    this.pendingChordLeader = null;
    this.updateIndicator();
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Replace `<id>` placeholder with the current work item ID and insert
   * the resolved command into the editor.
   */
  private dispatchCommand(command: string, currentId: string): void {
    const resolved = command.replace(/<id>/g, currentId);
    if (this.setEditorTextFn) {
      this.setEditorTextFn(resolved);
    }
  }

  /**
   * Update the footer status indicator based on the current state.
   *
   * - inactive: hide indicator
   * - active: show "🔧 WL"
   * - chord_pending: show "🔧 WL <leader>…"
   */
  private updateIndicator(): void {
    if (!this.setStatusFn) return;

    switch (this.state) {
      case 'inactive':
        this.setStatusFn(SHORTCUT_MODE_STATUS_KEY, undefined);
        break;
      case 'active':
        this.setStatusFn(SHORTCUT_MODE_STATUS_KEY, '🔧 WL');
        break;
      case 'chord_pending':
        this.setStatusFn(SHORTCUT_MODE_STATUS_KEY, `🔧 WL ${this.pendingChordLeader}…`);
        break;
    }
  }
}

// ── Registration function ─────────────────────────────────────────────

/**
 * Register the editor shortcut mode with the Pi extension.
 *
 * Sets up:
 * - `session_start` event handler that registers the terminal input handler
 *   via `ctx.ui.onTerminalInput()` when the UI context becomes available.
 *
 * @param pi - The ExtensionAPI instance
 * @param shortcutModeManager - The ShortcutModeManager instance
 */
export function registerEditorShortcutMode(
  pi: ExtensionAPI,
  shortcutModeManager: ShortcutModeManager,
): void {
  pi.on('session_start', async (_event, ctx) => {
    const ui = ctx.ui as {
      onTerminalInput?: (
        handler: (data: string) => { consume?: boolean; data?: string } | undefined,
      ) => () => void;
      setEditorText?: (text: string) => void;
      setStatus?: (key: string, text: string | undefined) => void;
    };

    if (typeof ui.onTerminalInput === 'function') {
      // Initialize the manager with the UI context
      shortcutModeManager.init({
        setEditorText: ui.setEditorText,
        setStatus: ui.setStatus,
      });

      // Register the terminal input handler
      const unsubscribe = ui.onTerminalInput((data: string) => {
        return shortcutModeManager.handleInput(data);
      });

      // Store the unsubscribe function as a non-enumerable property
      // so the manager can clean up if needed.
      Object.defineProperty(shortcutModeManager, '_unsubscribe', {
        value: unsubscribe,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  });
}
