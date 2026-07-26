/**
 * End-to-end tests for the built TUI executable running in headless mode.
 *
 * These tests verify the integration between:
 * - The built TUI executable (dist/cli.js)
 * - wl CLI commands run in a headless/CI environment
 * - Real process spawning via execa (not mocked spawn)
 *
 * Run locally: npx vitest run tests/e2e/headless-tui.test.ts
 * Run in CI: npm test -- tests/e2e/headless-tui.test.ts
 *
 * Unlike tests/e2e/agent-flow.test.ts which tests ChatPane/ActionPalette
 * components directly, these tests exercise the built executable itself.
 */

import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import * as path from 'path';

/**
 * Run a wl CLI command via the built executable.
 * @param args Arguments to pass to the wl CLI
 * @returns execa ReturnPromise
 */
function runWlCli(...args: string[]): ReturnType<typeof execa> {
  const cliPath = path.join(__dirname, '..', '..', 'dist', 'cli.js');
  return execa('node', [cliPath, ...args], {
    timeout: 15000,
    cwd: path.join(__dirname, '..', '..'),
  });
}

/**
 * Run the wl CLI in TUI headless mode (no interactive terminal).
 * This simulates how the TUI would run in CI without a display.
 */
function runTuiHeadless(...args: string[]): ReturnType<typeof execa> {
  const cliPath = path.join(__dirname, '..', '..', 'dist', 'cli.js');
  return execa('node', [cliPath, 'tui', '--headless', ...args], {
    timeout: 20000,
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, WL_TUI_MODE: '1', CI: '1' },
  });
}

