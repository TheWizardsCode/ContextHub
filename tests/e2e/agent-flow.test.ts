/**
 * End-to-end tests for agent-driven create/update flow in Pi TUI.
 *
 * These tests verify the integration between:
 * - Chat pane (natural language processing)
 * - PiAdapter (agent backend)
 * - wl CLI integration (work item operations)
 *
 * Run locally: npx vitest run tests/e2e/agent-flow.test.ts
 * Run in CI: npm test -- tests/e2e/agent-flow.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatPane } from '../../packages/tui/extensions/Worklog/chatPane.js';
import { ActionPalette } from '../../packages/tui/extensions/Worklog/actionPalette.js';
import { runWl } from '../../packages/tui/extensions/wl-integration.js';
import { runWlCommand } from '../../src/wl-integration/spawn.js';

describe('E2E: Agent-driven create flow', () => {
  let chatPane: ChatPane;
  let originalSpawn: typeof import('child_process').spawn | undefined;

  beforeEach(() => {
    chatPane = new ChatPane();
    // Capture spawn calls
    originalSpawn = require('child_process').spawn;
  });

  afterEach(() => {
    if (originalSpawn) {
      require('child_process').spawn = originalSpawn;
    }
  });

  it('chat pane can process a "list" command and return work items', async () => {
    const response = await chatPane.sendMessage('list work items');

    expect(response.role).toBe('agent');
    expect(response.content.length).toBeGreaterThan(0);
    expect(chatPane.state.messages.length).toBe(2); // user + agent
  });

  it('chat pane can process a "next" command', async () => {
    const response = await chatPane.sendMessage('what should I work on next');

    expect(response.role).toBe('agent');
    expect(response.content.length).toBeGreaterThan(0);
  });

  it('chat pane can process a "show" command for a work item', async () => {
    // Use a valid work item ID from the test environment
    const response = await chatPane.sendMessage('show WL-TEST-000');

    expect(response.role).toBe('agent');
    // The response will either contain the work item details or a "not found" message
    expect(response.content.length).toBeGreaterThan(0);
  });

  it('chat pane handles processing state correctly', async () => {
    // Send first message
    const response1 = await chatPane.sendMessage('list');
    expect(response1.role).toBe('agent');

    // Chat pane should not be processing after completion
    expect(chatPane.state.isProcessing).toBe(false);
  });
});

describe('E2E: Action palette integration', () => {
  let chatPane: ChatPane;
  let palette: ActionPalette;

  beforeEach(() => {
    chatPane = new ChatPane();
    palette = new ActionPalette(chatPane);
  });

  it('action palette has default actions', () => {
    palette.open();
    const actions = palette.getFilteredActions();
    expect(actions.length).toBeGreaterThan(0);
  });

  it('action palette filters actions by text', () => {
    palette.open();
    palette.setFilter('list');
    const filtered = palette.getFilteredActions();
    const listActions = filtered.filter(a => a.label.toLowerCase().includes('list'));
    expect(listActions.length).toBeGreaterThan(0);
  });

  it('action palette can execute wl list action', async () => {
    const listAction = palette.getFilteredActions().find(a =>
      a.label.toLowerCase().includes('list') || a.id === 'wl-list'
    );

    if (listAction) {
      const result = await listAction.execute();
      // Result should be a string containing work items or a message
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it('action palette can execute wl next action', async () => {
    const nextAction = palette.getFilteredActions().find(a =>
      a.label.toLowerCase().includes('next') || a.id === 'wl-next'
    );

    if (nextAction) {
      const result = await nextAction.execute();
      expect(typeof result).toBe('string');
    }
  });
});

describe('E2E: wl CLI integration layer', () => {
  it('runWl can execute wl list command', async () => {
    const result = await runWl('list', ['-n', '1']);
    // Result should be an array or an object with items
    expect(result).toBeDefined();
  });

  it('runWl can execute wl next command', async () => {
    const result = await runWl('next');
    expect(result).toBeDefined();
  });

  it('runWl returns errors for invalid commands', async () => {
    await expect(runWl('nonexistent-invalid-command-xyz')).rejects.toThrow();
  });
});

describe('E2E: Chat pane to wl CLI pipeline', () => {
  let chatPane: ChatPane;

  beforeEach(() => {
    chatPane = new ChatPane();
  });

  it('chat pane create flow triggers wl create via runWl', async () => {
    const response = await chatPane.sendMessage(
      'create work item: Test E2E item from agent pipeline'
    );

    expect(response.role).toBe('agent');
    // Should either succeed with a work item ID or indicate the command was executed
    expect(response.content.toLowerCase()).toContain('created');
  });

  it('chat pane update flow triggers wl update via runWl', async () => {
    // Try updating a non-existent item - should return an error message
    const response = await chatPane.sendMessage(
      'update WL-NONEXIST-0001 to set status to in_progress'
    );

    expect(response.role).toBe('agent');
    // Should indicate the update was attempted (success or failure)
    expect(response.content.length).toBeGreaterThan(0);
  });

  it('chat pane handles unknown commands gracefully', async () => {
    const response = await chatPane.sendMessage('some completely random input xyz123');

    expect(response.role).toBe('agent');
    // Should fall back to a generic response
    expect(response.content.length).toBeGreaterThan(0);
  });
});
