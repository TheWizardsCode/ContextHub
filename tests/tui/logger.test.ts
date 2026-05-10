import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { fileLog, setVerbose, flushLogs } from '../../src/tui/logger.js';

describe('tui logger', () => {
  it('buffers logs and flushes them asynchronously to file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-tui-logger-'));
    const logFile = path.join(tmpDir, 'tui.log');
    const prev = process.env.TUI_LOGFILE;

    process.env.TUI_LOGFILE = logFile;
    setVerbose(true);

    fileLog('first event');
    fileLog('second event', { n: 2 });

    await flushLogs();

    const contents = await fs.promises.readFile(logFile, 'utf8');
    expect(contents).toContain('first event');
    expect(contents).toContain('second event');

    setVerbose(false);
    if (prev === undefined) delete process.env.TUI_LOGFILE;
    else process.env.TUI_LOGFILE = prev;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
