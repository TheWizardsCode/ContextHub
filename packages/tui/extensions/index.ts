import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { priorityIcon, statusIcon, iconsEnabled } from '../../../src/icons.js';
import { applyStageColour, type WorkItem, type PiTheme } from './worklog-helpers.js';
import { truncateToTerminalWidth } from './terminal-utils.js';
import { type ShortcutRegistry, loadShortcutConfig } from './shortcut-config.js';
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

const execFileAsync = promisify(execFile);

export interface WorklogBrowseItem {
  id: string;
  title: string;
  status: string;
  priority?: string;
  stage?: string;
  risk?: string;
  effort?: string;
  description?: string;
}

type RunWlFn = (args: string[], includeJson?: boolean) => Promise<string>;
type SelectionChangeHandler = (item: WorklogBrowseItem) => void;
type ChooseWorkItemFn = (
  items: WorklogBrowseItem[],
  ctx: BrowseContext,
  onSelectionChange: SelectionChangeHandler,
) => Promise<WorklogBrowseItem | ShortcutResult | undefined>;

interface WorklogBrowseDependencies {
  listWorkItems?: () => Promise<WorklogBrowseItem[]>;
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

export function formatBrowseOption(
  item: WorklogBrowseItem,
  maxWidth?: number,
  theme?: PiTheme,
): string {
  const idPart = `(${item.id})`;
  const titleText = item.title;
  const fullVisibleLength = titleText.length + 1 + idPart.length; // +1 for space

  // Apply colour to title if theme is provided
  const formatTitle = (title: string): string => {
    if (theme) {
      return applyStageColour(title, item.stage, item.status, theme);
    }
    return title;
  };

  if (!maxWidth || maxWidth <= 0 || fullVisibleLength <= maxWidth) {
    return `${formatTitle(titleText)} ${idPart}`;
  }

  const separatorAndId = ` ${idPart}`;
  if (maxWidth <= separatorAndId.length) {
    return truncateToWidth(idPart, maxWidth);
  }

  const titleWidth = maxWidth - separatorAndId.length;
  const truncatedTitle = truncateToWidth(titleText, titleWidth);
  return `${formatTitle(truncatedTitle)}${separatorAndId}`;
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
    }))
    .filter(item => item.id.length > 0);
}

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
      throw new Error(message);
    }
  }

  throw new Error(`Unable to execute wl/worklog CLI: ${String(lastError)}`);
}

export function createDefaultListWorkItems(run: RunWlFn = runWl): () => Promise<WorklogBrowseItem[]> {
  return async (): Promise<WorklogBrowseItem[]> => {
    const output = await run(['next', '-n', '5']);
    const payload = extractJsonObject(output);
    return normalizeListPayload(payload).slice(0, 5);
  };
}

async function defaultListWorkItems(run: RunWlFn = runWl): Promise<WorklogBrowseItem[]> {
  return createDefaultListWorkItems(run)();
}

function descriptionPreview(description: string | undefined, maxLines = 7): string[] {
  if (!description || description.trim().length === 0) return ['—'];
  return description.split(/\r?\n/).slice(0, maxLines);
}

/**
 * Create a selection widget factory that renders work item details.
 *
 * Returns a factory function that the TUI calls with (tui, theme) to get a
 * component with render(width). The theme is used to apply stage-based
 * colours to the title line.
 *
 * Exported for testing.
 */
