import { describe, it, expect, vi } from 'vitest';
import { TuiController } from '../../src/tui/controller.js';
import { createTuiTestContext } from '../test-utils.js';

/**
 * Tests for the TUI 'C' key copy-ID-to-clipboard functionality.
 *
 * The copy flow:
 *   screen.key(KEY_COPY_ID) -> copySelectedId() -> copyToClipboard(item.id, { spawn })
 *
 * We inject a mock spawn so we can verify the correct ID is written to stdin
 * of the clipboard helper process (pbcopy / xclip / xsel).
 */
describe('TUI C key copy ID to clipboard', () => {
  /**
   * Helper that creates a mock spawn returning a fake child process.
   * Captures whatever is written to stdin so we can assert on it.
   */
  function createMockSpawn() {
    const written: string[] = [];
    let closeHandler: ((code: number) => void) | null = null;

    const mockSpawn = vi.fn((_cmd: string, _args: any, _opts?: any) => {
      const stdin = {
        write: vi.fn((data: string) => { written.push(data); }),
        end: vi.fn(() => {
          // Simulate successful close after stdin ends
          if (closeHandler) closeHandler(0);
        }),
      };
      const cp: any = {
        stdin,
        on: vi.fn((event: string, handler: any) => {
          if (event === 'close') closeHandler = handler;
          // We don't need to fire 'error' for the success path
        }),
      };
      return cp;
    });

    return { mockSpawn, written };
  }

  it('copies the selected item ID to clipboard on C keypress', async () => {
    const ctx = createTuiTestContext();
    const { mockSpawn, written } = createMockSpawn();

    const controller = new TuiController(ctx as any, {
      blessed: ctx.blessed,
      spawn: mockSpawn as any,
    });

    // Create a sample work item
    const id = ctx.utils.createSampleItem({ tags: [] });

    await controller.start({});

    // Simulate pressing 'C' (the copy ID shortcut)
    ctx.screen.emit('keypress', 'c', { name: 'c' });

    // Allow the async copySelectedId to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    // Verify spawn was called with a clipboard command
    expect(mockSpawn).toHaveBeenCalled();

    // Verify the correct ID was written to stdin
    expect(written.length).toBeGreaterThan(0);
    expect(written[0]).toBe(id);

    // Verify the success toast was shown
    expect(ctx.toast.lastMessage()).toBe('ID copied');
  });

  it('shows error toast when clipboard command fails', async () => {
    const ctx = createTuiTestContext();

    // Create a spawn mock that simulates a failed clipboard command
    let closeHandler: ((code: number) => void) | null = null;
    const failSpawn = vi.fn(() => {
      const cp: any = {
        stdin: {
          write: vi.fn(),
          end: vi.fn(() => {
            if (closeHandler) closeHandler(1); // non-zero exit code
          }),
        },
        on: vi.fn((event: string, handler: any) => {
          if (event === 'close') closeHandler = handler;
        }),
      };
      return cp;
    });

    const controller = new TuiController(ctx as any, {
      blessed: ctx.blessed,
      spawn: failSpawn as any,
    });

    ctx.utils.createSampleItem({ tags: [] });
    await controller.start({});

    ctx.screen.emit('keypress', 'c', { name: 'c' });
    await new Promise(resolve => setTimeout(resolve, 50));

    // Verify the failure toast was shown
    expect(ctx.toast.lastMessage()).toMatch(/Copy failed/);
  });

  it('does nothing when no item is selected', async () => {
    const ctx = createTuiTestContext();
    const { mockSpawn } = createMockSpawn();

    // Override getDatabase to return empty list
    ctx.utils.getDatabase = () => ({
      list: () => [],
      getPrefix: () => undefined,
      getCommentsForWorkItem: () => [],
      update: () => ({}),
      createComment: () => ({}),
      get: () => null,
    });

    const controller = new TuiController(ctx as any, {
      blessed: ctx.blessed,
      spawn: mockSpawn as any,
    });

    // start returns early with 'No work items found' message
    await controller.start({});

    ctx.screen.emit('keypress', 'c', { name: 'c' });
    await new Promise(resolve => setTimeout(resolve, 50));

    // Spawn should not have been called since there's no item to copy
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('does not copy when in move mode', async () => {
    const ctx = createTuiTestContext();
    const { mockSpawn } = createMockSpawn();

    const controller = new TuiController(ctx as any, {
      blessed: ctx.blessed,
      spawn: mockSpawn as any,
    });

    ctx.utils.createSampleItem({ tags: [] });
    await controller.start({});

    // Enter move mode by pressing 'm'
    ctx.screen.emit('keypress', 'm', { name: 'm' });

    // Now press 'C' - should be blocked by move mode guard
    ctx.screen.emit('keypress', 'c', { name: 'c' });
    await new Promise(resolve => setTimeout(resolve, 50));

    // Spawn should not have been called since move mode blocks copy
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
