import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../src/tui/wl-integration.js', () => ({
  runWl: vi.fn(),
  wlEvents: new EventEmitter(),
}));

import { runWl } from '../../src/tui/wl-integration.js';
import { ChatPane } from '../../src/tui/chatPane.js';

const runWlMock = vi.mocked(runWl);

describe('ChatPane wl show rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes wl show and renders details in the chat stream', async () => {
    runWlMock.mockResolvedValue({
      id: 'WL-0MPN6LCLO006N5U8',
      title: 'Example item',
      status: 'open',
      priority: 'high',
      issueType: 'feature',
      stage: 'in_progress',
      assignee: 'pi',
      description: 'Shows detailed item output',
    } as any);

    const pane = new ChatPane();
    const response = await pane.sendMessage('show WL-0MPN6LCLO006N5U8');

    expect(runWlMock).toHaveBeenCalledWith('show', ['WL-0MPN6LCLO006N5U8']);
    expect(response.role).toBe('agent');
    expect(response.content).toContain('**WL-0MPN6LCLO006N5U8: Example item**');
    expect(response.content).toContain('Status: open');

    const history = pane.getMessages();
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('agent');
  });
});
