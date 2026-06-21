import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { priorityIcon, statusIcon, stageIcon, auditIcon, epicIcon, iconsEnabled, riskIcon, effortIcon } from '../../../src/icons.js';
import { applyStageColour, type PiTheme } from './worklog-helpers.js';
import { truncateToTerminalWidth, wrapToTerminalWidth, visibleWidth } from './terminal-utils.js';
import { type ShortcutRegistry, loadShortcutConfig } from './shortcut-config.js';
import { loadSettings, type Settings, DEFAULT_SETTINGS } from './settings-config.js';
import { registerActivityIndicator, showActivity, clearActivity } from './activity-indicator.js';
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

const execFileAsync = promisify(execFile);

// ── Settings state ─────────────────────────────────────────────────────

/**
 * Path to the settings.json file in the extension directory.
 */
const SETTINGS_FILE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'settings.json');

/**
 * Current settings for the extension. Initialised from settings.json on
 * module load and updated by the /wl settings command.
 */
let currentSettings: Settings = loadSettings();

/**
 * Update the current settings, persist to settings.json, and return the
 * new settings object.
 */
export function updateSettings(partial: Partial<Settings>): Settings {
  currentSettings = { ...currentSettings, ...partial };
  // Persist to settings.json
  try {
    writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(currentSettings, null, 2), 'utf-8');
  } catch (err) {
    console.error('[worklog-browse] Failed to persist settings:', err);
  }
  return currentSettings;
}

// Lazy-loaded reference to Pi's matchesKey() for cross-platform keyboard input.
// When the extension runs inside Pi, this uses @earendil-works/pi-tui's
// matchesKey() which handles all terminal escape sequences (legacy and Kitty
// protocol). Falls back to raw ANSI comparison when Pi's TUI is not available
// (e.g., during testing outside the Pi runtime).
let _matchesKey: ((data: string, keyId: string) => boolean) | null = null;

try {
  const { matchesKey } = await import('@earendil-works/pi-tui');
  _matchesKey = matchesKey;
} catch {
  // Pi TUI not available — fall back to raw ANSI sequence comparison
}

/**
 * Map of shorthand stage aliases to canonical stage names.
 * Both keys and values are valid stage values for the /wl command.
 */
export const STAGE_MAP: Record<string, string> = {
  intake: 'intake_complete',
  plan: 'plan_complete',
  progress: 'in_progress',
  review: 'in_review',
  // Canonical names mapped to themselves for validation
  idea: 'idea',
  intake_complete: 'intake_complete',
  plan_complete: 'plan_complete',
  in_progress: 'in_progress',
  in_review: 'in_review',
};

const VALID_STAGES = new Set(Object.keys(STAGE_MAP));

export interface WorklogBrowseItem {
  id: string;
  title: string;
  status: string;
  priority?: string;
  stage?: string;
  risk?: string;
  effort?: string;
  description?: string;
  auditResult?: boolean | null;
  issueType?: string;
  childCount?: number;
  tags?: string[];
  githubIssueNumber?: number;
}

/**
 * Shortcut result type - returned when a shortcut key is pressed in the browse list.
 * The caller should set editor text with the resolved command.
 */
export interface ShortcutResult {
  type: 'shortcut';
  command: string;
}

type RunWlFn = (args: string[], includeJson?: boolean) => Promise<string>;
export type SelectionChangeHandler = (item: WorklogBrowseItem) => void;
type ChooseWorkItemFn = (
  items: WorklogBrowseItem[],
  ctx: BrowseContext,
  onSelectionChange: SelectionChangeHandler,
) => Promise<WorklogBrowseItem | ShortcutResult | undefined>;

interface WorklogBrowseDependencies {
  listWorkItems?: () => Promise<WorklogBrowseItem[]>;
  listWorkItemsWithStage?: (stage: string) => Promise<WorklogBrowseItem[]>;
  runWl?: RunWlFn;
  chooseWorkItem?: ChooseWorkItemFn;
  shortcutRegistry?: ShortcutRegistry;
}

type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

/**
 * Browse UI interface - matches the subset of ExtensionUIContext we use.
 *
 * Note: When the extension runs in Pi, the actual ctx.ui is ExtensionUIContext
 * which includes setEditorText. We declare it here for TypeScript compatibility.
 */
interface BrowseUi {
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  custom?: <T>(
    render: (
      tui: { requestRender: () => void },
      theme: {
        fg: (color: string, text: string) => string;
        bold: (text: string) => string;
      },
      keybindings: unknown,
      done: (value: T) => void,
    ) => {
      render: (width: number) => string[];
      invalidate: () => void;
      handleInput?: (data: string) => void;
    },
  ) => Promise<T>;
  setWidget?: (id: string, content?: string[] | ((tui: unknown, theme: unknown) => { render: (width: number) => string[]; invalidate: () => void; handleInput?: (data: string) => void; dispose?: () => void; })) => void;
  notify: (message: string, level?: 'info' | 'warning' | 'error') => void;
  /** Set the text in the core input editor. Available in Pi's ExtensionUIContext. */
  setEditorText?: (text: string) => void;
  /** Get the current text from the core input editor. Available in Pi's ExtensionUIContext. */
  getEditorText?: () => string;
  /** Register a raw terminal input listener. Returns an unsubscribe function. */
  onTerminalInput?: (handler: TerminalInputHandler) => () => void;
  /** Return the height of the usable rendering area (terminal rows minus header/footer). */
  getHeight?: () => number;
  /** Set status text in the footer/status bar. Pass undefined to clear. */
  setStatus?: (key: string, text: string | undefined) => void;
  /** Access to the current theme for styling. */
  readonly theme?: {
    fg: (color: string, text: string) => string;
    bg: (color: string, text: string) => string;
    bold: (text: string) => string;
  };
}

// Use the real Pi types for runtime, but declare a compatibility type for testing
type BrowseContext = { ui: BrowseUi };
type PiLike = ExtensionAPI;

/**
 * Truncate a string to fit within maxWidth visible terminal columns.
 * Delegates to shared truncateToTerminalWidth function.
 */
export function truncateToWidth(text: string, maxWidth: number, ellipsis = '…'): string {
  return truncateToTerminalWidth(text, maxWidth, { ellipsis });
}

/**
 * Compute the icon prefix string for a work item (just icon characters, no trailing space).
 *
 * Returns the concatenated status + stage + audit icons (and optional epic icon
 * with child count) without any trailing space or title text.
 *
 * Exported for testing so callers can compute prefix widths for alignment.
 */
