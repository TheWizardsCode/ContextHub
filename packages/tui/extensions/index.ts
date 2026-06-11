import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { applyStageColour } from './worklog-helpers.js';

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
) => Promise<WorklogBrowseItem | undefined>;

interface WorklogBrowseDependencies {
  listWorkItems?: () => Promise<WorklogBrowseItem[]>;
  runWl?: RunWlFn;
  chooseWorkItem?: ChooseWorkItemFn;
}

type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

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
  /** Register a raw terminal input listener. Returns an unsubscribe function. */
  onTerminalInput?: (handler: TerminalInputHandler) => () => void;
  /** Return the height of the usable rendering area (terminal rows minus header/footer). */
  getHeight?: () => number;
}

interface BrowseContext {
  ui: BrowseUi;
}

interface PiLike {
  registerCommand: (name: string, command: { description: string; handler: (args: string, ctx: BrowseContext) => Promise<void> }) => void;
  registerShortcut: (shortcut: string, shortcutDef: { description: string; handler: (ctx: BrowseContext) => Promise<void> }) => void;
  sendMessage: (message: { customType: string; content: string; display: boolean }, options?: { triggerTurn?: boolean }) => void;
  on: (event: string, handler: (event: unknown, ctx: { ui: BrowseUi }) => void) => void;
}

/**
 * Truncate a string to fit within maxWidth visible characters.
 * Handles ANSI escape codes gracefully by stripping them for width
 * calculation while preserving ANSI sequences in the output.
 */
function truncateToWidth(text: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return '';
  // Strip ANSI codes for visible-width calculation
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  if (clean.length <= maxWidth) return text;
  // Reserve space for ellipsis so total visible chars fit within maxWidth
  const contentWidth = Math.max(0, maxWidth - ellipsis.length);
  // Walk the original string, counting visible chars and preserving ANSI codes
  let visible = 0;
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\x1b') {
      // Copy the full ANSI sequence
      const m = text.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) { result += m[0]; i += m[0].length; continue; }
    }
    if (visible >= contentWidth) break;
    result += text[i];
    visible++;
    i++;
  }
  result += ellipsis;
  return result;
}

export function formatBrowseOption(item: WorklogBrowseItem, maxWidth?: number): string {
  const idPart = `(${item.id})`;
  const full = `${item.title} ${idPart}`;

  if (!maxWidth || maxWidth <= 0 || full.length <= maxWidth) {
    return full;
  }

  const separatorAndId = ` ${idPart}`;
  if (maxWidth <= separatorAndId.length) {
    return truncateToWidth(idPart, maxWidth);
  }

  const titleWidth = maxWidth - separatorAndId.length;
  const truncatedTitle = truncateToWidth(item.title, titleWidth);
  return `${truncatedTitle}${separatorAndId}`;
}

