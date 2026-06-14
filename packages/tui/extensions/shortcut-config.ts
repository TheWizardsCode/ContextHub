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
 * - stages (string[]): optional allow-list of item stages for which the shortcut
 *   is available. When undefined or empty, the shortcut is unconditionally
 *   available (backward compatible).
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
  /**
   * Optional allow-list of item stages for which the shortcut is available.
   * When undefined or empty, the shortcut is unconditionally available.
   * Example: ["idea"] means the shortcut only appears for items in the "idea" stage.
   */
  stages?: string[];
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
   * Look up a shortcut by key, view, and optional stage.
   *
   * Returns the command string for the first matching entry, or `undefined`
   * if no entry matches.  An entry matches when:
   * - its `key` equals the given key
   * - its `view` is either `"both"` or exactly matches the given view string
   * - if `stage` is provided, the entry's `stages` allow-list is either
   *   undefined/empty, or includes the given stage value
   *
   * @param key - The pressed key (e.g. "i")
   * @param view - The current view ("list" or "detail")
   * @param stage - Optional item stage to filter by (e.g. "idea", "intake_complete")
   * @returns The command string or undefined
   */
  lookup(key: string, view: string, stage?: string): string | undefined {
    const match = this.entries.find(entry => {
      if (entry.key !== key) return false;
      if (entry.view !== 'both' && entry.view !== view) return false;
      // If stage is provided, check the stages allow-list
      if (stage !== undefined && entry.stages !== undefined && entry.stages.length > 0) {
        if (!entry.stages.includes(stage)) return false;
      }
      return true;
    });
    return match?.command;
  }

  /**
   * Return all entries that should be visible for the given stage.
   *
   * Entries with no `stages` constraint (or empty array) are always included.
   * Entries with a `stages` array are only included if it contains the given stage.
   *
   * @param stage - The item stage to filter by
   * @returns Entries applicable for the given stage
   */
  getEntriesForStage(stage?: string): ShortcutEntry[] {
    return this.entries.filter(entry => {
      if (entry.stages === undefined || entry.stages.length === 0) return true;
      if (stage === undefined) return false;
      return entry.stages.includes(stage);
    });
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

    // Validate optional stages field
    const stages = entry.stages;
    if (stages !== undefined) {
      if (!Array.isArray(stages)) {
        console.warn(
          `[shortcut-config] Skipping entry at index ${i}: "stages" must be an array of strings`,
        );
        continue;
      }
      for (let j = 0; j < stages.length; j++) {
        if (typeof stages[j] !== 'string') {
          console.warn(
            `[shortcut-config] Skipping entry at index ${i}: "stages" entry at index ${j} is not a string`,
          );
          continue;
        }
      }
    }

    const shortcutEntry: ShortcutEntry = {
      key,
      command,
      view: view as 'list' | 'detail' | 'both',
    };

    // Only include stages if it is a non-empty array of strings
    if (
      Array.isArray(stages) &&
      stages.length > 0 &&
      stages.every((s: unknown) => typeof s === 'string')
    ) {
      shortcutEntry.stages = stages as string[];
    }

    validEntries.push(shortcutEntry);
  }

  if (validEntries.length === 0 && parsed.length > 0) {
    console.warn(`[shortcut-config] No valid entries in shortcuts.json; all entries were invalid`);
  }

  return new ShortcutRegistry(validEntries);
}
