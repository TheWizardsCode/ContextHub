/**
 * lib/browse.ts — Browse UI logic for the Worklog extension
 *
 * Extracted from the monolithic index.ts. Provides work item formatting,
 * selection widgets, scrollable detail views, and the browsing overlay.
 */

import { createRequire } from 'node:module';
import { realpathSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { applyStageColour, type PiTheme } from '../worklog-helpers.js';
import { truncateToTerminalWidth, wrapToTerminalWidth, visibleWidth } from '../terminal-utils.js';
import type { ShortcutRegistry, ShortcutEntry } from '../shortcut-config.js';
import { currentSettings } from './settings.js';
import {
  RESERVED_NAVIGATION_KEYS,
  isUpKey,
  isDownKey,
  isPageUpKey,
  isPageDownKey,
  isEnterKey,
  isCtrlEnterKey,
  isShiftEnterKey,
  isEscapeKey,
  isTabKey,
} from './shortcuts.js';

// Re-export keyboard helpers and navigation keys so existing imports from
// browse.js continue to work (and for test access).
export {
  RESERVED_NAVIGATION_KEYS,
  isUpKey,
  isDownKey,
  isPageUpKey,
  isPageDownKey,
  isEnterKey,
  isCtrlEnterKey,
  isShiftEnterKey,
  isEscapeKey,
  isTabKey,
};
import {
  type WorklogBrowseItem,
  type RunWlFn,
  runWl,
  extractJsonObject,
  normalizeListPayload,
  fetchTotalActionableCount,
} from './tools.js';

// Use createRequire with realpath-resolved path so the icons module can be
// found even when this extension is loaded via a symlink.
const _require = createRequire(realpathSync(fileURLToPath(import.meta.url)));
const { priorityIcon, statusIcon, stageIcon, auditIcon, epicIcon, iconsEnabled, riskIcon, effortIcon } = _require('../../../../../dist/icons.js');

// ── Auto-sync state ────────────────────────────────────────────────

/**
 * In-flight guard flag for TUI background auto-sync.
 * Prevents concurrent background syncs when multiple auto-refresh
 * intervals fire before a previous sync completes.
 */
let _autoSyncInFlight = false;

/**
 * Find the .worklog directory by walking up from cwd.
 */
function _findWorklogDir(): string | null {
  let dir = process.cwd();
  while (dir !== dirname(dir)) {
    const candidate = join(dir, '.worklog');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  const rootCandidate = join(dir, '.worklog');
  return existsSync(rootCandidate) ? rootCandidate : null;
}

/**
 * Read the last sync timestamp from .worklog/last-sync-time.
 * Returns null when the file is missing or unreadable.
 */
function _readLastSyncTime(): string | null {
  try {
    const worklogDir = _findWorklogDir();
    if (!worklogDir) return null;
    const lastSyncPath = join(worklogDir, 'last-sync-time');
    if (!existsSync(lastSyncPath)) return null;
    return readFileSync(lastSyncPath, 'utf-8').trim();
  } catch {
    return null;
  }
}

/**
 * Trigger a background `wl sync` if auto-sync conditions are met.
 * Checks the in-flight guard and the configured interval threshold.
 * This is fire-and-forget: errors are silently ignored.
 */
function _triggerAutoSync(): void {
  if (_autoSyncInFlight) return;

  const intervalSeconds = currentSettings.autoSyncIntervalSeconds;
  if (intervalSeconds <= 0) return;

  const lastSyncStr = _readLastSyncTime();
  if (!lastSyncStr) {
    // No sync ever performed - trigger one
  } else {
    const elapsed = Date.now() - new Date(lastSyncStr).getTime();
    if (elapsed < intervalSeconds * 1000) return;
  }

  _autoSyncInFlight = true;

  // Fire-and-forget: invoke wl sync in background, then clear the guard
  runWl(['sync']).finally(() => {
    _autoSyncInFlight = false;
  }).catch(() => {
    _autoSyncInFlight = false;
  });
}

// ── Types ─────────────────────────────────────────────────────────────

export interface ShortcutResult {
  type: 'shortcut';
  command: string;
}

export type SelectionChangeHandler = (item: WorklogBrowseItem) => void;

export type ChooseWorkItemFn = (
  items: WorklogBrowseItem[],
  ctx: BrowseContext,
  onSelectionChange: SelectionChangeHandler,
) => Promise<WorklogBrowseItem | ShortcutResult | undefined>;

export interface WorklogBrowseDependencies {
  listWorkItems?: () => Promise<WorklogBrowseItem[]>;
  listWorkItemsWithStage?: (stage: string) => Promise<WorklogBrowseItem[]>;
  runWl?: RunWlFn;
  chooseWorkItem?: ChooseWorkItemFn;
  shortcutRegistry?: ShortcutRegistry;
}

type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

/**
 * Browse UI interface - matches the subset of ExtensionUIContext we use.
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
  setEditorText?: (text: string) => void;
  getEditorText?: () => string;
  onTerminalInput?: (handler: TerminalInputHandler) => () => void;
  getHeight?: () => number;
  setStatus?: (key: string, text: string | undefined) => void;
  readonly theme?: {
    fg: (color: string, text: string) => string;
    bg: (color: string, text: string) => string;
    bold: (text: string) => string;
  };
}

export type { WorklogBrowseItem } from './tools.js';

export type BrowseContext = { ui: BrowseUi };
type PiLike = ExtensionAPI;

// ── Formatting helpers ────────────────────────────────────────────────

/**
 * Truncate a string to fit within maxWidth visible terminal columns.
 */
export function truncateToWidth(text: string, maxWidth: number, ellipsis = '…'): string {
  return truncateToTerminalWidth(text, maxWidth, { ellipsis });
}

/**
 * Compute the icon prefix string for a work item (just icon characters, no trailing space).
 */
export function getIconPrefix(item: WorklogBrowseItem, noIcons: boolean): string {
  const normalizedStatus = (item.status || '').replace(/_/g, '-');
  const sIcon = statusIcon(normalizedStatus, { noIcons });
  const stIcon = stageIcon(item.stage, { noIcons });
  const aIcon = auditIcon(item.auditResult, { noIcons });
  const coreIcons = [sIcon, stIcon, aIcon].filter(Boolean).join(' ');

  let childSuffix = '';
  if (item.childCount !== undefined && item.childCount > 0) {
    const countStr = `(${item.childCount})`;
    if (item.issueType === 'epic') {
      const eIcon = epicIcon({ noIcons });
      childSuffix = `${eIcon}${countStr}`;
    } else {
      childSuffix = countStr;
    }
  } else if (item.issueType === 'epic') {
    const eIcon = epicIcon({ noIcons });
    childSuffix = eIcon;
  }

  return [coreIcons, childSuffix].filter(Boolean).join(' ');
}

export function formatBrowseOption(
  item: WorklogBrowseItem,
  maxWidth?: number,
  theme?: PiTheme,
  settings?: typeof currentSettings,
  prefixWidth?: number,
): string {
  const titleText = item.title;

  const showIcons = settings?.showIcons ?? iconsEnabled();
  const noIcons = !showIcons;

  const iconPrefix = getIconPrefix(item, noIcons);

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

// ── Selection widget ──────────────────────────────────────────────────

/**
 * Create a selection widget factory that renders a compact single-line
 * summary of work item metadata.
 */
export function buildSelectionWidget(
  item: WorklogBrowseItem,
  settings?: typeof currentSettings,
): (tui: any, _theme: PiTheme) => {
  render: (width: number) => string[];
  invalidate: () => void;
} {
  return (_tui, _theme) => {
    let cachedWidth: number | undefined;
    let cachedLines: string[] | undefined;

    const computeLine = (): string => {
      const idPart = item.id;

      const tags = item.tags;
      const tagStr = Array.isArray(tags) && tags.length > 0
        ? tags.join(', ')
        : '—';
      const tagsPart = `tags: ${tagStr}`;

      const ghPart = (item.githubIssueNumber !== undefined && item.githubIssueNumber > 0)
        ? `GH #${item.githubIssueNumber}`
        : null;

      const showIcons = settings?.showIcons ?? iconsEnabled();
      const noIcons = !showIcons;
      const effortStr = effortIcon(item.effort, { noIcons });
      const riskStr = riskIcon(item.risk, { noIcons });
      const effortRiskPart = [effortStr, riskStr].filter(Boolean).join(' ');

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

// ── Browse overlay (default choose work item) ─────────────────────────

/**
 * State snapshot used to preserve the selection list's navigation context
 * across loop iterations in runBrowseFlow. Captured at the moment an item
 * is selected (Enter), and restored when the loop restarts after returning
 * from the detail view via Escape.
 */
export interface BrowseSelectionState {
  /** Snapshot of the current items array at time of selection */
  currentItems: WorklogBrowseItem[];
  /** Index of the selected item */
  selectedIndex: number;
  /** Last announced item ID (for onSelectionChange dedup) */
  lastSelectionId: string | undefined;
  /** Hierarchical navigation stack (drill-down parents) */
  navStack: Array<{
    items: WorklogBrowseItem[];
    selectedIndex: number;
    lastSelectionId: string | undefined;
  }>;
}

/**
 * Default work item chooser that renders a custom overlay with the browse list.
 */
export async function defaultChooseWorkItem(
  items: WorklogBrowseItem[],
  ctx: BrowseContext,
  onSelectionChange: SelectionChangeHandler,
  shortcutRegistry?: ShortcutRegistry,
  reFetchItems?: () => Promise<WorklogBrowseItem[]>,
  fetchChildren?: (parentId: string) => Promise<WorklogBrowseItem[]>,
  totalCount?: number,
  /**
   * Optional mutable context for preserving navigation state across
   * loop restarts. When provided with a non-empty snapshot, the
   * selection list initializes from the restored state instead of
   * starting fresh. The state is updated again when an item is
   * selected (so the next iteration sees the correct hierarchy level).
   */
  selectionState?: BrowseSelectionState,
): Promise<WorklogBrowseItem | ShortcutResult | undefined> {
  if (!ctx.ui.custom) {
    if (!ctx.ui.select) {
      throw new Error('Selection UI is unavailable in this environment.');
    }

    const noIcons = !(currentSettings?.showIcons ?? iconsEnabled());
    const maxPrefixWidth = items.reduce(
      (max, item) => Math.max(max, visibleWidth(getIconPrefix(item, noIcons))),
      0,
    );

    const options = items.map(item => formatBrowseOption(item, undefined, undefined, currentSettings, maxPrefixWidth));
    const titleSuffix = totalCount !== undefined ? ` (top ${totalCount > 0 ? Math.min(currentSettings.browseItemCount, totalCount) : currentSettings.browseItemCount} of ${totalCount})` : ` (top ${currentSettings.browseItemCount})`;
    const selected = await ctx.ui.select(`Browse Worklog next items${titleSuffix}`, options);
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

  // ── Chord state ──────────────────────────────────────────────────
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

    // ── Auto-refresh interval ──────────────────────────────────────
    let refreshInterval: ReturnType<typeof setInterval> | undefined;

    if (reFetchItems) {
      refreshInterval = setInterval(async () => {
        if (pendingChordLeader !== null) return;

        // Trigger background auto-sync if interval has elapsed
        _triggerAutoSync();

        try {
          let newItems: WorklogBrowseItem[];

          if (navStack.length > 0) {
            const parentEntry = navStack[navStack.length - 1];
            const parentId = parentEntry.items[parentEntry.selectedIndex]?.id;
            if (!parentId || !fetchChildren) return;

            const childResults = await fetchChildren(parentId);
            newItems = [
              { id: '..', title: '..', status: 'open' },
              ...childResults,
            ];
          } else {
            newItems = await reFetchItems();
          }

          if (newItems.length === 0 && items.length === 0) return;

          const currentId = items[selectedIndex]?.id;
          let newIndex = currentId
            ? newItems.findIndex(item => item.id === currentId)
            : -1;
          if (newIndex < 0) newIndex = 0;

          items.length = 0;
          items.push(...newItems);
          selectedIndex = newIndex;

          const item = items[selectedIndex];
          if (item) {
            lastSelectionId = item.id;
            onSelectionChange(item);
          }

          invalidateCache();
          tui.requestRender();
        } catch {
          // Silently ignore refresh errors
        }
      }, 5000);
    }

    const _done = (value: WorklogBrowseItem | ShortcutResult | null) => {
      if (refreshInterval !== undefined) {
        clearInterval(refreshInterval);
        refreshInterval = undefined;
      }
      // Save current navigation state before resolving
      if (selectionState) {
        selectionState.currentItems = [...items];
        selectionState.selectedIndex = selectedIndex;
        selectionState.lastSelectionId = lastSelectionId;
        selectionState.navStack = navStack.map(entry => ({
          items: [...entry.items],
          selectedIndex: entry.selectedIndex,
          lastSelectionId: entry.lastSelectionId,
        }));
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

    // ── Hierarchical navigation stack ──────────────────────────────
    interface NavStackEntry {
      items: WorklogBrowseItem[];
      selectedIndex: number;
      lastSelectionId: string | undefined;
    }
    const navStack: NavStackEntry[] = [];
    let isLoadingChildren = false;

    // ── Restore navigation state if available (from loop restart) ──
    if (selectionState) {
      if (selectionState.selectedIndex >= 0 && selectionState.selectedIndex < items.length) {
        selectedIndex = selectionState.selectedIndex;
      }
      if (selectionState.lastSelectionId !== undefined) {
        lastSelectionId = selectionState.lastSelectionId;
      }
      // Restore nav stack (deep copy of saved entries)
      for (const entry of selectionState.navStack) {
        navStack.push({
          items: [...entry.items],
          selectedIndex: entry.selectedIndex,
          lastSelectionId: entry.lastSelectionId,
        });
      }
      // Mark state as consumed
      selectionState.currentItems = [];
    }

    const formatEntryLabel = (e: ShortcutEntry): string => {
      const label = e.label ?? e.command
        .replace(/<[^>]+>/g, '')
        .split(/\r?\n/)[0]
        .trim()
        .replace(/^\/(skill:)?/, '');
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

        const isEmpty = items.length === 0;
        const title = isEmpty
          ? truncateToWidth(theme.fg('accent', theme.bold('No work items to browse')), width)
          : (() => {
              const titleSuffix = totalCount !== undefined
                ? ` (top ${totalCount > 0 ? Math.min(browseCount, totalCount) : browseCount} of ${totalCount})`
                : ` (top ${browseCount})`;
              return truncateToWidth(theme.fg('accent', theme.bold(`Browse Worklog next items${titleSuffix}`)), width);
            })();

        let helpText = '';
        if (shortcutRegistry) {
          const selectedStage = items[selectedIndex]?.stage;

          if (pendingChordLeader !== null) {
            const chords = shortcutRegistry.getChordByLeader(pendingChordLeader, 'list');
            if (chords.length > 0) {
              const hints = chords
                .filter(c => {
                  if (isEmpty && c.command.includes('<id>')) return false;
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
                    const rest = label.split(/\s+/).slice(1).join(' ');
                    const hint = rest.length > 0 ? `${secondKey}:${rest}` : secondKey;
                    return hint;
                  }
                  return formatEntryLabel(e);
                })
                .join(' ');
              if (hints.length > 0) {
                helpText = `\uD83D\uDD17 ${hints}`;
              }
            }
          } else {
            const relevantEntries = shortcutRegistry
              .getEntriesForStage(selectedStage)
              .filter(e => e.view === 'list' || e.view === 'both')
              .filter(e => {
                if (isEmpty && e.command.includes('<id>')) return false;
                return true;
              });
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
        // Append Tab/Ctrl+Enter/Shift+Enter hint when the selected item has children
        if (items[selectedIndex] && items[selectedIndex].childCount !== undefined && items[selectedIndex].childCount > 0) {
          const childrenHint = 'Tab/Ctrl+Enter/Shift+Enter:children';
          helpText = helpText ? `${helpText} ${childrenHint}` : childrenHint;
        }
        const help = currentSettings.showHelpText
          ? truncateToWidth(theme.fg('dim', helpText), width)
          : '';

        const noIcons = !(currentSettings?.showIcons ?? iconsEnabled());
        const maxPrefixWidth = items.reduce(
          (max, item) => Math.max(max, visibleWidth(getIconPrefix(item, noIcons))),
          0,
        );

        // Build display rows, inserting group separator lines when the group changes
        // between items. Group separators are non-selectable visual breaks.
        const displayRows: string[] = [];
        if (items.length > 0) {
          let lastDisplayedGroup: number | undefined;
          for (let index = 0; index < items.length; index++) {
            const item = items[index];

            // Insert group heading when the first item with a group is encountered,
            // or when the group changes between consecutive items.
            if (item.id !== '..' && item.group !== undefined) {
              if (lastDisplayedGroup === undefined || item.group !== lastDisplayedGroup) {
                const label = item.groupLabel ?? `Group ${item.group}`;
                displayRows.push(theme.fg('dim', theme.bold(`── ${label} ──`)));
              }
              lastDisplayedGroup = item.group;
            }

            const prefix = index === selectedIndex ? theme.fg('accent', '\u203A ') : '  ';
            const contentWidth = Math.max(0, width - 2);
            const optionLine = item.id === '..'
              ? `${prefix}${item.title || '..'}`
              : `${prefix}${formatBrowseOption(item, contentWidth, theme, currentSettings, maxPrefixWidth)}`;
            displayRows.push(truncateToWidth(optionLine, width));
          }
        } else {
          displayRows.push(theme.fg('dim', '  No items to display'));
        }

        const lines = [title, '', ...displayRows, '', help];
        cachedWidth = width;
        cachedLines = lines;
        return lines;
      },
      invalidate: () => {
        invalidateCache();
      },
      handleInput: (data: string) => {
        const lookupKey = data.length === 1 ? data : undefined;

        // ── Pending chord state ────────────────────────────────────
        if (pendingChordLeader !== null && lookupKey) {
          if (isEscapeKey(data)) {
            pendingChordLeader = null;
            invalidateCache();
            tui.requestRender();
            return;
          }
          const selectedStage = items[selectedIndex]?.stage;
          const chordCommand = shortcutRegistry!.lookupChord(
            [pendingChordLeader, lookupKey],
            'list',
            selectedStage,
          );
          if (chordCommand) {
            pendingChordLeader = null;
            if (chordCommand.includes('<id>')) {
              const chordTarget = items[selectedIndex];
              if (!chordTarget) return;
              _done({
                type: 'shortcut' as const,
                command: chordCommand.replace('<id>', chordTarget.id),
              });
            } else {
              _done({ type: 'shortcut' as const, command: chordCommand });
            }
            return;
          }
          pendingChordLeader = null;
          invalidateCache();
          tui.requestRender();
          return;
        }

        // ── Normal input ───────────────────────────────────────────
        if (lookupKey && !RESERVED_NAVIGATION_KEYS.has(lookupKey) && shortcutRegistry) {
          const selectedStage = items[selectedIndex]?.stage;

          const command = shortcutRegistry.lookup(lookupKey, 'list', selectedStage);
          if (command) {
            if (command.includes('<id>')) {
              const shortcutTarget = items[selectedIndex];
              if (!shortcutTarget) return;
              _done({ type: 'shortcut' as const, command: command.replace('<id>', shortcutTarget.id) });
            } else {
              _done({ type: 'shortcut' as const, command });
            }
            return;
          }

          const chords = shortcutRegistry.getChordByLeader(lookupKey, 'list');
          if (chords.length > 0) {
            const applicableChords = chords.filter(c => {
              if (items.length === 0 && c.command.includes('<id>')) return false;
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

        if (isEnterKey(data) || isCtrlEnterKey(data) || isShiftEnterKey(data) || isTabKey(data)) {
          const selected = items[selectedIndex];
          if (!selected) {
            _done(null);
            return;
          }

          if (selected.id === '..') {
            const parentState = navStack.pop();
            if (parentState) {
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
            }
            return;
          }

          // Tab, Ctrl+Enter, or Shift+Enter on a parent item → navigate into children
          // Enter on any item (including parents) → open detail view
          if (
            (isTabKey(data) || isCtrlEnterKey(data) || isShiftEnterKey(data))
            && selected.childCount !== undefined
            && selected.childCount > 0
            && fetchChildren
            && !isLoadingChildren
          ) {
            navStack.push({
              items: [...items],
              selectedIndex,
              lastSelectionId,
            });

            isLoadingChildren = true;

            fetchChildren(selected.id)
              .then(childItems => {
                isLoadingChildren = false;

                const parentEntry: WorklogBrowseItem = {
                  id: '..',
                  title: '..',
                  status: 'open',
                };

                items.length = 0;
                items.push(parentEntry, ...childItems);
                selectedIndex = 0;
                lastSelectionId = items[0]?.id;

                if (items[0]) {
                  onSelectionChange(items[0]);
                }

                invalidateCache();
                tui.requestRender();
              })
              .catch(() => {
                isLoadingChildren = false;
                navStack.pop();
                ctx.ui.notify('Failed to fetch children.', 'warning');
                invalidateCache();
                tui.requestRender();
              });

            return;
          }

          _done(selected);
          return;
        }

        if (isEscapeKey(data)) {
          if (pendingChordLeader !== null) {
            pendingChordLeader = null;
            invalidateCache();
            tui.requestRender();
            return;
          }

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

          _done(null);
        }
      },
    };
  });

  return result ?? undefined;
}

// ── Scrollable detail view widget ─────────────────────────────────────

/**
 * Create a scrollable widget factory for rendering work item details.
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
    let lastWrappedLines: string[] = [];
    let lastViewport = 12;

    const computeViewport = (totalLines: number) => {
      try {
        const height =
          typeof tui?.getHeight === 'function'
            ? tui.getHeight()
            : tui?.terminal?.rows ?? tui?.height;
        if (typeof height === 'number' && height > 8) {
          return Math.min(Math.max(3, Math.floor(height - 6)), totalLines);
        }
      } catch (_) {
        // ignore
      }
      return Math.max(12, totalLines);
    };

    const render = (width: number) => {
      lastWrappedLines = contentLines.flatMap(
        line => wrapToTerminalWidth(line, width),
      );
      lastViewport = computeViewport(lastWrappedLines.length);
      const start = Math.min(
        Math.max(0, offset),
        Math.max(0, lastWrappedLines.length - lastViewport),
      );
      const end = Math.min(lastWrappedLines.length, start + lastViewport);
      offset = start;
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

// ── Browse flow orchestrator ───────────────────────────────────────────

export interface BrowseFlowOptions {
  listWorkItems: () => Promise<WorklogBrowseItem[]>;
  listWorkItemsWithStage: (stage: string) => Promise<WorklogBrowseItem[]>;
  runWlImpl: RunWlFn;
  shortcutRegistry: ShortcutRegistry;
  /** Optional injected chooseWorkItem (for tests). Falls back to defaultChooseWorkItem. */
  chooseWorkItem?: ChooseWorkItemFn;
}

/**
 * Run the browse flow: fetch items, show selection widget, handle results.
 *
 * Extracted from createWorklogBrowseExtension to keep index.ts thin.
 */
export async function runBrowseFlow(
  ctx: BrowseContext,
  options: BrowseFlowOptions,
  stage?: string,
): Promise<void> {
  const { listWorkItems, listWorkItemsWithStage, runWlImpl, shortcutRegistry, chooseWorkItem } = options;

  try {
    const itemCount = currentSettings.browseItemCount;

    let lastAnnouncedId: string | undefined;
    const announceSelection: SelectionChangeHandler = (
      item: WorklogBrowseItem,
    ) => {
      lastAnnouncedId = item.id;
      ctx.ui.setWidget?.('worklog-browse-selection', buildSelectionWidget(item, currentSettings), { placement: 'belowEditor' });
    };

    const reFetchItems = stage
      ? () => listWorkItemsWithStage(stage).then(newItems => newItems.slice(0, itemCount))
      : () => listWorkItems().then(newItems => newItems.slice(0, itemCount));

    const fetchChildren = async (parentId: string): Promise<WorklogBrowseItem[]> => {
      const output = await runWlImpl(['list', '--parent', parentId]);
      const payload = extractJsonObject(output);
      return normalizeListPayload(payload);
    };

    const totalActionableCount = await fetchTotalActionableCount(runWlImpl);

    // ── Preserved selection state for hierarchy restoration ─────────
    // When the user drills into children and opens a detail view, the
    // selection state (items, navStack) is captured so the loop can
    // restore the same hierarchy level when Escape closes the detail.
    const selectionState: BrowseSelectionState = {
      currentItems: [],
      selectedIndex: 0,
      lastSelectionId: undefined,
      navStack: [],
    };

    // ── Browse loop: selection list → detail → selection list → … ──
    while (true) {
      // Check if we have preserved items from a previous loop iteration
      // (e.g. user was in a child hierarchy and pressed Escape in detail).
      const hasPreservedItems = selectionState.currentItems.length > 0;

      const items = hasPreservedItems
        ? (() => {
            const restored = selectionState.currentItems;
            selectionState.currentItems = []; // Consume once
            return restored;
          })()
        : stage
          ? (await listWorkItemsWithStage(stage)).slice(0, itemCount)
          : (await listWorkItems()).slice(0, itemCount);

      if (items[0]) {
        announceSelection(items[0]);
      }

      let result: WorklogBrowseItem | ShortcutResult | undefined;
      if (chooseWorkItem) {
        result = await chooseWorkItem(items, ctx, announceSelection);
      } else {
        result = await defaultChooseWorkItem(items, ctx, announceSelection, shortcutRegistry, reFetchItems, fetchChildren, totalActionableCount, selectionState);
      }

      if (result && 'type' in result && result.type === 'shortcut') {
        ctx.ui.setEditorText?.(result.command);
        ctx.ui.setWidget?.('worklog-browse-selection', undefined);
        return;
      }

      const selectedItem = result as WorklogBrowseItem | undefined;

      if (!selectedItem) {
        ctx.ui.setWidget?.('worklog-browse-selection', undefined);
        return;
      }

      announceSelection(selectedItem);

      if (!ctx.ui.custom) {
        ctx.ui.notify('Scrollable detail view requires a TUI that supports custom overlays.', 'warning');
        return;
      }

      try {
        const mdOutput = await runWlImpl(['show', selectedItem.id, '--format', 'markdown', '--no-icons'], false);
        const cleanOutput = mdOutput.replace(/\{[^}]*\}/g, '');
        const detailLines = cleanOutput.split(/\r?\n/);

        let detailPendingChordLeader: string | null = null;
        const detailResult = await ctx.ui.custom<ShortcutResult | string | null>(
          (tui, _theme, _keybindings, done) => {
            const factory = createScrollableWidget(detailLines);
            const widget = factory(tui, _theme);

            return {
              render: (width: number) => {
                const lines = widget.render(width);

                // ── Shortcut hints ──────────────────────────────────────────
                if (currentSettings.showHelpText) {
                  let helpText = '';
                  const formatHint = (e: ShortcutEntry): string => {
                    const label = e.label ?? e.command
                      .replace(/<[^>]+>/g, '')
                      .split(/\r?\n/)[0]
                      .trim()
                      .replace(/^\/(skill:)?/, '');
                    const chord = (e as Record<string, unknown>).chord;
                    if (Array.isArray(chord) && chord.length >= 2) {
                      const leaderKey = (chord as string[])[0];
                      const firstWord = label.split(/\s+/)[0];
                      return `${leaderKey}:${firstWord}...`;
                    }
                    return `${e.key}:${label}`;
                  };

                  if (detailPendingChordLeader !== null) {
                    const chords = shortcutRegistry.getChordByLeader(detailPendingChordLeader, 'detail');
                    if (chords.length > 0) {
                      const hints = chords
                        .filter(c => {
                          if (selectedItem.stage !== undefined && c.stages !== undefined && c.stages.length > 0) {
                            return c.stages.includes(selectedItem.stage);
                          }
                          return true;
                        })
                        .map(e => {
                          const chord = (e as Record<string, unknown>).chord;
                          if (Array.isArray(chord) && chord.length >= 2) {
                            const secondKey = (chord as string[])[1];
                            const label = e.label ?? e.command
                              .replace(/<[^>]+>/g, '')
                              .split(/\r?\n/)[0]
                              .trim()
                              .replace(/^\/(skill:)?/, '');
                            const rest = label.split(/\s+/).slice(1).join(' ');
                            return rest.length > 0 ? `${secondKey}:${rest}` : secondKey;
                          }
                          return formatHint(e);
                        })
                        .join(' ');
                      if (hints.length > 0) {
                        helpText = `\uD83D\uDD17 ${hints}`;
                      }
                    }
                  } else {
                    const relevantEntries = shortcutRegistry
                      .getEntriesForStage(selectedItem.stage)
                      .filter(e => e.view === 'detail' || e.view === 'both');
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
                        .map(e => formatHint(e))
                        .join(' ');
                    }
                  }
                  if (helpText) {
                    return [...lines, '', _theme.fg('dim', truncateToWidth(helpText, width))];
                  }
                }

                return lines;
              },
              invalidate: () => widget.invalidate(),
              handleInput: (data: string) => {
                const lookupKey = data.length === 1 ? data : undefined;

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
                  detailPendingChordLeader = null;
                  tui.requestRender();
                  return;
                }

                if (lookupKey && !RESERVED_NAVIGATION_KEYS.has(lookupKey)) {
                  const command = shortcutRegistry.lookup(lookupKey, 'detail', selectedItem.stage);
                  if (command) {
                    done({ type: 'shortcut' as const, command: command.replace('<id>', selectedItem.id) });
                    return;
                  }

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

        if (detailResult && typeof detailResult === 'object' && detailResult.type === 'shortcut') {
          ctx.ui.setEditorText?.(detailResult.command);
          ctx.ui.setWidget?.('worklog-browse-selection', undefined);
          return;
        }

        // detailResult is null (Escape pressed) — loop back to selection list
      } catch (innerErr) {
        const message = innerErr instanceof Error ? innerErr.message : String(innerErr);
        ctx.ui.notify(`Failed to render work item details: ${message}`, 'error');
        // On error, also loop back to selection list
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to browse work items: ${message}`, 'error');
  }
}
