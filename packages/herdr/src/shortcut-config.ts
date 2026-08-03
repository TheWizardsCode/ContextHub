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

const validViews = new Set(['list', 'detail', 'both']);

// ── Types ─────────────────────────────────────────────────────────────

export interface ShortcutEntry {
  command: string;
  view: 'list' | 'detail' | 'both';
  chord: string[];
  label?: string;
  description?: string;
  stages?: string[];
  /**
   * Optional pi model pattern (e.g. `plan`, `code`, `author`) used when the
   * command is dispatched to the agent channel: the spawned `pi` CLI is
   * invoked with `--model <pattern>`. Agent-bound commands without an
   * explicit model default to `plan` (WL-0MSD48ZFC0043AO3).
   */
  model?: string;
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
    return this.lookupChordEntry(chordKeys, view, stage)?.command;
  }

  /**
   * Look up a chord by its full key sequence and return the matching entry
   * (command, model, label, ...). Returns undefined when no entry matches.
   */
  lookupChordEntry(chordKeys: string[], view: string, stage?: string): ShortcutEntry | undefined {
    return this.entries.find(entry => {
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
 * True when a command is routed to the pi agent pane (the agent channel).
 * Agent-bound commands may carry a `model` so the spawned pi CLI opens with
 * `--model <pattern>` (WL-0MSD48ZFC0043AO3).
 */
function isAgentCommand(command: string): boolean {
  return (
    command.startsWith('/skill:') ||
    command.startsWith('/intake') ||
    command.startsWith('/plan') ||
    command.startsWith('/prompt:')
  );
}

/**
 * Parse and validate a single raw shortcut entry from shortcuts.json.
 *
 * Returns a validated {@link ShortcutEntry}, or undefined when the raw entry
 * is invalid (missing/invalid command, view, or chord). Extracted from
 * {@link loadShortcutConfig} so parsing (including the optional `model`
 * field and its `plan` default for agent-bound commands) is unit-testable.
 */
export function parseShortcutEntry(raw: unknown): ShortcutEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;

  const entry = raw as Record<string, unknown>;
  const command = entry.command;
  const view = entry.view;

  if (typeof command !== 'string' || command.length === 0) return undefined;
  if (typeof view !== 'string' || !validViews.has(view)) return undefined;

  const rawChord = entry.chord;
  if (!Array.isArray(rawChord) || rawChord.length < 1) return undefined;

  const shortcutEntry: ShortcutEntry = {
    chord: rawChord.map(String),
    command,
    view: view as 'list' | 'detail' | 'both',
  };

  const rawStages = entry.stages;
  if (Array.isArray(rawStages) && rawStages.length > 0 && rawStages.every(s => typeof s === 'string')) {
    shortcutEntry.stages = rawStages;
  }

  const label = entry.label;
  if (typeof label === 'string' && label.trim().length > 0) {
    shortcutEntry.label = label.trim();
  }

  const description = entry.description;
  if (typeof description === 'string' && description.trim().length > 0) {
    shortcutEntry.description = description.trim();
  }

  const model = entry.model;
  if (typeof model === 'string' && model.trim().length > 0) {
    shortcutEntry.model = model.trim();
  }

  // Agent-bound commands without an explicit model run on the default
  // `plan` model so every pi pane spawned from a shortcut opens with a
  // deterministic model (WL-0MSD48ZFC0043AO3). Non-agent commands (shell
  // `!!` and `/wl` filter entries) never carry a model.
  if (shortcutEntry.model === undefined && isAgentCommand(command)) {
    shortcutEntry.model = 'plan';
  }

  return shortcutEntry;
}

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

  const validEntries: ShortcutEntry[] = [];

  for (const entry of parsed) {
    const parsedEntry = parseShortcutEntry(entry);
    if (parsedEntry) {
      validEntries.push(parsedEntry);
    }
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
