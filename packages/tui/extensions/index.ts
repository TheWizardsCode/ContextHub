import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorklogBrowseItem {
  id: string;
  title: string;
  status: string;
}

interface WorklogBrowseDependencies {
  listWorkItems?: () => Promise<WorklogBrowseItem[]>;
  showWorkItem?: (id: string) => Promise<string>;
}

interface BrowseUi {
  select: (title: string, options: string[]) => Promise<string | undefined>;
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

export function formatBrowseOption(item: WorklogBrowseItem): string {
  return `${item.id} — ${item.title} [${item.status}]`;
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
  const itemList = Array.isArray(payload)
    ? payload
    : (payload && typeof payload === 'object' && Array.isArray((payload as any).workItems)
      ? (payload as any).workItems
      : []);

  return itemList
    .map((item: any) => ({
      id: String(item?.id ?? ''),
      title: String(item?.title ?? 'Untitled'),
      status: String(item?.status ?? 'unknown'),
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

async function defaultListWorkItems(): Promise<WorklogBrowseItem[]> {
  const output = await runWl(['list', '-n', '5']);
  const payload = extractJsonObject(output);
  return normalizeListPayload(payload).slice(0, 5);
}

async function defaultShowWorkItem(id: string): Promise<string> {
  const output = await runWl(['show', id], false);
  return output.trim();
}

function buildShowMessage(id: string, showOutput: string): string {
  return `wl show ${id}\n\n${showOutput}`;
}

export function createWorklogBrowseExtension(deps: WorklogBrowseDependencies = {}) {
  const listWorkItems = deps.listWorkItems ?? defaultListWorkItems;
  const showWorkItem = deps.showWorkItem ?? defaultShowWorkItem;

  return function registerWorklogBrowseExtension(pi: PiLike): void {
    const runBrowseFlow = async (ctx: BrowseContext): Promise<void> => {
      try {
        const items = (await listWorkItems()).slice(0, 5);
        if (items.length === 0) {
          ctx.ui.notify('No work items available to browse.', 'info');
          return;
        }

        const options = items.map(formatBrowseOption);
        const selected = await ctx.ui.select('Browse Worklog items (first 5)', options);
        if (!selected) return;

        const selectedIndex = options.indexOf(selected);
        if (selectedIndex < 0) {
          ctx.ui.notify('Invalid selection.', 'warning');
          return;
        }

        const selectedItem = items[selectedIndex];
        const showOutput = await showWorkItem(selectedItem.id);

        pi.sendMessage(
          {
            customType: 'worklog-browse',
            content: buildShowMessage(selectedItem.id, showOutput),
            display: true,
          },
          { triggerTurn: false },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to browse work items: ${message}`, 'error');
      }
    };

    pi.registerCommand('wl-browse', {
      description: 'Browse first 5 work items and open wl show details in chat',
      handler: async (_args: string, ctx: BrowseContext) => {
        await runBrowseFlow(ctx);
      },
    });

    pi.registerShortcut('ctrl+shift+b', {
      description: 'Browse first 5 work items (avoids built-in Ctrl+B cursor-left conflict)',
      handler: async (ctx: BrowseContext) => {
        await runBrowseFlow(ctx);
      },
    });
  };
}

export default createWorklogBrowseExtension();
