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
 * - key (string): single key (e.g. "i", "p") — mutually exclusive with `chord`
 * - chord (string[]): multi-key chord (e.g. ["u", "p"]) — mutually exclusive with `key`
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
  /**
   * Single key for immediate dispatch (e.g. "i", "p").
   * Mutually exclusive with `chord` — exactly one of `key` or `chord` must be set.
   */
  key: string;
  command: string;
  view: 'list' | 'detail' | 'both';
  /**
   * Optional chord sequence (array of 2+ keys, e.g. ["u", "p"]).
   * Mutually exclusive with `key` — only one should be defined per entry.
   * When a chord is defined, the entry is matched via `lookupChord()`
   * rather than `lookup()`.
   */
  chord?: string[];
  /**
   * Optional short label displayed in the browse help line (e.g. "implement", "plan").
   * When provided, this is used instead of deriving a label from the command string.
   */
  label?: string;
  /**
   * Optional one-sentence description of the command for use in help screens.
   */
  description?: string;
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
 * The registry stores entries by key and provides `lookup(key, view)` and
 * `lookupChord(chordKeys, view, stage)` methods that return the matching
 * command string (with `<id>` replaced) or `undefined` if no entry matches.
 *
 * Chord entries are tracked separately for efficient leader-key lookup via
 * `getChordByLeader()`.
 */
export class ShortcutRegistry {
  private entries: ShortcutEntry[];
  private chordEntries: Map<string, ShortcutEntry[]>;