export function getIconPrefix(item: WorklogBrowseItem, noIcons: boolean): string {
  const normalizedStatus = (item.status || '').replace(/_/g, '-');
  const sIcon = statusIcon(normalizedStatus, { noIcons });
  const stIcon = stageIcon(item.stage, { noIcons });
  const aIcon = auditIcon(item.auditResult, { noIcons });
  const coreIcons = [sIcon, stIcon, aIcon].filter(Boolean).join(' ');

  // Add child count indicator for any item with children (not just epics)
  let childSuffix = '';
  if (item.childCount !== undefined && item.childCount > 0) {
    const countStr = `(${item.childCount})`;
    // For epic items, include the epic icon before the child count
    if (item.issueType === 'epic') {
      const eIcon = epicIcon({ noIcons });
      childSuffix = `${eIcon}${countStr}`;
    } else {
      childSuffix = countStr;
    }
  } else if (item.issueType === 'epic') {
    // Epic items without children still show the epic icon
    const eIcon = epicIcon({ noIcons });
    childSuffix = eIcon;
  }

  return [coreIcons, childSuffix].filter(Boolean).join(' ');
}

export function formatBrowseOption(
  item: WorklogBrowseItem,
  maxWidth?: number,
  theme?: PiTheme,
  settings?: Settings,
  prefixWidth?: number,
): string {
  const titleText = item.title;

  // Determine icon preference: explicit settings override env var
  const showIcons = settings?.showIcons ?? iconsEnabled();
  const noIcons = !showIcons;

  // Build icon prefix using the shared helper
  const iconPrefix = getIconPrefix(item, noIcons);

  // Build prefix string with optional fixed-width padding for alignment.
  // When prefixWidth is specified, icon prefixes are padded to that visible
  // width so that titles start at the same column position across all rows.
  // The mandatory trailing space is included to separate icons from the title.
  let prefixStr: string;
  if (iconPrefix.length > 0) {
    if (prefixWidth !== undefined) {
      const currentIconWidth = visibleWidth(iconPrefix);
      const padding = Math.max(0, prefixWidth - currentIconWidth);
      prefixStr = iconPrefix + ' '.repeat(padding + 1);
    } else {
      prefixStr = `${iconPrefix} `;
    }
  } else {
    prefixStr = '';
  }

  // Apply colour to title if theme is provided
  const formatTitle = (title: string): string => {
    if (theme) {
      return applyStageColour(title, item.stage, item.status, theme);
    }
    return title;
  };

  const fullLine = `${prefixStr}${formatTitle(titleText)}`;

  if (!maxWidth || maxWidth <= 0) {
    return fullLine;
  }

  return truncateToWidth(fullLine, maxWidth);
}

function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('No JSON object in output');

  // Try to parse the full output - it may be valid JSON already
  const trimmed = raw.trim();
  const lastOpenQuote = trimmed.lastIndexOf('"');
  const lastCloseBrace = trimmed.lastIndexOf('}');

  // If it looks like complete JSON, try to parse it
  if (lastCloseBrace > lastOpenQuote) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through to manual extraction
    }
  }

  // Manual extraction: count braces while respecting string boundaries
  let depth = 0;
  let inString = false;
  for (let i = start; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === '"') {
      // Count preceding backslashes to check if quote is escaped
      let backslashes = 0;
      for (let j = i - 1; j >= start && raw[j] === '\\'; j--) {
        backslashes++;
      }
      if (backslashes % 2 === 0) {
        inString = !inString;
      }
    }
    if (!inString) {
      if (c === '{') depth += 1;
      if (c === '}') depth -= 1;
      if (depth === 0) {
        return JSON.parse(raw.slice(start, i + 1));
      }
    }
  }

  throw new Error('Unterminated JSON object in output');
}

function normalizeListPayload(payload: unknown): WorklogBrowseItem[] {
  const directItems = Array.isArray(payload)
    ? payload
    : (payload && typeof payload === 'object' && Array.isArray((payload as any).workItems)
      ? (payload as any).workItems
      : []);

  const nextItems = payload && typeof payload === 'object' && Array.isArray((payload as any).results)
    ? (payload as any).results.map((entry: any) => entry?.workItem).filter(Boolean)
    : [];

  const itemList = [...directItems, ...nextItems];

  return itemList
    .map((item: any) => ({
      id: String(item?.id ?? ''),
      title: String(item?.title ?? 'Untitled'),
      status: String(item?.status ?? 'unknown'),
      priority: item?.priority ? String(item.priority) : undefined,
      stage: item?.stage ? String(item.stage) : undefined,
      risk: item?.risk ? String(item.risk) : undefined,
      effort: item?.effort ? String(item.effort) : undefined,
      description: item?.description ? String(item.description) : undefined,
      auditResult: item?.auditResult !== undefined ? item.auditResult : undefined,
      issueType: item?.issueType ? String(item.issueType) : undefined,
      childCount: item?.childCount !== undefined ? Number(item.childCount) : undefined,
      tags: Array.isArray(item?.tags) ? item.tags.map(String) : undefined,
      githubIssueNumber: item?.githubIssueNumber !== undefined ? Number(item.githubIssueNumber) : undefined,
    }))
    .filter(item => item.id.length > 0);
}

/**
 * Known error message pattern emitted by the wl/worklog CLI and post-pull/push
 * hooks when Worklog is not initialized in the current checkout or worktree.
 *
 * Matches case-insensitively to handle minor formatting variations.
 * The pattern is derived from the post-pull hook template in src/commands/init.ts.
 */
const NOT_INITIALIZED_PATTERN = /worklog:\s*not initialized in this checkout\/worktree/i;

/**
 * Friendly, actionable message shown to users instead of the raw stderr
 * when the "not initialized" error is detected.
 */
const NOT_INITIALIZED_FRIENDLY =
  'Worklog is not initialized in this checkout/worktree. Run "wl init" to set up this location.';

async function runWl(args: string[], includeJson = true): Promise<string> {
  const binaries = ['wl', 'worklog'];
  let lastError: unknown;

  for (const binary of binaries) {
    try {
      const fullArgs = includeJson ? [...args, '--json'] : args;
      const result = await execFileAsync(binary, fullArgs, { maxBuffer: 1024 * 1024 * 5 });
      return result.stdout;
    } catch (error: any) {
      if (error && error.code === 'ENOENT') {
        lastError = error;
        continue;
      }

      const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
      const message = stderr || error?.message || String(error);

      // Detect the known "not initialized" CLI error and surface a friendly message
      // instead of the raw stderr. This prevents confusing users with generic error
      // text when they run `wl piman` in a new clone or worktree.
      if (NOT_INITIALIZED_PATTERN.test(message)) {
        throw new Error(NOT_INITIALIZED_FRIENDLY);
      }

      throw new Error(message);
    }
  }

  throw new Error(`Unable to execute wl/worklog CLI: ${String(lastError)}`);
}

