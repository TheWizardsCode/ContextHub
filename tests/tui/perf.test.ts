import fs from 'fs';
import { describe, it, expect, vi } from 'vitest';
import { TuiController } from '../../src/tui/controller.js';
import { createTuiTestContext, createTempDir, cleanupTempDir } from '../test-utils';

describe('TUI performance instrumentation', () => {
  it('emits start/end timestamps on expand/collapse and writes metrics file when --perf enabled', async () => {
    const tmp = createTempDir();
    const ctx = createTuiTestContext();

    // Create a parent + child so expand/collapse is a real toggle (non-noop)
    const parentId = ctx.utils.createSampleItem();
    const childId = ctx.utils.createSampleItem();
    ctx.utils.db.update(childId, { parentId });

    const layout = ctx.createLayout();

    class FakePiAdapter {
      getStatus() { return { status: 'running', port: 9999 }; }
      startServer() { return Promise.resolve(true); }
      stopServer() { return undefined; }
      sendPrompt() { return Promise.resolve(); }
    }

    const writeFileSpy = vi.fn(async (_path: string, _data: string) => undefined);

    const controller = new TuiController(ctx as any, {
      createLayout: () => layout as any,
      PiAdapter: FakePiAdapter as any,
      resolveWorklogDir: () => tmp,
      createPersistence: () => ({ loadPersistedState: async () => null, savePersistedState: async () => undefined, statePath: `${tmp}/tui-state.json` }),
      fs: { promises: { writeFile: writeFileSpy } } as any,
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await controller.start({ perf: true });

    // Simulate pressing Space (toggle expand/collapse)
    ctx.screen.emit('keypress', ' ', { name: 'space' });

    // Simulate quitting to trigger shutdown and perf file write
    ctx.screen.emit('keypress', 'q', { name: 'q' });

    // Allow async writeFile IIFE to run
    await new Promise((r) => setTimeout(r, 0));

    // Expect debug output to include start and end timestamps
    const calls = errSpy.mock.calls.map(c => String(c[0] || ''));
    const perfLine = calls.find(s => s.includes('start=') && s.includes('end='));
    expect(perfLine, `expected console.error to contain start= and end=, saw: ${calls.join('\n')}`).toBeTruthy();

    // Expect perf metrics file write to have been attempted and include expand_toggle
    expect(writeFileSpy).toHaveBeenCalled();
    const dataArg = writeFileSpy.mock.calls[0][1] as string;
    const parsed = JSON.parse(dataArg);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((e: any) => e && (e.event === 'expand_toggle' || e.event === 'expand_toggle_noop'))).toBe(true);

    errSpy.mockRestore();
    cleanupTempDir(tmp);
  });

  it('writes keypress diagnostics JSONL when profiling is enabled', async () => {
    const tmp = createTempDir();
    const ctx = createTuiTestContext();
    ctx.utils.createSampleItem();
    const layout = ctx.createLayout();

    class FakePiAdapter {
      getStatus() { return { status: 'running', port: 9999 }; }
      startServer() { return Promise.resolve(true); }
      stopServer() { return undefined; }
      sendPrompt() { return Promise.resolve(); }
    }

    const writeFileSpy = vi.fn(async (_path: string, _data: string) => undefined);

    const controller = new TuiController(ctx as any, {
      createLayout: () => layout as any,
      PiAdapter: FakePiAdapter as any,
      resolveWorklogDir: () => tmp,
      createPersistence: () => ({ loadPersistedState: async () => null, savePersistedState: async () => undefined, statePath: `${tmp}/tui-state.json` }),
      fs: { promises: { writeFile: writeFileSpy } } as any,
    });

    await controller.start({ perf: true });

    ctx.screen.emit('keypress', 'j', { name: 'j' });
    ctx.screen.emit('keypress', 'q', { name: 'q' });

    await new Promise((r) => setTimeout(r, 0));

    expect(writeFileSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const profilingCall = writeFileSpy.mock.calls.find(([filePath]) => String(filePath).includes('tui-profiling-'));
    expect(profilingCall).toBeTruthy();

    const diagnosticsPayload = String(profilingCall?.[1] || '');
    const hasKeypress = diagnosticsPayload
      .split('\n')
      .filter(Boolean)
      .some((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed?.event === 'keypress';
        } catch {
          return false;
        }
      });

    expect(hasKeypress).toBe(true);

    cleanupTempDir(tmp);
  });

  it('does not emit verbose TUI debug log file in perf mode unless TUI_LOG_VERBOSE=1', async () => {
    const tmp = createTempDir();
    const ctx = createTuiTestContext();
    ctx.utils.createSampleItem();
    const layout = ctx.createLayout();

    class FakePiAdapter {
      getStatus() { return { status: 'running', port: 9999 }; }
      startServer() { return Promise.resolve(true); }
      stopServer() { return undefined; }
      sendPrompt() { return Promise.resolve(); }
    }

    const prevLogFile = process.env.TUI_LOGFILE;
    const prevLogVerbose = process.env.TUI_LOG_VERBOSE;
    const logFile = `${tmp}/tui-debug.log`;
    process.env.TUI_LOGFILE = logFile;
    delete process.env.TUI_LOG_VERBOSE;

    const controller = new TuiController(ctx as any, {
      createLayout: () => layout as any,
      PiAdapter: FakePiAdapter as any,
      resolveWorklogDir: () => tmp,
      createPersistence: () => ({ loadPersistedState: async () => null, savePersistedState: async () => undefined, statePath: `${tmp}/tui-state.json` }),
    });

    await controller.start({ perf: true });
    ctx.screen.emit('keypress', 'q', { name: 'q' });
    await new Promise((r) => setTimeout(r, 0));

    expect(fs.existsSync(logFile)).toBe(false);

    if (prevLogFile === undefined) delete process.env.TUI_LOGFILE;
    else process.env.TUI_LOGFILE = prevLogFile;
    if (prevLogVerbose === undefined) delete process.env.TUI_LOG_VERBOSE;
    else process.env.TUI_LOG_VERBOSE = prevLogVerbose;

    cleanupTempDir(tmp);
  });
});
