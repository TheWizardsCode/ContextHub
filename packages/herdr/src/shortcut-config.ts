/**
 * packages/herdr/src/shortcut-config.ts — Chord shortcut system for Herdr
 *
 * Provides a ShortcutRegistry that loads shortcut entries from shortcuts.json,
 * supporting chord sequences of any length (a chord of length 1 is a single keypress)
 * and stage-aware visibility. Ported from the Pi TUI shortcut-config.ts.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Types ─────────────────────────────────────────────────────────────

export interface ShortcutEntry {
  command: string;
  view: 'list' | 'detail' | 'both';
  chord: string[];
  label?: string;
  description?: string;
  stages?: string[];
}

// ── Registry ──────────────────────────────────────────────────────────

export class ShortcutRegistry {
  private entries: ShortcutEntry[];

  constructor(entries: ShortcutEntry[]) {
    this.entries = entries;
  }

  /**
   * Look up a chord by its full key sequence (supports any length).
   */
  lookupChord(chordKeys: string[], view: string, stage?: string): string | undefined {
    const match = this.entries.find(entry => {
      const chord = entry.chord;
      if (chord.length !== chordKeys.length) return false;
      for (let i = 0; i < chord.length; i++) {
        if (chord[i] !== chordKeys[i]) return false;
      }
      if (entry.view !== 'both' && entry.view !== view) return false;
      if (stage !== undefined && entry.stages !== undefined && entry.stages.length > 0) {
        if (!entry.stages.includes(stage)) return false;
      }
      return true;
    });
    return match?.command;
  }

  /**
   * Return all entries visible for the given stage.
   */
  getEntriesForStage(stage?: string): ShortcutEntry[] {
    return this.entries.filter(entry => {
      if (entry.stages === undefined || entry.stages.length === 0) return true;
      if (stage === undefined) return false;
      return entry.stages.includes(stage);
    });
  }

  /**
   * Return all entries (for introspection).
   */
  getEntries(): ReadonlyArray<ShortcutEntry> {
    return this.entries;
  }

  /**
   * Get chord entries whose leader key matches.
   */
  getChordByLeader(leaderKey: string, view?: string): ShortcutEntry[] {
    return this.getChordByPrefix([leaderKey], view);
  }

  /**
   * Get chord entries whose chord array starts with the given prefix.
   */
  getChordByPrefix(prefix: string[], view?: string, stage?: string): ShortcutEntry[] {
    const result: ShortcutEntry[] = [];
    for (const entry of this.entries) {
      const chord = entry.chord;
      if (chord.length < prefix.length) continue;

      let matches = true;
      for (let i = 0; i < prefix.length; i++) {
        if (chord[i] !== prefix[i]) { matches = false; break; }
      }
      if (!matches) continue;

      if (view !== undefined && entry.view !== 'both' && entry.view !== view) continue;
      if (stage !== undefined && entry.stages !== undefined && entry.stages.length > 0) {
        if (!entry.stages.includes(stage)) continue;
      }
      result.push(entry);
    }
    return result;
  }



  /**
   * Return all entries (each has a chord, any length).
   */
  getChordEntries(): ShortcutEntry[] {
    return this.entries;
  }
}

// ── Loader ────────────────────────────────────────────────────────────

/**
 * Load and validate shortcut config from shortcuts.json.
 */
export function loadShortcutConfig(): ShortcutRegistry {
  const configPath = join(__dirname, 'shortcuts.json');

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return new ShortcutRegistry([]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[shortcut-config] Malformed shortcuts.json');
    return new ShortcutRegistry([]);
  }

  if (!Array.isArray(parsed)) {
    console.error('[shortcut-config] shortcuts.json must be an array');
    return new ShortcutRegistry([]);
  }

  const validViews = new Set(['list', 'detail', 'both']);
  const validEntries: ShortcutEntry[] = [];

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;

    const command = (entry as Record<string, unknown>).command;
    const view = (entry as Record<string, unknown>).view;

    if (typeof command !== 'string' || command.length === 0) continue;
    if (typeof view !== 'string' || !validViews.has(view)) continue;

    const rawChord = (entry as Record<string, unknown>).chord;
    if (!Array.isArray(rawChord) || rawChord.length < 1) continue;

    const shortcutEntry: ShortcutEntry = {
      chord: rawChord.map(String),
      command,
      view: view as 'list' | 'detail' | 'both',
    }

    const rawStages = (entry as Record<string, unknown>).stages;
    if (Array.isArray(rawStages) && rawStages.length > 0 && rawStages.every(s => typeof s === 'string')) {
      shortcutEntry.stages = rawStages;
    }

    const label = (entry as Record<string, unknown>).label;
    if (typeof label === 'string' && label.trim().length > 0) {
      shortcutEntry.label = label.trim();
    }

    const description = (entry as Record<string, unknown>).description;
    if (typeof description === 'string' && description.trim().length > 0) {
      shortcutEntry.description = description.trim();
    }

    validEntries.push(shortcutEntry);
  }

  return new ShortcutRegistry(validEntries);
}

/**
 * Format chord shortcut hints for the help line.
 */
export function formatChordHints(
  chords: ShortcutEntry[],
  pendingChord: string[],
  options?: { isEmpty?: boolean },
): string {
  const filtered = options?.isEmpty
    ? chords.filter(c => !c.command.includes('<id>'))
    : chords;

  if (filtered.length === 0) return '';

  const extractLabel = (e: ShortcutEntry): string => {
    return e.label ?? e.command
      .replace(/<[^>]+>/g, '')
      .split(/\r?\n/)[0]
      .trim()
      .replace(/^\/(skill:)?/, '');
  };

  type HintEntry = { nextKey: string; hint: string; firstRestWord: string };
  const hints: HintEntry[] = [];

  for (const e of filtered) {
    const chord = e.chord;
    const label = extractLabel(e);

    if (chord && chord.length > pendingChord.length) {
      const nextKey = chord[pendingChord.length];
      const words = label.split(/\s+/);
      const stripCount = Math.min(pendingChord.length, Math.max(0, words.length - 1));
      const rest = words.slice(stripCount);
      const firstRestWord = rest.length > 0 ? rest[0] : (words.length > 0 ? words[words.length - 1] : '');
      const hint = rest.length > 0 ? `${nextKey}:${rest.join(' ')}` : nextKey;
      hints.push({ nextKey, hint, firstRestWord });
    } else {
      if (chord && chord.length >= 2) {
        const leaderKey = chord[0];
        const firstWord = label.split(/\s+/)[0];
        hints.push({ nextKey: leaderKey, hint: `${leaderKey}:${firstWord}...`, firstRestWord: firstWord });
      } else if (e.chord && e.chord.length === 1) {
        hints.push({ nextKey: e.chord[0], hint: `${e.chord[0]}:${label}`, firstRestWord: label.split(/\s+/)[0] });
      }
    }
  }

  // Group by nextKey and collapse
  const byKey = new Map<string, HintEntry[]>();
  for (const h of hints) {
    const group = byKey.get(h.nextKey) ?? [];
    group.push(h);
    byKey.set(h.nextKey, group);
  }

  const result: string[] = [];
  for (const [, group] of byKey) {
    if (group.length > 1) {
      result.push(`${group[0].nextKey}:${group[0].firstRestWord}...`);
    } else {
      result.push(group[0].hint);
    }
  }

  return result.join(' ');
}
