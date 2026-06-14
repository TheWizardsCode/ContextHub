/**
 * Config-driven shortcut key system for the worklog browse extension.
 *
 * Reads `shortcuts.json` from the extension directory at initialization,
 * builds a lookup registry, and provides a `lookup(key, view)` API used by
 * the dynamic dispatchers in the browse list and detail view.
 *
 * The shortcut system replaces the need for hardcoded `handleInput()` key
 * handlers. Each shortcut is defined in `shortcuts.json` with a key, command
 * template, and view scope. When a key is pressed, the registry looks up the
 * matching command and inserts it into the editor via `ctx.ui.setEditorText()`.
 *
 * Config entry schema:
 * - key (string): single key (e.g. "i", "p")
 * - command (string): text to insert into editor (e.g. "implement <id>")
 * - view ("list" | "detail" | "both"): which view the shortcut applies in
 * - <id> placeholder: replaced at dispatch time with the selected work item ID
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * A single shortcut entry as defined in shortcuts.json.
 */
export interface ShortcutEntry {
  key: string;
  command: string;
  view: 'list' | 'detail' | 'both';
}

/**
 * Registry of loaded shortcut entries with lookup capability.
 *
 * The registry stores entries by key and provides a `lookup(key, view)`
 * method that returns the matching command string (with `<id>` replaced)
 * or `undefined` if no entry matches the given key + view combination.
 */
export class ShortcutRegistry {
  private entries: ShortcutEntry[];

  constructor(entries: ShortcutEntry[]) {
    this.entries = entries;
  }

  /**
   * Look up a shortcut by key and view.
   *
   * Returns the command string for the first matching entry, or `undefined`
   * if no entry matches.  An entry matches when its `key` equals the given
   * key **and** its `view` is either `"both"` or exactly matches the given
   * view string.
   *
   * @param key - The pressed key (e.g. "i")
   * @param view - The current view ("list" or "detail")
   * @returns The command string or undefined
   */
  lookup(key: string, view: string): string | undefined {
    const match = this.entries.find(entry => {
      if (entry.key !== key) return false;
      if (entry.view === 'both') return true;
      return entry.view === view;
    });
    return match?.command;
  }

  /**
   * Return all entries in the registry (for testing / introspection).
   */
  getEntries(): ReadonlyArray<ShortcutEntry> {
    return this.entries;
  }
}

/**
 * Load and validate shortcut config from shortcuts.json.
 *
 * - Missing file → returns empty registry (no shortcuts, graceful degradation)
 * - Malformed JSON → returns empty registry with console.error (no crash)
 * - Invalid entries → skipped with console.warn; valid entries are kept
 *
 * @returns A ShortcutRegistry instance (may be empty)
 */
export function loadShortcutConfig(): ShortcutRegistry {
  const configPath = join(__dirname, 'shortcuts.json');

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    // File not found — graceful degradation, no error
    return new ShortcutRegistry([]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`[shortcut-config] Malformed shortcuts.json: unable to parse JSON`);
    return new ShortcutRegistry([]);
  }

  if (!Array.isArray(parsed)) {
    console.error('[shortcut-config] shortcuts.json must be a JSON array');
    return new ShortcutRegistry([]);
  }

  const validEntries: ShortcutEntry[] = [];
  const validViews = new Set(['list', 'detail', 'both']);

  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i] as Record<string, unknown>;

    // Validate required fields
    if (!entry || typeof entry !== 'object') {
      console.warn(`[shortcut-config] Skipping invalid entry at index ${i}: not an object`);
      continue;
    }

    const key = entry.key;
    const command = entry.command;
    const view = entry.view;

    if (!key || typeof key !== 'string') {
      console.warn(`[shortcut-config] Skipping entry at index ${i}: missing or invalid "key" field`);
      continue;
    }

    if (!command || typeof command !== 'string') {
      console.warn(`[shortcut-config] Skipping entry at index ${i}: missing or invalid "command" field`);
      continue;
    }

    if (!view || typeof view !== 'string') {
      console.warn(`[shortcut-config] Skipping entry at index ${i}: missing or invalid "view" field`);
      continue;
    }

    if (!validViews.has(view)) {
      console.warn(
        `[shortcut-config] Skipping entry at index ${i}: unknown "view" value "${view}"`,
      );
      continue;
    }

    validEntries.push({
      key,
      command,
      view: view as 'list' | 'detail' | 'both',
    });
  }

  if (validEntries.length === 0 && parsed.length > 0) {
    console.warn(`[shortcut-config] No valid entries in shortcuts.json; all entries were invalid`);
  }

  return new ShortcutRegistry(validEntries);
}
