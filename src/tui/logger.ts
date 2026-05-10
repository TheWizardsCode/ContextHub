import fs from 'fs';
import path from 'path';

// Controlled logging facade for the TUI. By default file logging is disabled
// and must be enabled via setVerbose(true) or the TUI_LOG_VERBOSE env var.
let enabled = Boolean(process.env.TUI_LOG_VERBOSE);
let queue: string[] = [];
let flushing = false;
let flushPromise: Promise<void> | null = null;
const MAX_QUEUE = 5000;

const getLogFilePath = (): string => process.env.TUI_LOGFILE || path.join(process.cwd(), 'tui-prototype.log');

async function flushQueue(): Promise<void> {
  if (flushing) return;
  if (queue.length === 0) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      const batch = queue.splice(0, 200).join('');
      await fs.promises.appendFile(getLogFilePath(), batch);
    }
  } catch (_) {
    // Swallow any write errors — logging must not crash the TUI.
  } finally {
    flushing = false;
    flushPromise = null;
    if (queue.length > 0) {
      flushPromise = flushQueue();
    }
  }
}

export function setVerbose(v: boolean) {
  enabled = Boolean(v);
}

export function fileLog(...parts: any[]): void {
  if (!enabled) return;
  try {
    const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
    queue.push(line);
    if (queue.length > MAX_QUEUE) {
      const dropped = queue.length - MAX_QUEUE;
      queue = queue.slice(-MAX_QUEUE);
      queue.unshift(`[${new Date().toISOString()}] [logger] dropped ${dropped} queued log lines to bound memory\n`);
    }
    if (!flushPromise) {
      flushPromise = flushQueue();
    }
  } catch (_) {
    // swallow any errors — logging must not crash the TUI
  }
}

export async function flushLogs(): Promise<void> {
  if (!flushPromise && queue.length > 0) {
    flushPromise = flushQueue();
  }
  if (flushPromise) {
    await flushPromise;
  }
  if (queue.length > 0) {
    await flushLogs();
  }
}

export default { setVerbose, fileLog, flushLogs };
