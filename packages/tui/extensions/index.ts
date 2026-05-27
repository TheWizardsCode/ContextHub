import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  setWidget?: (id: string, content?: string[]) => void;
  notify: (message: string, level?: 'info' | 'warning' | 'error') => void;
}

interface BrowseContext {
  ui: BrowseUi;
}

interface PiLike {
  registerCommand: (name: string, command: { description: string; handler: (args: string, ctx: BrowseContext) => Promise<void> }) => void;
  registerShortcut: (shortcut: string, shortcutDef: { description: string; handler: (ctx: BrowseContext) => Promise<void> }) => void;
  sendMessage: (message: { customType: string; content: string; display: boolean }, options?: { triggerTurn?: boolean }) => void;
}

export function formatBrowseOption(item: WorklogBrowseItem, maxWidth?: number): string {
  const idPart = `(${item.id})`;
  const full = `${item.title} ${idPart}`;

  if (!maxWidth || maxWidth <= 0 || full.length <= maxWidth) {
    return full;
  }

  const separatorAndId = ` ${idPart}`;
  if (maxWidth <= separatorAndId.length) {
    return truncateLine(idPart, maxWidth);
  }

  const titleWidth = maxWidth - separatorAndId.length;
  const truncatedTitle = truncateLine(item.title, titleWidth);
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

function buildSelectionWidget(item: WorklogBrowseItem): string[] {
  const priority = item.priority ?? '—';
  const stage = item.stage ?? '—';
  const status = item.status ?? '—';
  const risk = item.risk ?? '—';
  const effort = item.effort ?? '—';

  return [
    `${item.title} <${item.id}>`,
    `Priority/Stage/Status: ${priority}/${stage}/${status}`,
    `Risk/Effort: ${risk}/${effort}`,
    ...descriptionPreview(item.description, 7),
  ];
}

function truncateLine(line: string, width: number): string {
  if (width <= 0) return '';
  if (line.length <= width) return line;
  return `${line.slice(0, Math.max(0, width - 1))}…`;
}

function isUpKey(data: string): boolean {
  return data === '\u001b[A' || data === 'up';
}

function isDownKey(data: string): boolean {
  return data === '\u001b[B' || data === 'down';
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
        onSelectionChange(item);
      }
    };

    return {
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

export function createWorklogBrowseExtension(deps: WorklogBrowseDependencies = {}) {
  const runWlImpl = deps.runWl ?? runWl;
  const listWorkItems = deps.listWorkItems ?? (() => defaultListWorkItems(runWlImpl));
  const chooseWorkItem = deps.chooseWorkItem ?? defaultChooseWorkItem;

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
        const announceSelection = (item: WorklogBrowseItem) => {
          if (item.id === lastAnnouncedId) return;
          lastAnnouncedId = item.id;
          ctx.ui.setWidget?.('worklog-browse-selection', buildSelectionWidget(item));
        };

        const selectedItem = await chooseWorkItem(items, ctx, announceSelection);
        if (!selectedItem) {
          // user cancelled selection; clear preview widget
          ctx.ui.setWidget?.('worklog-browse-selection', undefined);
          return;
        }

        // Ensure the final selection is announced (in case chooseWorkItem didn't emit it)
        announceSelection(selectedItem);

        // On Enter: fetch full markdown and render it into the above-editor widget. Do not render
        // error text into the widget; show a notification on failure instead and keep the preview.
        try {
          const mdOutput = await runWlImpl(['show', selectedItem.id, '--format', 'markdown'], false);
          const lines = mdOutput.split(/\r?\n/);
          ctx.ui.setWidget?.('worklog-browse-selection', lines);
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
  };
}

export default createWorklogBrowseExtension();
