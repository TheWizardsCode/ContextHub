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

    class FakeOpencodeClient {
      getStatus() { return { status: 'running', port: 9999 }; }
      startServer() { return Promise.resolve(true); }
      stopServer() { return undefined; }
      sendPrompt() { return Promise.resolve(); }
    }

    const writeFileSpy = vi.fn(async (_path: string, _data: string) => undefined);

    const controller = new TuiController(ctx as any, {
      createLayout: () => layout as any,
      OpencodeClient: FakeOpencodeClient as any,
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
});