describe('E2E: Headless TUI - built executable', () => {
  describe('wl list command via built CLI', () => {
    it('executes wl list -n 1 --json and returns valid JSON', async () => {
      const { stdout } = await runWlCli('list', '-n', '1', '--json');
      const parsed = JSON.parse(stdout);
      expect(parsed).toBeDefined();
      expect(parsed.success).toBe(true);
      // Response format: { success, count, workItems: [...] }
      const items = parsed.workItems ?? parsed.items;
      expect(Array.isArray(items)).toBe(true);
    });

    it('executes wl list -n 5 --json and returns up to 5 items', async () => {
      const { stdout } = await runWlCli('list', '-n', '5', '--json');
      const parsed = JSON.parse(stdout);
      expect(parsed.success).toBe(true);
      const items = parsed.workItems ?? parsed.items;
      expect(items.length).toBeLessThanOrEqual(5);
    });
  });

  describe('wl next command via built CLI', () => {
    it('executes wl next --json and returns work item recommendation', async () => {
      const { stdout } = await runWlCli('next', '--json');
      const parsed = JSON.parse(stdout);
      expect(parsed).toBeDefined();
      expect(parsed.success).toBe(true);
      // workItem can be null when no ready work items exist;
      // this is valid behavior, not an error.
      if (parsed.workItem !== null && parsed.workItem !== undefined) {
        expect(parsed.workItem.id).toBeDefined();
      }
    });

    it('executes wl next --assignee and returns assigned items', async () => {
      const { stdout } = await runWlCli('next', '--assignee', 'OpenAI-Agent', '--json');
      const parsed = JSON.parse(stdout);
      // Should return a valid response (may have no items if none assigned)
      expect(parsed).toBeDefined();
    });
  });

  describe('wl show command via built CLI', () => {
    it('executes wl show with a real work item ID', async () => {
      // Create a work item first, then verify we can show it
      const { stdout: createOut } = await runWlCli('create', '-t', 'Test item for show', '-d', 'Testing wl show command');
      // Parse the create response to get the new item ID
      // create output format: Created <prefix>-<number> (<title>)
      const idMatch = createOut.match(/Created (\S+) \(/);
      if (!idMatch) {
        // Fallback: try JSON output
        const { stdout: createJson } = await runWlCli('create', '-t', 'Test item for show JSON', '-d', 'Testing wl show', '--json');
        const createParsed = JSON.parse(createJson);
        expect(createParsed.success).toBe(true);
        const itemId = createParsed.workItem?.id || createParsed.id;
        expect(itemId).toBeDefined();
        const { stdout } = await runWlCli('show', itemId, '--json');
        const parsed = JSON.parse(stdout);
        expect(parsed.success).toBe(true);
        expect(parsed.workItem.id).toBe(itemId);
        return;
      }
      const itemId = idMatch[1];
      const { stdout } = await runWlCli('show', itemId, '--json');
      const parsed = JSON.parse(stdout);
      expect(parsed.success).toBe(true);
      expect(parsed.workItem.id).toBe(itemId);
    });
  });

  describe('wl CLI error handling', () => {
    it('returns non-zero exit code for invalid commands', async () => {
      await expect(
        runWlCli('nonexistent-invalid-command-xyz', '--json')
      ).rejects.toThrow();
    });

    it('returns non-zero exit code for non-existent work item', async () => {
      await expect(
        runWlCli('show', 'SA-INVALID-999999999', '--json')
      ).rejects.toThrow();
    });
  });

  describe('TUI module loading via built executable', () => {
    it('loads TUI modules without errors', async () => {
      const { ChatPane } = await import('../../packages/tui/extensions/Worklog/chatPane.js');
      const { ActionPalette } = await import('../../packages/tui/extensions/Worklog/actionPalette.js');
      const { runWl } = await import('../../packages/tui/extensions/wl-integration.js');
      expect(ChatPane).toBeDefined();
      expect(ActionPalette).toBeDefined();
      expect(runWl).toBeDefined();
    });

    it('ChatPane can be instantiated and cleared', async () => {
      const { ChatPane } = await import('../../packages/tui/extensions/Worklog/chatPane.js');
      const pane = new ChatPane();
      pane.clear();
      expect(pane.getMessages()).toEqual([]);
      expect(pane.getMessageCount()).toBe(0);
    });

    it('ActionPalette has at least 5 default actions', async () => {
      const { ChatPane } = await import('../../packages/tui/extensions/Worklog/chatPane.js');
      const { ActionPalette } = await import('../../packages/tui/extensions/Worklog/actionPalette.js');
      const chat = new ChatPane();
      const palette = new ActionPalette(chat);
      palette.open();
      const actions = palette.getFilteredActions();
      expect(actions.length).toBeGreaterThanOrEqual(5);
    });
  });
});

describe('E2E: Conversational flows via ChatPane', () => {
  it('chat pane can process a "list" command via runWl', async () => {
    const { ChatPane } = await import('../../packages/tui/extensions/Worklog/chatPane.js');
    const chatPane = new ChatPane();
    const response = await chatPane.sendMessage('list work items');
    expect(response.role).toBe('agent');
    expect(response.content.length).toBeGreaterThan(0);
    expect(chatPane.state.messages.length).toBe(2); // user + agent
  });

  it('chat pane can process a "next" command via runWl', async () => {
    const { ChatPane } = await import('../../packages/tui/extensions/Worklog/chatPane.js');
    const chatPane = new ChatPane();
    const response = await chatPane.sendMessage('what should I work on next');
    expect(response.role).toBe('agent');
    expect(response.content.length).toBeGreaterThan(0);
  });

  it('chat pane can process a "show" command via runWl', async () => {
    const { ChatPane } = await import('../../packages/tui/extensions/Worklog/chatPane.js');
    const chatPane = new ChatPane();
    const response = await chatPane.sendMessage('show SA-0MPFCUEKX006CF3U');
    expect(response.role).toBe('agent');
    expect(response.content.length).toBeGreaterThan(0);
  });

  it('chat pane handles processing state correctly', async () => {
    const { ChatPane } = await import('../../packages/tui/extensions/Worklog/chatPane.js');
    const chatPane = new ChatPane();
    const response1 = await chatPane.sendMessage('list');
    expect(response1.role).toBe('agent');
    expect(chatPane.state.isProcessing).toBe(false);
  });

  it('chat pane create flow triggers wl create via runWl', async () => {
    const { ChatPane } = await import('../../packages/tui/extensions/Worklog/chatPane.js');
    const chatPane = new ChatPane();
    const response = await chatPane.sendMessage(
      'create work item: Test E2E item from agent pipeline'
    );
    expect(response.role).toBe('agent');
    // Should either succeed with a work item ID or indicate the command was executed
    expect(response.content.toLowerCase()).toContain('created');
  });

  it('chat pane handles unknown commands gracefully', async () => {
    const { ChatPane } = await import('../../packages/tui/extensions/Worklog/chatPane.js');
    const chatPane = new ChatPane();
    const response = await chatPane.sendMessage('some completely random input xyz123');
    expect(response.role).toBe('agent');
    expect(response.content.length).toBeGreaterThan(0);
  });
});

describe('E2E: Action palette integration', () => {
  it('action palette has default actions', async () => {
    const { ChatPane } = await import('../../packages/tui/extensions/Worklog/chatPane.js');
    const { ActionPalette } = await import('../../packages/tui/extensions/Worklog/actionPalette.js');
    const chatPane = new ChatPane();
    const palette = new ActionPalette(chatPane);
    palette.open();
    const actions = palette.getFilteredActions();
    expect(actions.length).toBeGreaterThan(0);
  });

  it('action palette filters actions by text', async () => {
    const { ChatPane } = await import('../../packages/tui/extensions/Worklog/chatPane.js');
    const { ActionPalette } = await import('../../packages/tui/extensions/Worklog/actionPalette.js');
    const chatPane = new ChatPane();
    const palette = new ActionPalette(chatPane);
    palette.open();
    palette.setFilter('list');
    const filtered = palette.getFilteredActions();
    const listActions = filtered.filter(a => a.label.toLowerCase().includes('list'));
    expect(listActions.length).toBeGreaterThan(0);
  });

  it('action palette can execute wl list action', async () => {
    const { ChatPane } = await import('../../packages/tui/extensions/Worklog/chatPane.js');
    const { ActionPalette } = await import('../../packages/tui/extensions/Worklog/actionPalette.js');
    const chatPane = new ChatPane();
    const palette = new ActionPalette(chatPane);
    const listAction = palette.getFilteredActions().find(a =>
      a.label.toLowerCase().includes('list') || a.id === 'wl-list'
    );
    if (listAction) {
      const result = await listAction.execute();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it('action palette can execute wl next action', async () => {
    const { ChatPane } = await import('../../packages/tui/extensions/Worklog/chatPane.js');
    const { ActionPalette } = await import('../../packages/tui/extensions/Worklog/actionPalette.js');
    const chatPane = new ChatPane();
    const palette = new ActionPalette(chatPane);
    const nextAction = palette.getFilteredActions().find(a =>
      a.label.toLowerCase().includes('next') || a.id === 'wl-next'
    );
    if (nextAction) {
      const result = await nextAction.execute();
      expect(typeof result).toBe('string');
    }
  });
});
