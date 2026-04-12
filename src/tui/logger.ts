import fs from 'fs';
import path from 'path';

// Controlled logging facade for the TUI. By default file logging is disabled
// and must be enabled via setVerbose(true) or the TUI_LOG_VERBOSE env var.
let enabled = Boolean(process.env.TUI_LOG_VERBOSE);

export function setVerbose(v: boolean) {
  enabled = Boolean(v);
}

export function fileLog(...parts: any[]): void {
  if (!enabled) return;
  try {
    const file = process.env.TUI_LOGFILE || path.join(process.cwd(), 'tui-prototype.log');
    const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
    // Use appendFileSync to avoid racey ordering between rapid logs in tests.
    try { fs.appendFileSync(file, line); } catch (err) { /* ignore logging errors */ }
  } catch (_) {
    // swallow any errors — logging must not crash the TUI
  }
}

export default { setVerbose, fileLog };