  constructor(entries: ShortcutEntry[]) {
    this.entries = entries;

    // Index chord entries by leader key for fast lookup
    this.chordEntries = new Map();
    for (const entry of entries) {
      const chord = (entry as Record<string, unknown>).chord;
      if (Array.isArray(chord) && chord.length >= 2) {
        const [leader] = chord as [string, ...string[]];
        const existing = this.chordEntries.get(leader) ?? [];
        existing.push(entry);
        this.chordEntries.set(leader, existing);
      }
    }
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
   * NOTE: Only key-based entries (those with a `key` field) are matched by
   * this method. Chord entries must be looked up via `lookupChord()`.
   *
   * @param key - The pressed key (e.g. "i")
   * @param view - The current view ("list" or "detail")
   * @param stage - Optional item stage to filter by (e.g. "idea", "intake_complete")
   * @returns The command string or undefined
   */
  lookup(key: string, view: string, stage?: string): string | undefined {
    const match = this.entries.find(entry => {
      // Only match key-based entries — chord entries are handled by lookupChord
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

  // ── Chord methods ─────────────────────────────────────────────────────

  /**
   * Get all chord entries whose first key (leader) matches the given key.
   *
   * When `view` is provided, only chord entries that are visible in that view
   * (view === "both" or view === the provided view) are returned.
   *
   * @param leaderKey - The first key of the chord (e.g. "u")
   * @param view - Optional view filter ("list" | "detail")
   * @returns Array of matching chord ShortcutEntry objects (may be empty)
   */
  getChordByLeader(leaderKey: string, view?: string): ShortcutEntry[] {
    const chords = this.chordEntries.get(leaderKey);
    if (!chords || chords.length === 0) return [];

    if (view === undefined) {
      return chords;
    }

    return chords.filter(entry => entry.view === 'both' || entry.view === view);
  }

  /**
   * Look up a chord by its full key sequence, view, and optional stage.
   *
   * Returns the command string for the first matching entry, or `undefined`
   * if no entry matches.  An entry matches when:
   * - its `chord` array exactly equals the given `chordKeys` array
   * - its `view` is either `"both"` or exactly matches the given view string
   * - if `stage` is provided, the entry's `stages` allow-list is either
   *   undefined/empty, or includes the given stage value
   *
   * @param chordKeys - The full chord key sequence (e.g. ["u", "p"])
   * @param view - The current view ("list" or "detail")
   * @param stage - Optional item stage to filter by
   * @returns The command string or undefined
   */
  lookupChord(chordKeys: string[], view: string, stage?: string): string | undefined {
    // chordKeys must match the entry's chord array exactly
    const match = this.entries.find(entry => {
      const chord = (entry as Record<string, unknown>).chord;
      if (!Array.isArray(chord)) return false;
      if (chord.length !== chordKeys.length) return false;

      // Compare chord arrays element-by-element
      for (let i = 0; i < chord.length; i++) {
        if (chord[i] !== chordKeys[i]) return false;
      }

      // View filter
      if (entry.view !== 'both' && entry.view !== view) return false;

      // Stage filter
      if (stage !== undefined && entry.stages !== undefined && entry.stages.length > 0) {
        if (!entry.stages.includes(stage)) return false;
      }

      return true;
    });

    return match?.command;
  }

  /**
   * Return all chord entries (for help text rendering / introspection).
   */
  getChordEntries(): ShortcutEntry[] {
    const result: ShortcutEntry[] = [];
    for (const entry of this.entries) {
      const chord = (entry as Record<string, unknown>).chord;
      if (Array.isArray(chord) && chord.length >= 2) {
        result.push(entry);
      }
    }
    return result;
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
  const seenKeys = new Set<string>();

  // Collect skipped-entry details for batched warnings
  const skippedDetails: { index: number; category: string; detail: string }[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i] as Record<string, unknown>;

    // Validate required fields
    if (!entry || typeof entry !== 'object') {
      skippedDetails.push({ index: i, category: 'not-an-object', detail: 'not an object' });
      continue;
    }

    const rawKey = entry.key;
    const rawChord = entry.chord;
    const command = entry.command;
    const view = entry.view;

    // Validate key/chord mutual exclusivity and presence
    const hasKey = rawKey !== undefined && typeof rawKey === 'string' && (rawKey as string).length > 0;
    const hasChord = Array.isArray(rawChord) && (rawChord as unknown[]).length > 0;

    if (hasKey && hasChord) {
      skippedDetails.push({
        index: i,
        category: 'both-fields',
        detail: 'entry has both "key" and "chord" fields — they are mutually exclusive',
      });
      continue;
    }

    if (!hasKey && !hasChord) {
      skippedDetails.push({
        index: i,
        category: 'missing-key-or-chord',
        detail: 'missing or invalid "key" or "chord" field — exactly one is required',
      });
      continue;
    }

    // If chord entry, validate chord is an array of 2+ strings
    if (hasChord) {
      const chordArr = rawChord as unknown[];
      if (chordArr.length < 2) {
        skippedDetails.push({
          index: i,
          category: 'chord-too-short',
          detail: '"chord" must be an array of at least 2 strings',
        });
        continue;
      }
      for (let j = 0; j < chordArr.length; j++) {
        if (typeof chordArr[j] !== 'string') {
          skippedDetails.push({
            index: i,
            category: 'chord-element-not-string',
            detail: `"chord" entry at index ${j} is not a string`,
          });
        }
      }
    }

    if (!command || typeof command !== 'string') {
      skippedDetails.push({
        index: i,
        category: 'missing-command',
        detail: 'missing or invalid "command" field',
      });
      continue;
    }

    if (!view || typeof view !== 'string') {
      skippedDetails.push({
        index: i,
        category: 'missing-view',
        detail: 'missing or invalid "view" field',
      });
      continue;
    }

    if (!validViews.has(view)) {
      skippedDetails.push({
        index: i,
        category: 'invalid-view',
        detail: `unknown "view" value "${view}"`,
      });
      continue;
    }

    // Validate optional stages field
    const stages = entry.stages;
    if (stages !== undefined) {
      if (!Array.isArray(stages)) {
        skippedDetails.push({
          index: i,
          category: 'invalid-stages-type',
          detail: '"stages" must be an array of strings',
        });
        continue;
      }
      for (let j = 0; j < stages.length; j++) {
        if (typeof stages[j] !== 'string') {
          skippedDetails.push({
            index: i,
            category: 'stages-element-not-string',
            detail: `"stages" entry at index ${j} is not a string`,
          });
        }
      }
    }

    // Build the shortcut entry with either key or chord
    const shortcutEntry: ShortcutEntry = {
      key: rawChord !== undefined ? '' : (entry.key as string),
      command,
      view: view as 'list' | 'detail' | 'both',
    };

    // If it's a chord entry, set the chord field on the entry
    // We use a spread to add chord since the interface type doesn't require it
    if (hasChord) {
      (shortcutEntry as Record<string, unknown>).chord = rawChord as string[];
    }

    // Only include stages if it is a non-empty array of strings
    if (
      Array.isArray(stages) &&
      stages.length > 0 &&
      stages.every((s: unknown) => typeof s === 'string')
    ) {
      shortcutEntry.stages = stages as string[];
    }

    // Include optional label if present and non-empty
    const label = entry.label;
    if (typeof label === 'string' && label.trim().length > 0) {
      shortcutEntry.label = label.trim();
    }

    // Include optional description if present and non-empty
    const description = entry.description;
    if (typeof description === 'string' && description.trim().length > 0) {
      shortcutEntry.description = description.trim();
    }

    // Check for duplicate key+view or chord+view combinations
    const compositeKey = hasChord
      ? `${(rawChord as string[]).join('+')}:${view}`
      : `${rawKey}:${view}`;
    if (seenKeys.has(compositeKey)) {
      console.warn(
        `[shortcut-config] Duplicate shortcut at index ${i}: key/chord "${compositeKey}" is already registered — the second entry will be shadowed`,
      );
    } else {
      seenKeys.add(compositeKey);
    }

    validEntries.push(shortcutEntry);
  }

  // Emit batched warnings per structural-issue category
  if (skippedDetails.length > 0) {
    const byCategory = new Map<string, { indices: number[]; details: string[] }>();
    for (const { index, category, detail } of skippedDetails) {
      if (!byCategory.has(category)) {
        byCategory.set(category, { indices: [], details: [] });
      }
      byCategory.get(category)!.indices.push(index);
      byCategory.get(category)!.details.push(detail);
    }

    for (const [, { indices, details }] of byCategory) {
      if (indices.length === 1) {
        console.warn(`[shortcut-config] Skipping entry at index ${indices[0]}: ${details[0]}`);
      } else {
        console.warn(
          `[shortcut-config] Skipped ${indices.length} entries at indices [${indices.join(', ')}]: ${details[0]}`,
        );
      }
      // Individual details available via console.debug for debugging
      for (let j = 0; j < indices.length; j++) {
        console.debug(`[shortcut-config] Entry at index ${indices[j]}: ${details[j]}`);
      }
    }
  }

  if (validEntries.length === 0 && parsed.length > 0) {
    console.warn(`[shortcut-config] No valid entries in shortcuts.json; all entries were invalid`);
  }

  return new ShortcutRegistry(validEntries);
}