export function createDefaultListWorkItems(
  run: RunWlFn = runWl,
  count?: number,
): () => Promise<WorklogBrowseItem[]> {
  return async (): Promise<WorklogBrowseItem[]> => {
    const itemCount = count ?? currentSettings.browseItemCount;
    const output = await run(['next', '-n', String(itemCount), '--include-in-progress']);
    const payload = extractJsonObject(output);
    return normalizeListPayload(payload).slice(0, itemCount);
  };
}

/**
 * Create a listWorkItemsWithStage function that runs `wl next -n <count> --stage <stage>`.
 *
 * @param run - The run function to execute the CLI command (defaults to `runWl`)
 * @param count - Optional item count (defaults to current settings)
 * @returns A function that takes a stage and returns filtered work items
 */
export function createListWorkItemsWithStage(
  run: RunWlFn = runWl,
  count?: number,
): (stage: string) => Promise<WorklogBrowseItem[]> {
  return async (stage: string): Promise<WorklogBrowseItem[]> => {
    const itemCount = count ?? currentSettings.browseItemCount;
    const output = await run(['next', '-n', String(itemCount), '--stage', stage, '--include-in-progress']);
    const payload = extractJsonObject(output);
    return normalizeListPayload(payload).slice(0, itemCount);
  };
}

async function defaultListWorkItems(run: RunWlFn = runWl): Promise<WorklogBrowseItem[]> {
  return createDefaultListWorkItems(run)();
}

/**
 * Default listWorkItemsWithStage function that defaults to runWl.
 */
async function defaultListWorkItemsWithStage(stage: string, run: RunWlFn = runWl): Promise<WorklogBrowseItem[]> {
  return createListWorkItemsWithStage(run)(stage);
}


/**
 * Create a selection widget factory that renders a compact single-line
 * summary of work item metadata.
 *
 * The single line displays the work item's ID, tags, and GitHub issue
 * number in the format: `WL-123456 | tags: tui, ui | GH #608`.
 * - Tags with no values show `tags: —` (em dash).
 * - Items with no GitHub issue number omit the `GH #...` segment entirely.
 *
 * If the line exceeds the available width it is truncated via
 * `truncateToWidth`.
 *
 * Returns a factory function that the TUI calls with (tui, theme) to get a
 * component with render(width). The theme parameter is accepted but not
 * used since the new format is plain text (no colouring needed).
 *
 * Exported for testing.
 */
