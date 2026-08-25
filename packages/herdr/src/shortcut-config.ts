/**
 * packages/herdr/src/shortcut-config.ts — Chord shortcut system for Herdr
 *
 * Provides a ShortcutRegistry that loads shortcut entries from shortcuts.json,
 * supporting chord sequences of any length (a chord of length 1 is a single keypress)
 * and stage-aware visibility. Ported from the Pi TUI shortcut-config.ts.
 */

import { existsSync, readFileSync } from 'node:fs';
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
  /**
   * Code-freeze visibility (WL-0MSD81VEL009XHWA). When the project is in a
   * Code Freeze (ship release in progress):
   *   - `'block'`  — the shortcut is hidden: excluded from lookups and help
   *                  hints while a freeze is active.
   *   - `'allow'`  — the shortcut is always shown, even during a freeze.
   *   - omitted    — always shown (backward compatible).
   * Parsed from the `code_freeze` key in shortcuts.json; invalid values are
   * logged and treated as omitted.
   */
  codeFreeze?: 'block' | 'allow';
  /**
   * Issue-type allowlist (WL-0MSKH1J0R003BM2M). When present, the shortcut
   * is visible ONLY on work items whose issue type (e.g. `bug`, `feature`,
   * `task`, `chore`, `epic`, `podcast`) is listed. Entries without an
   * allowlist are available on all types (backward compatible).
   * Parsed from the `work_item_types` key in shortcuts.json (snake_case in
   * JSON, camelCase in TS — matching the `code_freeze`→`codeFreeze`
   * convention); invalid values are logged and treated as omitted.
   */
  workItemTypes?: string[];
  /**
   * Whether dispatching this shortcut should open a visible pane
   * (WL-0MSJLD1I70045ZUL). Omitted (or `true`) opens a pane exactly as
   * today:
   *   - `!!`/`!` shell commands open a "Command Output" herdr pane via
   *     run-in-pane.sh;
   *   - agent commands (`/skill:*`, `/intake`, `/plan`, `/prompt:`) open a
   *     pi agent pane via send-to-pi.sh.
   * `false` runs the command in the background with stdout/stderr captured
   * to a per-run log file — no pane is created, so the work-item ↔ pane
   * association (WL-0MSBQUJQX005RAT9) is skipped for agent commands.
   * Parsed from the `open_pane` key in shortcuts.json; invalid values are
   * logged and treated as omitted (open a pane), mirroring the
   * `code_freeze` pattern.
   */
  openPane?: boolean;
}

// ── Registry ──────────────────────────────────────────────────────────

export class ShortcutRegistry {
  private entries: ShortcutEntry[];

  constructor(entries: ShortcutEntry[]) {
    this.entries = entries;
  }

  /**
   * True when an entry is hidden during a Code Freeze: the entry is marked
   * `codeFreeze: 'block'` and a freeze is currently active. Allow/omitted
   * entries are always visible (WL-0MSD81VEL009XHWA).
   */
  private isBlockedByFreeze(entry: ShortcutEntry, codeFreezeActive?: boolean): boolean {
    return codeFreezeActive === true && entry.codeFreeze === 'block';
  }

  /**
   * True when an entry is hidden by issue-type gating (WL-0MSKH1J0R003BM2M):
   * the entry carries a `workItemTypes` allowlist AND the selected item's
   * issueType is supplied AND the allowlist does not include it. When either
   * the allowlist or the issueType is missing, the entry is always visible
   * (backward compatible).
   */
  private isBlockedByIssueType(entry: ShortcutEntry, issueType?: string): boolean {
    if (issueType === undefined) return false;
    if (entry.workItemTypes === undefined || entry.workItemTypes.length === 0) return false;
    return !entry.workItemTypes.includes(issueType);
  }

  /**
   * Look up a chord by its full key sequence (supports any length).
   */
  lookupChord(chordKeys: string[], view: string, stage?: string, codeFreezeActive?: boolean, issueType?: string): string | undefined {
    return this.lookupChordEntry(chordKeys, view, stage, codeFreezeActive, issueType)?.command;
  }