export function buildSelectionWidget(
  item: WorklogBrowseItem,
): (tui: any, theme: PiTheme) => {
  render: (width: number) => string[];
  invalidate: () => void;
} {
  return (_tui, theme) => {
    // Build icon prefix using emoji icons (no blessed tags - Pi handles styling)
    const useIcons = iconsEnabled();
    const pIcon = priorityIcon(item.priority || '', { noIcons: !useIcons });
    const sIcon = statusIcon(item.status || '', { noIcons: !useIcons });
    const iconPrefix = (pIcon || sIcon) ? `${pIcon}${sIcon} ` : '';

    const priority = item.priority ?? '—';
    const stage = item.stage ?? '—';
    const status = item.status ?? '—';
    const risk = item.risk ?? '—';
    const effort = item.effort ?? '—';

    // Apply stage-based colour to the title, with blocked status override
    const colouredTitle = applyStageColour(
      `${iconPrefix}${item.title} <${item.id}>`,
      item.stage,
      item.status,
      theme,
    );

    // Pre-build the lines with colours applied
    const lines = [
      colouredTitle,
      `Priority/Stage/Status: ${priority}/${stage}/${status}`,
      `Risk/Effort: ${risk}/${effort}`,
      ...descriptionPreview(item.description, 7),
    ];

    return {
      render: (width: number) => lines.map(line => truncateToWidth(line, width)),
      invalidate: () => {
        // no-op: all rendering is derived from local state
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
  return data === '\u001b[A' || data === 'up' || /^\u001b\[1;\d+(?::\d+)?A$/.test(data);
}

function isDownKey(data: string): boolean {
  return data === '\u001b[B' || data === 'down' || /^\u001b\[1;\d+(?::\d+)?B$/.test(data);
}

function isPageUpKey(data: string): boolean {
  return (
    data === '\u001b[5~'
    || data === '\u001b[[5~'
    || data === 'pageup'
    || data === 'pageUp'
    || /^\u001b\[5;\d+(?::\d+)?~$/.test(data)
  );
}

function isPageDownKey(data: string): boolean {
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
  return data === '\r' || data === '\n' || data === 'enter' || data === 'return';
}

function isEscapeKey(data: string): boolean {
  return data === '\u001b' || data === 'escape';
}

/**
 * Shortcut result type - returned when a shortcut key is pressed in the browse list.
 * The caller should set editor text with the resolved command.
 */
export interface ShortcutResult {
  type: 'shortcut';
  command: string;
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
): Promise<WorklogBrowseItem | ShortcutResult | undefined> {
  if (!ctx.ui.custom) {
    if (!ctx.ui.select) {
      throw new Error('Selection UI is unavailable in this environment.');
    }

    const options = items.map(item => formatBrowseOption(item));
    const selected = await ctx.ui.select('Browse Worklog next items (top 5)', options);
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

  const result = await ctx.ui.custom<WorklogBrowseItem | ShortcutResult | null>((tui, theme, _keybindings, done) => {
    let selectedIndex = 0;
    let lastSelectionId = items[0]?.id;

    const moveSelection = (nextIndex: number) => {
      if (nextIndex < 0 || nextIndex >= items.length || nextIndex === selectedIndex) return;
      selectedIndex = nextIndex;
      const item = items[selectedIndex];
      if (item && item.id !== lastSelectionId) {
        lastSelectionId = item.id;
        onSelectionChange(item);
      }
    };

    return {
      focused: false,
      render: (width: number) => {
        const title = truncateToWidth(theme.fg('accent', theme.bold('Browse Worklog next items (top 5)')), width);
        const help = truncateToWidth(theme.fg('dim', '↑↓ navigate • enter select • esc cancel'), width);
        const options = items.map((item, index) => {
          const prefix = index === selectedIndex ? theme.fg('accent', '› ') : '  ';
          const contentWidth = Math.max(0, width - 2);
          const optionLine = `${prefix}${formatBrowseOption(item, contentWidth, theme)}`;
          return truncateToWidth(optionLine, width);
        });

        return [title, '', ...options, '', help];
      },
      invalidate: () => {
        // no-op: all rendering is derived from local state
      },
      handleInput: (data: string) => {
        // Only attempt shortcut dispatch if the key is NOT a reserved navigation key.
        // Navigation keys (g, G, space) must always take precedence over shortcuts.
        const lookupKey = data.length === 1 ? data : undefined;
        if (lookupKey && !RESERVED_NAVIGATION_KEYS.has(lookupKey) && shortcutRegistry) {
          const command = shortcutRegistry.lookup(lookupKey, 'list');
          if (command) {
            // Return the shortcut result - caller will set editor text after modal closes
            done({ type: 'shortcut', command: command.replace('<id>', items[selectedIndex].id) } as any);
            return;
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
          done(items[selectedIndex] ?? null);
          return;
        }

        if (isEscapeKey(data)) {
          done(null);
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

    const getViewport = () => {
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
          return Math.min(Math.max(3, Math.floor(height - 6)), contentLines.length);
        }
      } catch (_) {
        // ignore
      }
      return Math.max(12, contentLines.length);
    };

    const render = (width: number) => {
      const vp = getViewport();
      const start = Math.min(Math.max(0, offset), Math.max(0, contentLines.length - vp));
      const end = Math.min(contentLines.length, start + vp);
      return contentLines.slice(start, end).map(line => truncateToWidth(line, width));
    };

    const invalidate = () => {
      try { tui?.requestRender?.(); } catch (_) {}
    };

    const handleInput = (data: string) => {
      if (isUpKey(data)) {
        offset = Math.max(0, offset - 1);
        invalidate();
        return;
      }

      if (isDownKey(data)) {
        offset = Math.min(Math.max(0, contentLines.length - 1), offset + 1);
        invalidate();
        return;
      }

      if (isPageUpKey(data)) {
        offset = Math.max(0, offset - getViewport());
        invalidate();
        return;
      }

      if (isPageDownKey(data)) {
        offset = Math.min(Math.max(0, contentLines.length - 1), offset + getViewport());
        invalidate();
        return;
      }

      if (data === 'g') {
        offset = 0;
        invalidate();
        return;
      }

      if (data === 'G') {
        offset = Math.max(0, contentLines.length - getViewport());
        invalidate();
        return;
      }
    };

    return { render, invalidate, handleInput };
  };
}

export function createWorklogBrowseExtension(deps: WorklogBrowseDependencies = {}) {
  const runWlImpl = deps.runWl ?? runWl;
  const listWorkItems = deps.listWorkItems ?? (() => defaultListWorkItems(runWlImpl));
  // Build the shortcut registry: loads shortcuts.json from the extension directory.
  // If no custom registry is provided via deps, a default registry is built.
  const shortcutRegistry = deps.shortcutRegistry ?? loadShortcutConfig();
  const chooseWorkItem = deps.chooseWorkItem
    ? (deps.chooseWorkItem as (items: WorklogBrowseItem[], ctx: BrowseContext, onSelectionChange: SelectionChangeHandler, registry?: ShortcutRegistry) => Promise<WorklogBrowseItem | ShortcutResult | undefined>)
    : (items: WorklogBrowseItem[], ctx: BrowseContext, onSelectionChange: SelectionChangeHandler) => defaultChooseWorkItem(items, ctx, onSelectionChange, shortcutRegistry);

  return function registerWorklogBrowseExtension(pi: PiLike): void {
    const runBrowseFlow = async (ctx: BrowseContext): Promise<void> => {
      try {
        const items = (await listWorkItems()).slice(0, 5);
        if (items.length === 0) {
          ctx.ui.notify('No work items available to browse.', 'info');
          ctx.ui.setWidget?.('worklog-browse-selection', undefined);
          return;
        }

        let lastAnnouncedId: string | undefined;
        const announceSelection: SelectionChangeHandler = (
          item: WorklogBrowseItem,
        ) => {
          if (item.id === lastAnnouncedId) return;
          lastAnnouncedId = item.id;
          ctx.ui.setWidget?.('worklog-browse-selection', buildSelectionWidget(item), { placement: 'belowEditor' });
        };

        const result = await chooseWorkItem(items, ctx, announceSelection);
        // Handle shortcut result - set editor text after browse list modal closes
        if (result && result.type === 'shortcut') {
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
          const detailResult = await ctx.ui.custom<string | null>(
            (tui, _theme, _keybindings, done) => {
              const factory = createScrollableWidget(detailLines);
              const widget = factory(tui, _theme);

              return {
                focused: false,
                render: (width: number) => widget.render(width),
                invalidate: () => widget.invalidate(),
                handleInput: (data: string) => {
                  // Only attempt shortcut dispatch if the key is NOT a reserved
                  // navigation key. Navigation keys (g, G, space) must always
                  // take precedence over configurable shortcuts.
                  const lookupKey = data.length === 1 ? data : undefined;
                  if (lookupKey && !RESERVED_NAVIGATION_KEYS.has(lookupKey)) {
                    const command = shortcutRegistry.lookup(lookupKey, 'detail');
                    if (command) {
                      // Return shortcut result - caller will set editor text after modal closes
                      done({ type: 'shortcut', command: command.replace('<id>', selectedItem.id) } as any);
                      return;
                    }
                  }

                  if (isEscapeKey(data)) {
                    // Clear the preview widget before closing the modal
                    ctx.ui.setWidget?.('worklog-browse-selection', undefined);
                    done(null);
                    return;
                  }
                  widget.handleInput(data);
                  tui.requestRender();
                },
              };
            },
          ).catch(() => null);
          // Handle shortcut result from detail view (editor text set after modal closes)
          if (detailResult && typeof detailResult === 'object' && (detailResult as any).type === 'shortcut') {
            ctx.ui.setEditorText?.((detailResult as any).command);
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
      description: 'Browse next 5 work items and preview selected title above editor',
      handler: async (_args: string, ctx: BrowseContext) => {
        await runBrowseFlow(ctx);
      },
    });

    pi.registerShortcut('ctrl+shift+b', {
      description: 'Browse next 5 recommended work items and preview selected title',
      handler: async (ctx: BrowseContext) => {
        await runBrowseFlow(ctx);
      },
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