export function buildSelectionWidget(
  item: WorklogBrowseItem,
  settings?: Settings,
): (tui: any, _theme: PiTheme) => {
  render: (width: number) => string[];
  invalidate: () => void;
} {
  return (_tui, _theme) => {
    let cachedWidth: number | undefined;
    let cachedLines: string[] | undefined;

    /**
     * Build the single-line summary from item metadata.
     * Called on every render after cache miss.
     */
    const computeLine = (): string => {
      const idPart = item.id;

      // Tags segment
      const tags = item.tags;
      const tagStr = Array.isArray(tags) && tags.length > 0
        ? tags.join(', ')
        : '—';
      const tagsPart = `tags: ${tagStr}`;

      // GitHub issue segment (only if githubIssueNumber is a positive number)
      const ghPart = (item.githubIssueNumber !== undefined && item.githubIssueNumber > 0)
        ? `GH #${item.githubIssueNumber}`
        : null;

      // Risk/Effort icons segment
      const showIcons = settings?.showIcons ?? iconsEnabled();
      const noIcons = !showIcons;
      const effortStr = effortIcon(item.effort, { noIcons });
      const riskStr = riskIcon(item.risk, { noIcons });
      const effortRiskPart = [effortStr, riskStr].filter(Boolean).join(' ');

      // Assemble segments with pipe separators
      const parts = [idPart, tagsPart, ghPart, effortRiskPart].filter(Boolean);

      return parts.join(' | ');
    };

    return {
      render: (width: number) => {
        if (cachedLines && cachedWidth === width) {
          return cachedLines;
        }
        const line = computeLine();
        cachedWidth = width;
        cachedLines = [truncateToWidth(line, width)];
        return cachedLines;
      },
      invalidate: () => {
        cachedWidth = undefined;
        cachedLines = undefined;
      },
    };
  };
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
const RESERVED_NAVIGATION_KEYS = new Set(['g', 'G', ' ']);

function isUpKey(data: string): boolean {
  if (_matchesKey) return _matchesKey(data, 'up');
  return data === '\u001b[A' || data === 'up' || /^\u001b\[1;\d+(?::\d+)?A$/.test(data);
}

function isDownKey(data: string): boolean {
  if (_matchesKey) return _matchesKey(data, 'down');
  return data === '\u001b[B' || data === 'down' || /^\u001b\[1;\d+(?::\d+)?B$/.test(data);
}

function isPageUpKey(data: string): boolean {
  if (_matchesKey) return _matchesKey(data, 'pageUp');
  return (
    data === '\u001b[5~'
    || data === '\u001b[[5~'
    || data === 'pageup'
    || data === 'pageUp'
    || /^\u001b\[5;\d+(?::\d+)?~$/.test(data)
  );
}

function isPageDownKey(data: string): boolean {
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

function isEnterKey(data: string): boolean {
  if (_matchesKey) return _matchesKey(data, 'enter');
  return data === '\r' || data === '\n' || data === 'enter' || data === 'return';
}

function isEscapeKey(data: string): boolean {
  if (_matchesKey) return _matchesKey(data, 'escape');
  return data === '\u001b' || data === 'escape';
}

/**
 * Default work item chooser that renders a custom overlay with the browse list.
 *
 * Supports dynamic shortcut dispatch via a `ShortcutRegistry`. When a
 * registered shortcut key is pressed, the overlay is closed and the command
 * + selected item ID is returned as a ShortcutResult. The caller handles
 * setting the editor text after the modal closes.
 *
 * @internal — exported for testing
 */
export async function defaultChooseWorkItem(
  items: WorklogBrowseItem[],
  ctx: BrowseContext,
  onSelectionChange: SelectionChangeHandler,
  shortcutRegistry?: ShortcutRegistry,
  reFetchItems?: () => Promise<WorklogBrowseItem[]>,
  fetchChildren?: (parentId: string) => Promise<WorklogBrowseItem[]>,
): Promise<WorklogBrowseItem | ShortcutResult | undefined> {
  if (!ctx.ui.custom) {
    if (!ctx.ui.select) {
      throw new Error('Selection UI is unavailable in this environment.');
    }

    // Compute max icon prefix width across items for title alignment
    const noIcons = !(currentSettings?.showIcons ?? iconsEnabled());
    const maxPrefixWidth = items.reduce(
      (max, item) => Math.max(max, visibleWidth(getIconPrefix(item, noIcons))),
      0,
    );

    const options = items.map(item => formatBrowseOption(item, undefined, undefined, currentSettings, maxPrefixWidth));
    const selected = await ctx.ui.select(`Browse Worklog next items (top ${currentSettings.browseItemCount})`, options);
    if (!selected) return undefined;

    const selectedIndex = options.indexOf(selected);
    if (selectedIndex < 0) {
      ctx.ui.notify('Invalid selection.', 'warning');
      return undefined;
    }

    const selectedItem = items[selectedIndex];
    onSelectionChange(selectedItem);
    return selectedItem;
  }

  // ── Chord state: tracks whether a chord leader key has been pressed.
  // Null means no pending chord; a string value is the leader key.
  let pendingChordLeader: string | null = null;

  const result = await ctx.ui.custom<WorklogBrowseItem | ShortcutResult | null>((tui, theme, _keybindings, done) => {
    let selectedIndex = 0;
    let lastSelectionId = items[0]?.id;
    let cachedWidth: number | undefined;
    let cachedLines: string[] | undefined;

    const invalidateCache = () => {
      cachedWidth = undefined;
      cachedLines = undefined;
    };

    // ── Auto-refresh interval ────────────────────────────────────────
    // Re-fetch the items list every 5 seconds while the browse overlay is
    // open. The selected item index is preserved across refreshes by
    // matching on item ID. Refresh is skipped while a chord shortcut
    // sequence is pending (pendingChordLeader !== null) to avoid
    // disrupting user input.
    let refreshInterval: ReturnType<typeof setInterval> | undefined;

    if (reFetchItems) {
      refreshInterval = setInterval(async () => {
        // Skip refresh while a chord leader is pending to avoid
        // disrupting the user's input sequence.
        if (pendingChordLeader !== null) return;

        try {
          let newItems: WorklogBrowseItem[];

          if (navStack.length > 0) {
            // Viewing children — re-fetch children of the current parent
            // so the child list stays up-to-date (new children appear,
            // completed children disappear, re-sorted items reposition).
            const parentEntry = navStack[navStack.length - 1];
            const parentId = parentEntry.items[parentEntry.selectedIndex]?.id;
            if (!parentId || !fetchChildren) return;

            const childResults = await fetchChildren(parentId);
            // Keep the synthetic ".." entry at the top
            newItems = [
              { id: '..', title: '..', status: 'open' },
              ...childResults,
            ];
          } else {
            // At root level — re-fetch from wl next (sorted results)
            newItems = await reFetchItems();
          }

          if (newItems.length === 0) return;

          // Preserve the currently selected item by ID
          const currentId = items[selectedIndex]?.id;
          let newIndex = currentId
            ? newItems.findIndex(item => item.id === currentId)
            : -1;
          if (newIndex < 0) newIndex = 0;

          // Mutate the items array in-place so all closures (render,
          // handleInput, moveSelection) see the updated data without
          // requiring a reassignment.
          items.length = 0;
          items.push(...newItems);
          selectedIndex = newIndex;

          // Always notify the selection change handler after auto-refresh,
          // even when the item ID is unchanged, so the preview widget
          // receives updated data (e.g. status, stage, audit result).
          // The widget's internal render cache prevents visual jitter when
          // no data has actually changed.
          const item = items[selectedIndex];
          if (item) {
            lastSelectionId = item.id;
            onSelectionChange(item);
          }

          invalidateCache();
          tui.requestRender();
        } catch {
          // Silently ignore refresh errors — no visual feedback to the
          // user, the existing list remains unchanged.
        }
      }, 5000);
    }

    /**
     * Wrap the done() callback to clear the auto-refresh interval when
     * the overlay closes. This ensures the timer does not continue running
     * after the user has selected an item, pressed Escape, or dispatched
     * a shortcut.
     */
    const _done = (value: WorklogBrowseItem | ShortcutResult | null) => {
      if (refreshInterval !== undefined) {
        clearInterval(refreshInterval);
        refreshInterval = undefined;
      }
      done(value);
    };

    const moveSelection = (nextIndex: number) => {
      if (nextIndex < 0 || nextIndex >= items.length || nextIndex === selectedIndex) return;
      selectedIndex = nextIndex;
      invalidateCache();
      const item = items[selectedIndex];
      if (item && item.id !== lastSelectionId) {
        lastSelectionId = item.id;
        onSelectionChange(item);
      }
    };

    // ── Hierarchical navigation stack ────────────────────────────────
    // Each entry stores a snapshot of the parent-level items and selection
    // state so that navigating back (via ".." entry or Escape) restores the
    // exact previous view, including the selected item position.
    interface NavStackEntry {
      items: WorklogBrowseItem[];
      selectedIndex: number;
      lastSelectionId: string | undefined;
    }
    const navStack: NavStackEntry[] = [];

    // Flag to prevent concurrent async operations (e.g., double-Enter while
    // children are being fetched) and to suppress input during transitions.
    let isLoadingChildren = false;

    /**
     * Format a shortcut entry into a help-text label.
     * Key-based entries: "i:implement"
     * Chord entries: "u-p:update priority"
     */
    const formatEntryLabel = (e: ShortcutEntry): string => {
      const label = e.label ?? e.command
        .replace(/<[^>]+>/g, '')
        .split(/\r?\n/)[0]
        .trim()
        .replace(/^\/(skill:)?/, '');
      // If this is a chord entry, show just the first key and first word of
      // the label, followed by ellipsis (e.g. "u:update...") to keep the help
      // line compact while hinting at available chord leaders.
      const chord = (e as Record<string, unknown>).chord;
      if (Array.isArray(chord) && chord.length >= 2) {
        const leaderKey = (chord as string[])[0];
        const firstWord = label.split(/\s+/)[0];
        return `${leaderKey}:${firstWord}...`;
      }
      return `${e.key}:${label}`;
    };

    return {
      render: (width: number) => {
        if (cachedLines && cachedWidth === width) {
          return cachedLines;
        }

        const browseCount = currentSettings.browseItemCount;
        const title = truncateToWidth(theme.fg('accent', theme.bold(`Browse Worklog next items (top ${browseCount})`)), width);

        // Build help text: if a chord leader is pending, show chord
        // completions; otherwise show normal shortcut hints.
        let helpText = '';
        if (shortcutRegistry) {
          const selectedStage = items[selectedIndex]?.stage;

          if (pendingChordLeader !== null) {
            // Show chord completions for the pending leader key.
            // In the pending state we show the full chord pattern (e.g.
            // "u-p:update priority") so the user knows exactly what keys
            // to press next.
            const chords = shortcutRegistry.getChordByLeader(pendingChordLeader, 'list');
            if (chords.length > 0) {
              const hints = chords
                .filter(c => {
                  // Filter by stage as well
                  if (selectedStage !== undefined && c.stages !== undefined && c.stages.length > 0) {
                    return c.stages.includes(selectedStage);
                  }
                  return true;
                })
                .map(e => {
                  const label = e.label ?? e.command
                    .replace(/<[^>]+>/g, '')
                    .split(/\r?\n/)[0]
                    .trim()
                    .replace(/^\/(skill:)?/, '');
                  const chord = (e as Record<string, unknown>).chord;
                  if (Array.isArray(chord) && chord.length >= 2) {
                    const secondKey = (chord as string[])[1];
                    // Drop the first word of the label (e.g. "update priority" → "priority")
                    // since it's implied by the leader key context.
                    const rest = label.split(/\s+/).slice(1).join(' ');
                    const hint = rest.length > 0 ? `${secondKey}:${rest}` : secondKey;
                    return hint;
                  }
                  return formatEntryLabel(e);
                })
                .join(' ');
              if (hints.length > 0) {
                helpText = `🔗 ${hints}`;
              }
            }
          } else {
            // Normal help text with shortcut hints.
            // Deduplicate chord entries: show each leader key only once
            // so the line doesn't get cluttered with repeats.
            const relevantEntries = shortcutRegistry
              .getEntriesForStage(selectedStage)
              .filter(e => e.view === 'list' || e.view === 'both');
            if (relevantEntries.length > 0) {
              const seenChordLeaders = new Set<string>();
              helpText = relevantEntries
                .filter(e => {
                  const chord = (e as Record<string, unknown>).chord;
                  if (Array.isArray(chord) && chord.length >= 2) {
                    const leader = (chord as string[])[0];
                    if (seenChordLeaders.has(leader)) return false;
                    seenChordLeaders.add(leader);
                  }
                  return true;
                })
                .map(e => formatEntryLabel(e))
                .join(' ');
            }
          }
        }
        const help = truncateToWidth(theme.fg('dim', helpText), width);

        // Compute max icon prefix width across items for title alignment
        const noIcons = !(currentSettings?.showIcons ?? iconsEnabled());
        const maxPrefixWidth = items.reduce(
          (max, item) => Math.max(max, visibleWidth(getIconPrefix(item, noIcons))),
          0,
        );

        const options = items.map((item, index) => {
          const prefix = index === selectedIndex ? theme.fg('accent', '› ') : '  ';
          const contentWidth = Math.max(0, width - 2);
          // The synthetic ".." entry should render without icon prefix
          // to visually distinguish it from real work items
          const optionLine = item.id === '..'
            ? `${prefix}${item.title || '..'}`
            : `${prefix}${formatBrowseOption(item, contentWidth, theme, currentSettings, maxPrefixWidth)}`;
          return truncateToWidth(optionLine, width);
        });

        const lines = [title, '', ...options, '', help];
        cachedWidth = width;
        cachedLines = lines;
        return lines;
      },
      invalidate: () => {
        invalidateCache();
      },
      handleInput: (data: string) => {
        const lookupKey = data.length === 1 ? data : undefined;

        // ── Pending chord state ──────────────────────────────────────
        if (pendingChordLeader !== null && lookupKey) {
          if (isEscapeKey(data)) {
            pendingChordLeader = null;
            invalidateCache();
            tui.requestRender();
            return;
          }
          // Try to complete the chord
          const selectedStage = items[selectedIndex]?.stage;
          const chordCommand = shortcutRegistry!.lookupChord(
            [pendingChordLeader, lookupKey],
            'list',
            selectedStage,
          );
          if (chordCommand) {
            pendingChordLeader = null;
            _done({
              type: 'shortcut' as const,
              command: chordCommand.replace('<id>', items[selectedIndex].id),
            });
            return;
          }
          // Unrecognised second key — cancel
          pendingChordLeader = null;
          invalidateCache();
          tui.requestRender();
          return;
        }

        // ── Normal input handling ────────────────────────────────────
        if (lookupKey && !RESERVED_NAVIGATION_KEYS.has(lookupKey) && shortcutRegistry) {
          const selectedStage = items[selectedIndex]?.stage;

          // 1) Try single-key shortcut first
          const command = shortcutRegistry.lookup(lookupKey, 'list', selectedStage);
          if (command) {
            _done({ type: 'shortcut' as const, command: command.replace('<id>', items[selectedIndex].id) });
            return;
          }

          // 2) No match — check if key is a chord leader
          const chords = shortcutRegistry.getChordByLeader(lookupKey, 'list');
          if (chords.length > 0) {
            // Only enter pending state if chords are applicable for this stage
            const applicableChords = chords.filter(c => {
              if (selectedStage !== undefined && c.stages !== undefined && c.stages.length > 0) {
                return c.stages.includes(selectedStage);
              }
              return true;
            });
            if (applicableChords.length > 0) {
              pendingChordLeader = lookupKey;
              invalidateCache();
              tui.requestRender();
              return;
            }
          }
        }

        if (isUpKey(data)) {
          moveSelection(selectedIndex - 1);
          tui.requestRender();
          return;
        }

        if (isDownKey(data)) {
          moveSelection(selectedIndex + 1);
          tui.requestRender();
          return;
        }

        if (isEnterKey(data)) {
          const selected = items[selectedIndex];
          if (!selected) {
            _done(null);
            return;
          }

          // ── ".." entry: navigate back to parent level ─────────────
          if (selected.id === '..') {
            const parentState = navStack.pop();
            if (parentState) {
              // Restore the parent-level items and selection
              items.length = 0;
              items.push(...parentState.items);
              selectedIndex = parentState.selectedIndex;
              lastSelectionId = parentState.lastSelectionId;

              // Notify selection change handler
              const restoredItem = items[selectedIndex];
              if (restoredItem && restoredItem.id !== lastSelectionId) {
                lastSelectionId = restoredItem.id;
                onSelectionChange(restoredItem);
              }

              invalidateCache();
              tui.requestRender();
            }
            return;
          }

          // ── Item with children: fetch children and navigate in ────
          if (
            selected.childCount !== undefined
            && selected.childCount > 0
            && fetchChildren
            && !isLoadingChildren
          ) {
            // Save current state to navigation stack
            navStack.push({
              items: [...items],
              selectedIndex,
              lastSelectionId,
            });

            isLoadingChildren = true;

            fetchChildren(selected.id)
              .then(childItems => {
                isLoadingChildren = false;

                // Create synthetic ".." entry for back navigation
                const parentEntry: WorklogBrowseItem = {
                  id: '..',
                  title: '..',
                  status: 'open',
                };

                // Replace items with children (prepend ".." entry)
                items.length = 0;
                items.push(parentEntry, ...childItems);
                selectedIndex = 0;
                lastSelectionId = items[0]?.id;

                // Notify selection change for the first child
                if (items[0]) {
                  onSelectionChange(items[0]);
                }

                invalidateCache();
                tui.requestRender();
              })
              .catch(() => {
                isLoadingChildren = false;
                // On error, pop the navigation stack we just pushed
                navStack.pop();
                ctx.ui.notify('Failed to fetch children.', 'warning');
                invalidateCache();
                tui.requestRender();
              });

            return;
          }

          // ── No children: open detail view (existing behavior) ─────
          _done(selected);
          return;
        }

        if (isEscapeKey(data)) {
          if (pendingChordLeader !== null) {
            // Cancel chord leader
            pendingChordLeader = null;
            invalidateCache();
            tui.requestRender();
            return;
          }

          // ── Navigate back one level if we're in child view ────────
          if (navStack.length > 0) {
            const parentState = navStack.pop()!;
            items.length = 0;
            items.push(...parentState.items);
            selectedIndex = parentState.selectedIndex;
            lastSelectionId = parentState.lastSelectionId;

            const restoredItem = items[selectedIndex];
            if (restoredItem && restoredItem.id !== lastSelectionId) {
              lastSelectionId = restoredItem.id;
              onSelectionChange(restoredItem);
            }

            invalidateCache();
            tui.requestRender();
            return;
          }

          // ── Root level: close the overlay ─────────────────────────
          _done(null);
        }
      },
    };
  });

  return result ?? undefined;
}

/**
 * Create a scrollable widget factory for rendering work item details.
 *
 * Returns a factory function that the TUI calls with (tui, theme) to get a
 * component with render(width), invalidate(), and handleInput(data). The
 * component supports keyboard navigation: Up/Down, PageUp/PageDown/Space,
 * g (top), G (bottom).
 *
 * Exported for testing. In production the factory is passed to
 * ctx.ui.setWidget('worklog-browse-selection', factory).
 */
export function createScrollableWidget(
  contentLines: string[],
): (tui: any, theme: any) => {
  render: (width: number) => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
} {
  return (tui: any, _theme: any) => {
    let offset = 0;
    // Cache the last wrapped lines and viewport so handleInput can use them
    // without re-wrapping (width doesn't change between render and input).
    let lastWrappedLines: string[] = [];
    let lastViewport = 12;

    const computeViewport = (totalLines: number) => {
      // The TUI instance exposes terminal dimensions via `terminal.rows`.
      // `getHeight()` is not a public API on the pi TUI, so fall back to
      // `tui.terminal.rows` (the actual terminal height) and finally
      // `tui.height` (legacy / blessed compatibility).
      try {
        const height =
          typeof tui?.getHeight === 'function'
            ? tui.getHeight()
            : tui?.terminal?.rows ?? tui?.height;
        if (typeof height === 'number' && height > 8) {
          // Reserve ~6 rows for header / footer / controls
          return Math.min(Math.max(3, Math.floor(height - 6)), totalLines);
        }
      } catch (_) {
        // ignore
      }
      return Math.max(12, totalLines);
    };

    const render = (width: number) => {
      // Wrap each content line; each line may produce multiple wrapped lines
      lastWrappedLines = contentLines.flatMap(
        line => wrapToTerminalWidth(line, width),
      );
      lastViewport = computeViewport(lastWrappedLines.length);
      const start = Math.min(
        Math.max(0, offset),
        Math.max(0, lastWrappedLines.length - lastViewport),
      );
      const end = Math.min(lastWrappedLines.length, start + lastViewport);
      offset = start; // keep offset valid
      return lastWrappedLines.slice(start, end);
    };

    const invalidate = () => {
      try { tui?.requestRender?.(); } catch (_) {}
    };

    const handleInput = (data: string) => {
      const totalLines = lastWrappedLines.length || contentLines.length;
      const vp = lastViewport;

      if (isUpKey(data)) {
        offset = Math.max(0, offset - 1);
        invalidate();
        return;
      }

      if (isDownKey(data)) {
        offset = Math.min(Math.max(0, totalLines - 1), offset + 1);
        invalidate();
        return;
      }

      if (isPageUpKey(data)) {
        offset = Math.max(0, offset - vp);
        invalidate();
        return;
      }

      if (isPageDownKey(data)) {
        offset = Math.min(Math.max(0, totalLines - 1), offset + vp);
        invalidate();
        return;
      }

      if (data === 'g') {
        offset = 0;
        invalidate();
        return;
      }

      if (data === 'G') {
        offset = Math.max(0, totalLines - vp);
        invalidate();
        return;
      }
    };

    return { render, invalidate, handleInput };
  };
}

// ── Settings overlay ──────────────────────────────────────────────────

/**
 * Lazy-loaded Pi TUI components for the settings overlay.
 * These are only available in the Pi runtime, not in tests.
 */
let piContainerCtor: any = null;
let piSettingsListCtor: any = null;
let piTextCtor: any = null;
let piGetSettingsListTheme: any = null;

async function ensurePiComponents(): Promise<boolean> {
  if (piContainerCtor && piSettingsListCtor && piTextCtor && piGetSettingsListTheme) {
    return true;
  }
  try {
    const tui = await import('@earendil-works/pi-tui');
    const agent = await import('@earendil-works/pi-coding-agent');
    piContainerCtor = tui.Container;
    piSettingsListCtor = tui.SettingsList;
    piTextCtor = tui.Text;
    piGetSettingsListTheme = agent.getSettingsListTheme;
    return true;
  } catch {
    return false;
  }
}

/**
 * Open the settings overlay for the Worklog Pi extension.
 *
 * Uses Pi's SettingsList component with browseItemCount and showIcons
 * settings. Changes are applied immediately via onChange callback and
 * persisted to settings.json.
 */
function openSettingsOverlay(ctx: BrowseContext): void {
  // Build items array from current settings
  const items = [
    {
      id: 'browseItemCount',
      label: 'Number of items',
      currentValue: String(currentSettings.browseItemCount),
      values: ['3', '5', '10', '15', '20'],
    },
    {
      id: 'showIcons',
      label: 'Show icons',
      currentValue: currentSettings.showIcons ? 'on' : 'off',
      values: ['on', 'off'],
    },
  ];

  // Open the settings overlay
  ctx.ui.custom<void>(
    (tui, theme, _kb, done) => {
      // Kick off async import but return a placeholder synchronously
      let ready = false;
      let component: any = null;

      ensurePiComponents().then((ok) => {
        if (!ok) {
          ctx.ui.notify('Settings overlay unavailable: Pi TUI components not found.', 'error');
          done(undefined);
          return;
        }

        const Container = piContainerCtor;
        const SettingsList = piSettingsListCtor;
        const Text = piTextCtor;
        const getSettingsListTheme = piGetSettingsListTheme;

        const container = new Container();
        container.addChild(
          new Text(theme.fg('accent', theme.bold('Worklog Settings')), 1, 1),
        );

        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 15),
          getSettingsListTheme(),
          (id: string, newValue: string) => {
            // Apply the setting immediately
            if (id === 'browseItemCount') {
              const count = parseInt(newValue, 10);
              if (!isNaN(count) && count >= 1 && count <= 50) {
                updateSettings({ browseItemCount: count });
                ctx.ui.notify(`Browse item count set to ${count}`, 'info');
              }
            } else if (id === 'showIcons') {
              const show = newValue === 'on';
              updateSettings({ showIcons: show });
              ctx.ui.notify(`Icons ${show ? 'enabled' : 'disabled'}`, 'info');
            }
          },
          () => {
            // Close dialog
            done(undefined);
          },
          { enableSearch: false },
        );

        container.addChild(settingsList);

        component = {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };
        ready = true;
        tui.requestRender();
      }).catch((err) => {
        console.error('[worklog-browse] Failed to load Pi components:', err);
        ctx.ui.notify('Failed to open settings overlay.', 'error');
        done(undefined);
      });

      return {
        render: (width: number) => {
          if (ready && component) {
            return component.render(width);
          }
          return [theme.fg('dim', 'Loading settings...')];
        },
        invalidate: () => {
          if (component) component.invalidate();
        },
        handleInput: (_data: string) => {
          if (ready && component?.handleInput) {
            component.handleInput(_data);
            tui.requestRender();
          }
        },
      };
    },
  ).catch(() => {
    // Graceful degradation if overlay fails
    ctx.ui.notify('Settings overlay requires TUI mode.', 'warning');
  });
}


export function createWorklogBrowseExtension(deps: WorklogBrowseDependencies = {}) {
  const runWlImpl = deps.runWl ?? runWl;
  const listWorkItems = deps.listWorkItems ?? (() => defaultListWorkItems(runWlImpl));
  const listWorkItemsWithStage = deps.listWorkItemsWithStage ?? ((stage: string) => defaultListWorkItemsWithStage(stage, runWlImpl));
  // Build the shortcut registry: loads shortcuts.json from the extension directory.
  // If no custom registry is provided via deps, a default registry is built.
  const shortcutRegistry = deps.shortcutRegistry ?? loadShortcutConfig();
  const chooseWorkItem = deps.chooseWorkItem
    ? (deps.chooseWorkItem as (items: WorklogBrowseItem[], ctx: BrowseContext, onSelectionChange: SelectionChangeHandler, registry?: ShortcutRegistry) => Promise<WorklogBrowseItem | ShortcutResult | undefined>)
    : (items: WorklogBrowseItem[], ctx: BrowseContext, onSelectionChange: SelectionChangeHandler) => defaultChooseWorkItem(items, ctx, onSelectionChange, shortcutRegistry);

  return function registerWorklogBrowseExtension(pi: PiLike): void {
    // ── Register activity indicator for commands and skills ──────
    registerActivityIndicator(pi);
    const runBrowseFlow = async (ctx: BrowseContext, stage?: string): Promise<void> => {
      try {
        const itemCount = currentSettings.browseItemCount;
        // The default list functions already slice based on settings,
        // but we pass the count explicitly for consistency.
        const items = stage
          ? (await listWorkItemsWithStage(stage)).slice(0, itemCount)
          : (await listWorkItems()).slice(0, itemCount);
        if (items.length === 0) {
          ctx.ui.notify('No work items available to browse.', 'info');
          ctx.ui.setWidget?.('worklog-browse-selection', undefined);
          return;
        }

        let lastAnnouncedId: string | undefined;
        const announceSelection: SelectionChangeHandler = (
          item: WorklogBrowseItem,
        ) => {
          // Always set the widget so the preview is rebuilt with the latest
          // data, even when the same item ID is re-announced (e.g. after
          // auto-refresh fetches updated status/stage/audit/risk/effort).
          // The widget's internal render cache prevents visual jitter when
          // no data has actually changed.
          lastAnnouncedId = item.id;
          ctx.ui.setWidget?.('worklog-browse-selection', buildSelectionWidget(item, currentSettings), { placement: 'belowEditor' });
        };

        // Announce the first item (index 0) immediately so the preview
        // widget appears without requiring the user to press an arrow key.
        announceSelection(items[0]);

        // Create a re-fetch function for the auto-refresh feature.
        // It re-uses the same listWorkItems/listWorkItemsWithStage
        // functions that were used for the initial fetch, ensuring
        // the stage filter and item count are preserved.
        const reFetchItems = stage
          ? () => listWorkItemsWithStage(stage).then(newItems => newItems.slice(0, itemCount))
          : () => listWorkItems().then(newItems => newItems.slice(0, itemCount));

        // Create a fetchChildren function for hierarchical navigation.
        // It calls `wl list --parent <id>` and parses the output using
        // the same extractJsonObject+normalizeListPayload pipeline used
        // for `wl next` output.
        const fetchChildren = async (parentId: string): Promise<WorklogBrowseItem[]> => {
          const output = await runWlImpl(['list', '--parent', parentId]);
          const payload = extractJsonObject(output);
          return normalizeListPayload(payload);
        };

        // Call defaultChooseWorkItem directly to enable the auto-refresh
        // and hierarchical navigation features. If a custom
        // deps.chooseWorkItem was provided (e.g. in tests), use that
        // instead (without auto-refresh or hierarchical nav).
        let result: WorklogBrowseItem | ShortcutResult | undefined;
        if (deps.chooseWorkItem) {
          result = await deps.chooseWorkItem(items, ctx, announceSelection);
        } else {
          result = await defaultChooseWorkItem(items, ctx, announceSelection, shortcutRegistry, reFetchItems, fetchChildren);
        }
        // Handle shortcut result - set editor text after browse list modal closes
        if (result && 'type' in result && result.type === 'shortcut') {
          ctx.ui.setEditorText?.(result.command);
          ctx.ui.setWidget?.('worklog-browse-selection', undefined);
          return;
        }

        const selectedItem = result as WorklogBrowseItem | undefined;

        if (!selectedItem) {
          // user cancelled selection; clear preview widget
          ctx.ui.setWidget?.('worklog-browse-selection', undefined);
          return;
        }

        // Ensure the final selection is announced (in case chooseWorkItem didn't emit it)
        announceSelection(selectedItem);

        // On Enter: fetch full markdown and show it in a focused scrollable modal.
        // Using ctx.ui.custom() gives the widget proper keyboard focus so that
        // Up/Down/PageUp/PageDown/g/G/Escape are received by handleInput() rather
        // than being swallowed by the editor.  The preview widget remains visible
        // underneath and is not affected when the modal closes.
        if (!ctx.ui.custom) {
          ctx.ui.notify('Scrollable detail view requires a TUI that supports custom overlays.', 'warning');
          return;
        }

        try {
          const mdOutput = await runWlImpl(['show', selectedItem.id, '--format', 'markdown', '--no-icons'], false);
          // Strip blessed-style markup tags ({tag}) which pi's TUI doesn't understand;
          // these appear as literal text and inflate visible width, causing render errors.
          const cleanOutput = mdOutput.replace(/\{[^}]*\}/g, '');
          const detailLines = cleanOutput.split(/\r?\n/);

          // Wrap the scrollable widget so Escape calls done() to close the modal.
          // The scrollable widget's handleInput calls invalidate(), which in turn
          // calls tui.requestRender() — but we need the wrapper to forward Escape
          // to done() (which closes the custom modal) and to pass through all
          // other keys to the scrollable widget.
          let detailPendingChordLeader: string | null = null;
          const detailResult = await ctx.ui.custom<ShortcutResult | string | null>(
            (tui, _theme, _keybindings, done) => {
              const factory = createScrollableWidget(detailLines);
              const widget = factory(tui, _theme);

              return {
                render: (width: number) => widget.render(width),
                invalidate: () => widget.invalidate(),
                handleInput: (data: string) => {
                  const lookupKey = data.length === 1 ? data : undefined;

                  // ── Pending chord state ────────────────────────────
                  if (detailPendingChordLeader !== null && lookupKey) {
                    if (isEscapeKey(data)) {
                      detailPendingChordLeader = null;
                      tui.requestRender();
                      return;
                    }
                    const chordCommand = shortcutRegistry.lookupChord(
                      [detailPendingChordLeader, lookupKey],
                      'detail',
                      selectedItem.stage,
                    );
                    if (chordCommand) {
                      detailPendingChordLeader = null;
                      done({
                        type: 'shortcut' as const,
                        command: chordCommand.replace('<id>', selectedItem.id),
                      });
                      return;
                    }
                    // Unrecognised second key — cancel
                    detailPendingChordLeader = null;
                    tui.requestRender();
                    return;
                  }

                  // ── Normal input ────────────────────────────────────
                  if (lookupKey && !RESERVED_NAVIGATION_KEYS.has(lookupKey)) {
                    // 1) Try single-key shortcut
                    const command = shortcutRegistry.lookup(lookupKey, 'detail', selectedItem.stage);
                    if (command) {
                      done({ type: 'shortcut' as const, command: command.replace('<id>', selectedItem.id) });
                      return;
                    }

                    // 2) Check if key is a chord leader for detail view
                    const chords = shortcutRegistry.getChordByLeader(lookupKey, 'detail');
                    if (chords.length > 0) {
                      const applicableChords = chords.filter(c => {
                        if (selectedItem.stage !== undefined && c.stages !== undefined && c.stages.length > 0) {
                          return c.stages.includes(selectedItem.stage);
                        }
                        return true;
                      });
                      if (applicableChords.length > 0) {
                        detailPendingChordLeader = lookupKey;
                        tui.requestRender();
                        return;
                      }
                    }
                  }

                  if (isEscapeKey(data)) {
                    if (detailPendingChordLeader === null) {
                      ctx.ui.setWidget?.('worklog-browse-selection', undefined);
                      done(null);
                      return;
                    }
                    detailPendingChordLeader = null;
                    tui.requestRender();
                    return;
                  }
                  widget.handleInput(data);
                  tui.requestRender();
                },
              };
            },
          ).catch(() => null);
          // Handle shortcut result from detail view (editor text set after modal closes)
          if (detailResult && typeof detailResult === 'object' && detailResult.type === 'shortcut') {
            ctx.ui.setEditorText?.(detailResult.command);
            ctx.ui.setWidget?.('worklog-browse-selection', undefined);
          }
        } catch (innerErr) {
          const message = innerErr instanceof Error ? innerErr.message : String(innerErr);
          ctx.ui.notify(`Failed to render work item details: ${message}`, 'error');
          // keep the existing preview widget instead of replacing it with an error
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to browse work items: ${message}`, 'error');
      }
    };

    pi.registerCommand('wl', {
      description: `Browse next ${currentSettings.browseItemCount} work items, optionally filtered by stage and settings`,
      handler: async (_args: string, ctx: BrowseContext) => {
        // Set the activity indicator for our own /wl command (AC 1)
        showActivity(ctx as any, '/wl');
        const trimmed = _args?.trim() ?? '';
        if (trimmed.length === 0) {
          await runBrowseFlow(ctx);
          return;
        }
        if (trimmed === 'settings') {
          // Open settings overlay
          await openSettingsOverlay(ctx);
          return;
        }
        const canonical = STAGE_MAP[trimmed];
        if (canonical) {
          await runBrowseFlow(ctx, canonical);
          return;
        }
        ctx.ui.notify(`Unknown stage value: '${trimmed}'`, 'error');
        await runBrowseFlow(ctx);
      },
      getArgumentCompletions: (prefix: string) => {
        const allStages = [...VALID_STAGES].sort();
        // Include 'settings' as a valid completion alongside stage values
        const allCompletions = ['settings', ...allStages].sort();
        const filtered = allCompletions.filter(s => s.startsWith(prefix));
        return filtered.length > 0
          ? filtered.map(s => ({ value: s, label: s }))
          : null;
      },
    });

    pi.registerShortcut('ctrl+shift+b', {
      description: `Browse next ${currentSettings.browseItemCount} recommended work items and preview selected title`,
      handler: async (ctx: BrowseContext) => {
        // Set the activity indicator for our shortcut command (AC 1)
        showActivity(ctx as any, '/wl');
        await runBrowseFlow(ctx);
      },
    });

    // ── Session persistence ────────────────────────────────────────────
    // Reload settings from file on session start and navigation so that any
    // external changes to settings.json are picked up.
    const reloadSettings = () => {
      currentSettings = loadSettings();
    };

    pi.on('session_start', async (_event) => {
      reloadSettings();
    });

    pi.on('session_tree', async (_event) => {
      reloadSettings();
    });

    // When launched via `wl piman` (detected by WL_PIMAN env var), auto-trigger
    // the browse flow on session_start so the user lands directly in the item
    // browser without having to type /wl.
    if (typeof process !== 'undefined' && process.env?.WL_PIMAN === '1') {
      pi.on('session_start', (_event, ctx) => {
        // Defer so Pi's TUI can finish initialising before we show the selector
        setTimeout(() => {
          void runBrowseFlow(ctx as unknown as BrowseContext);
        }, 500);
      });
    }
  };
}

export default createWorklogBrowseExtension();