function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('No JSON object in output');

  let depth = 0;
  for (let i = start; i < raw.length; i += 1) {
    if (raw[i] === '{') depth += 1;
    if (raw[i] === '}') depth -= 1;
    if (depth === 0) {
      return JSON.parse(raw.slice(start, i + 1));
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
): (tui: any, theme: { fg: (color: string, text: string) => string; bold: (text: string) => string }) => {
  render: (width: number) => string[];
  invalidate: () => void;
} {
  return (_tui, theme) => {
    // Debug: write to file
    try {
      const fs = require('fs');
      const debugInfo = {
        timestamp: new Date().toISOString(),
        itemId: item.id,
        stage: item.stage,
        status: item.status,
        themeAvailable: !!theme,
        themeFgType: typeof theme?.fg,
        themeKeys: theme ? Object.keys(theme) : [],
      };
      fs.appendFileSync('/tmp/wl-debug.log', JSON.stringify(debugInfo) + '\n');
    } catch (e) {
      // ignore
    }

    const priority = item.priority ?? '—';
    const stage = item.stage ?? '—';
    const status = item.status ?? '—';
    const risk = item.risk ?? '—';
    const effort = item.effort ?? '—';

    // Apply stage-based colour to the title, with blocked status override
    // Theme is only available in the factory function, not in render()
    let colouredTitle = `${item.title} <${item.id}>`;
    if (theme && typeof theme.fg === 'function') {
      const token = stageColourToken(item.stage);
      colouredTitle = theme.fg(token, colouredTitle);
      
      // Debug: write result
      try {
        const fs = require('fs');
        fs.appendFileSync('/tmp/wl-debug.log', `Applied colour: token=${token}, result=${colouredTitle.substring(0, 60)}...\n`);
      } catch (e) {
        // ignore
      }
    }

    // Pre-build the lines with colours applied
    const lines = [
      colouredTitle,
      `Priority/Stage/Status: ${priority}/${stage}/${status}`,
      `Risk/Effort: ${risk}/${effort}`,
      ...descriptionPreview(item.description, 7),
    ];

    return {
      render: (_width: number) => lines,
      invalidate: () => {
        // no-op: all rendering is derived from local state
      },
    };
  };
}

function truncateLine(line: string, width: number): string {
  if (width <= 0) return '';
  if (line.length <= width) return line;
  return `${line.slice(0, Math.max(0, width - 1))}…`;
}

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

async function defaultChooseWorkItem(
  items: WorklogBrowseItem[],
  ctx: BrowseContext,
  onSelectionChange: SelectionChangeHandler,
): Promise<WorklogBrowseItem | undefined> {
  // Debug: write to file
  try {
    const fs = require('fs');
    fs.appendFileSync('/tmp/wl-debug.log', `[${new Date().toISOString()}] defaultChooseWorkItem called, items: ${items.length}, ctx.ui.custom: ${typeof ctx.ui.custom}, ctx.ui.select: ${typeof ctx.ui.select}\n`);
  } catch (e) {
    // ignore
  }
  if (!ctx.ui.custom) {
    if (!ctx.ui.select) {
      throw new Error('Selection UI is unavailable in this environment.');
    }

    const options = items.map(formatBrowseOption);
    const selected = await ctx.ui.select('Browse Worklog next items (top 5)', options);
    if (!selected) return undefined;

    const selectedIndex = options.indexOf(selected);
    if (selectedIndex < 0) {
      ctx.ui.notify('Invalid selection.', 'warning');
      return undefined;
    }

    const selectedItem = items[selectedIndex];
    // Debug: write to file
    try {
      const fs = require('fs');
      fs.appendFileSync('/tmp/wl-debug.log', `[${new Date().toISOString()}] Calling onSelectionChange (select fallback)\n`);
    } catch (e) {
      // ignore
    }
    onSelectionChange(selectedItem);
    return selectedItem;
  }

  const selectedItem = await ctx.ui.custom<WorklogBrowseItem | null>((tui, theme, _keybindings, done) => {
    let selectedIndex = 0;
    let lastSelectionId = items[0]?.id;

    const moveSelection = (nextIndex: number) => {
      if (nextIndex < 0 || nextIndex >= items.length || nextIndex === selectedIndex) return;
      selectedIndex = nextIndex;
      const item = items[selectedIndex];
      if (item && item.id !== lastSelectionId) {
        lastSelectionId = item.id;
        // Debug: write to file
        try {
          const fs = require('fs');
          fs.appendFileSync('/tmp/wl-debug.log', `[${new Date().toISOString()}] Calling onSelectionChange (moveSelection)\n`);
        } catch (e) {
          // ignore
        }
        onSelectionChange(item);
      }
    };

    return {
      focused: false,
      render: (width: number) => {
        const title = truncateLine(theme.fg('accent', theme.bold('Browse Worklog next items (top 5)')), width);
        const help = truncateLine(theme.fg('dim', '↑↓ navigate • enter select • esc cancel'), width);
        const options = items.map((item, index) => {
          const prefix = index === selectedIndex ? theme.fg('accent', '› ') : '  ';
          const contentWidth = Math.max(0, width - 2);
          const optionLine = `${prefix}${formatBrowseOption(item, contentWidth)}`;
          return truncateLine(optionLine, width);
        });

        return [title, '', ...options, '', help];
      },
      invalidate: () => {
        // no-op: all rendering is derived from local state
      },
      handleInput: (data: string) => {
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

  return selectedItem ?? undefined;
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
  const chooseWorkItem = deps.chooseWorkItem ?? defaultChooseWorkItem;

  return function registerWorklogBrowseExtension(pi: PiLike): void {
    const runBrowseFlow = async (ctx: BrowseContext): Promise<void> => {
      // Debug: write to file
      try {
        const fs = require('fs');
        fs.appendFileSync('/tmp/wl-debug.log', `[${new Date().toISOString()}] runBrowseFlow started\n`);
      } catch (e) {
        // ignore
      }
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
          // Debug: write to file
          try {
            const fs = require('fs');
            fs.appendFileSync('/tmp/wl-debug.log', `[${new Date().toISOString()}] announceSelection called for item: ${item.id}\n`);
          } catch (e) {
            // ignore
          }
          if (item.id === lastAnnouncedId) return;
          lastAnnouncedId = item.id;
          const widgetFactory = buildSelectionWidget(item);
          // Debug: write factory type
          try {
            const fs = require('fs');
            fs.appendFileSync('/tmp/wl-debug.log', `  Widget factory type: ${typeof widgetFactory}\n`);
          } catch (e) {
            // ignore
          }
          ctx.ui.setWidget?.('worklog-browse-selection', widgetFactory, { placement: 'belowEditor' });
        };

        const selectedItem = await chooseWorkItem(items, ctx, announceSelection);
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
          const mdOutput = await runWlImpl(['show', selectedItem.id, '--format', 'markdown'], false);
          // Strip blessed-style markup tags ({tag}) which pi's TUI doesn't understand;
          // these appear as literal text and inflate visible width, causing render errors.
          const cleanOutput = mdOutput.replace(/\{[^}]*\}/g, '');
          const detailLines = cleanOutput.split(/\r?\n/);

          // Wrap the scrollable widget so Escape calls done() to close the modal.
          // The scrollable widget's handleInput calls invalidate(), which in turn
          // calls tui.requestRender() — but we need the wrapper to forward Escape
          // to done() (which closes the custom modal) and to pass through all
          // other keys to the scrollable widget.
          await ctx.ui.custom<string | null>(
            (tui, _theme, _keybindings, done) => {
              const factory = createScrollableWidget(detailLines);
              const widget = factory(tui, _theme);

              return {
                focused: false,
                render: (width: number) => widget.render(width),
                invalidate: () => widget.invalidate(),
                handleInput: (data: string) => {
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
          ).catch(() => {
            // user pressed Escape or closed the modal — this is expected
          });
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