  /**
   * Look up a chord by its full key sequence and return the matching entry
   * (command, model, label, ...). Returns undefined when no entry matches.
   */
  lookupChordEntry(chordKeys: string[], view: string, stage?: string, codeFreezeActive?: boolean, issueType?: string): ShortcutEntry | undefined {
    return this.entries.find(entry => {
      if (this.isBlockedByFreeze(entry, codeFreezeActive)) return false;
      if (this.isBlockedByIssueType(entry, issueType)) return false;
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
  getEntriesForStage(stage?: string, codeFreezeActive?: boolean, issueType?: string): ShortcutEntry[] {
    return this.entries.filter(entry => {
      if (this.isBlockedByFreeze(entry, codeFreezeActive)) return false;
      if (this.isBlockedByIssueType(entry, issueType)) return false;
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
  getChordByLeader(leaderKey: string, view?: string, codeFreezeActive?: boolean, issueType?: string): ShortcutEntry[] {
    return this.getChordByPrefix([leaderKey], view, undefined, codeFreezeActive, issueType);
  }

  /**
   * Get chord entries whose chord array starts with the given prefix.
   */
  getChordByPrefix(prefix: string[], view?: string, stage?: string, codeFreezeActive?: boolean, issueType?: string): ShortcutEntry[] {
    const result: ShortcutEntry[] = [];
    for (const entry of this.entries) {
      if (this.isBlockedByFreeze(entry, codeFreezeActive)) continue;
      if (this.isBlockedByIssueType(entry, issueType)) continue;
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
   * Return all entries (each has a chord, any length). When a freeze is
   * active, entries marked `code_freeze: 'block'` are omitted; when an
   * issueType is supplied, entries whose `workItemTypes` allowlist does not
   * include it are omitted too.
   */
  getChordEntries(codeFreezeActive?: boolean, issueType?: string): ShortcutEntry[] {
    return this.entries.filter(entry => {
      if (this.isBlockedByFreeze(entry, codeFreezeActive)) return false;
      if (this.isBlockedByIssueType(entry, issueType)) return false;
      return true;
    });
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

  const codeFreeze = entry.code_freeze;
  if (codeFreeze === 'block' || codeFreeze === 'allow') {
    shortcutEntry.codeFreeze = codeFreeze;
  } else if (codeFreeze !== undefined) {
    // Invalid values are logged and treated as omit (always shown) — a bad
    // value must never hide or break a shortcut (WL-0MSD81VEL009XHWA).
    console.error(`[shortcut-config] Invalid code_freeze value "${String(codeFreeze)}" for shortcut "${command}"; expected "block" or "allow", treating as omitted`);
  }

  const workItemTypes = entry.work_item_types;
  if (Array.isArray(workItemTypes) && workItemTypes.length > 0 && workItemTypes.every(t => typeof t === 'string' && t.trim().length > 0)) {
    shortcutEntry.workItemTypes = workItemTypes.map(String);
  } else if (workItemTypes !== undefined) {
    // Invalid values are logged and treated as omit (available on all types)
    // — a bad value must never hide or break a shortcut
    // (WL-0MSKH1J0R003BM2M).
    console.error(`[shortcut-config] Invalid work_item_types value for shortcut "${command}"; expected a non-empty array of strings, treating as omitted`);
  }

  const openPane = entry.open_pane;
  if (openPane === true || openPane === false) {
    shortcutEntry.openPane = openPane;
  } else if (openPane !== undefined) {
    // Invalid values are logged and treated as omit (open a pane — the
    // default) — a bad value must never hide or break a shortcut
    // (WL-0MSJLD1I70045ZUL).
    console.error(`[shortcut-config] Invalid open_pane value "${String(openPane)}" for shortcut "${command}"; expected true or false, treating as omitted (open a pane)`);
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
 * Load and validate the bundled default entries from src/shortcuts.json.
 *
 * Returns an empty array when the bundled file is missing or malformed,
 * mirroring the pre-extensibility behaviour of {@link loadShortcutConfig}.
 */
function loadBundledEntries(): ShortcutEntry[] {
  const configPath = join(__dirname, 'shortcuts.json');

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[shortcut-config] Malformed shortcuts.json');
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.error('[shortcut-config] shortcuts.json must be an array');
    return [];
  }

  const validEntries: ShortcutEntry[] = [];

  for (const entry of parsed) {
    const parsedEntry = parseShortcutEntry(entry);
    if (parsedEntry) {
      validEntries.push(parsedEntry);
    }
  }

  return validEntries;
}

/**
 * Load project-local shortcut entries from <worklogRoot>/shortcuts.json.
 *
 * The local file (WL-0MSHUMX5C004NC4O) lets a consumer project add its own
 * chords and override bundled defaults without editing the plugin bundle.
 * Entries are validated with the same {@link parseShortcutEntry} rules as the
 * bundled file; invalid entries are logged and skipped (never crash). A
 * missing, unreadable, malformed (bad JSON / non-array) local file falls back
 * to bundled-only with an error logged.
 */
function loadLocalEntries(worklogRoot: string): ShortcutEntry[] {
  const localPath = join(worklogRoot, 'shortcuts.json');
  if (!existsSync(localPath)) return [];

  let raw: string;
  try {
    raw = readFileSync(localPath, 'utf-8');
  } catch {
    console.error(`[shortcut-config] Could not read project-local shortcuts.json at ${localPath}; using bundled defaults only`);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`[shortcut-config] Malformed project-local shortcuts.json at ${localPath}; using bundled defaults only`);
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.error(`[shortcut-config] Project-local shortcuts.json at ${localPath} must be an array; using bundled defaults only`);
    return [];
  }

  const localEntries: ShortcutEntry[] = [];
  for (const entry of parsed) {
    const parsedEntry = parseShortcutEntry(entry);
    if (parsedEntry) {
      localEntries.push(parsedEntry);
    } else {
      console.error(`[shortcut-config] Invalid entry in project-local shortcuts.json at ${localPath}; skipping entry`);
    }
  }
  return localEntries;
}

/**
 * Merge bundled defaults with project-local entries.
 *
 * Local wins: an entry with the same view+chord replaces the bundled one;
 * entries with new chords are appended. Bundled order is preserved for
 * untouched entries (a Map keyed by view+chord keeps the first-inserted
 * position when a key is re-set), so the resulting registry is deterministic
 * with no duplicate view+chord pairs. Within the local file, later entries
 * win for the same view+chord.
 */
function mergeShortcutEntries(bundled: ShortcutEntry[], local: ShortcutEntry[]): ShortcutEntry[] {
  const key = (e: ShortcutEntry): string => `${e.view}\u0000${e.chord.join('\u0001')}`;
  const merged = new Map<string, ShortcutEntry>();
  for (const entry of bundled) {
    merged.set(key(entry), entry);
  }
  for (const entry of local) {
    merged.set(key(entry), entry);
  }
  return [...merged.values()];
}

/**
 * Load and validate shortcut config from shortcuts.json.
 *
 * Loads the bundled defaults first, then merges a project-local
 * `<worklogRoot>/shortcuts.json` over them when present (local wins on
 * chord+view, WL-0MSHUMX5C004NC4O). Without a local file — or when
 * `worklogRoot` is undefined — the registry is byte-identical to the
 * bundled-only output.
 */
export function loadShortcutConfig(worklogRoot?: string): ShortcutRegistry {
  const bundledEntries = loadBundledEntries();

  if (!worklogRoot) {
    return new ShortcutRegistry(bundledEntries);
  }

  const localEntries = loadLocalEntries(worklogRoot);
  if (localEntries.length === 0) {
    return new ShortcutRegistry(bundledEntries);
  }

  return new ShortcutRegistry(mergeShortcutEntries(bundledEntries, localEntries));
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
