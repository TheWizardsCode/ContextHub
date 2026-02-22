import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OpencodeClientOptions, OpencodeSseHandlers } from '../src/tui/opencode-client.js';

/**
 * Tests for OpencodeClient.handleSseEvent — verifies that SSE events are
 * filtered by session ID and that session termination is triggered by the
 * correct events only (message.finish / session.status idle), NOT by
 * message.updated with time.completed.
 *
 * Covers bug WL-0MLX62TQH1PTRA4R where the TUI showed tool/step placeholders
 * but no agent text because message.updated prematurely closed the SSE stream.
 */

// Dynamically import the class to avoid mocking issues with child_process / http
let OpencodeClient: any;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import('../src/tui/opencode-client.js');
  OpencodeClient = mod.OpencodeClient;
});

function createClient(): any {
  const opts: OpencodeClientOptions = {
    port: 9999,
    log: vi.fn(),
    showToast: vi.fn(),
    modalDialogs: {
      selectList: vi.fn(),
      editTextarea: vi.fn(),
      confirmTextbox: vi.fn(),
    },
    render: vi.fn(),
    persistedState: {
      load: vi.fn().mockResolvedValue({}),
      save: vi.fn().mockResolvedValue(undefined),
    },
  };
  return new OpencodeClient(opts);
}

function createHandlers(): OpencodeSseHandlers & { calls: Record<string, any[]> } {
  const calls: Record<string, any[]> = {};
  const track = (name: string) => (...args: any[]) => {
    if (!calls[name]) calls[name] = [];
    calls[name].push(args);
  };
  return {
    onTextDelta: track('onTextDelta'),
    onTextReset: track('onTextReset'),
    onToolUse: track('onToolUse'),
    onToolResult: track('onToolResult'),
    onPermissionRequest: track('onPermissionRequest'),
    onQuestionAsked: track('onQuestionAsked'),
    onInputRequest: track('onInputRequest'),
    onSessionEnd: track('onSessionEnd'),
    calls,
  };
}

function makeParams(overrides?: Record<string, any>) {
  const handlers = createHandlers();
  const defaults = {
    sessionId: 'session-123',
    partTextById: new Map<string, string>(),
    messageRoleById: new Map<string, string>(),
    lastUserMessageId: null as string | null,
    prompt: 'test prompt',
    handlers,
    setLastUserMessageId: vi.fn(),
    waitingForInput: false,
    setWaitingForInput: vi.fn(),
  };
  return { ...defaults, ...overrides, handlers: overrides?.handlers ?? handlers };
}

describe('handleSseEvent', () => {
  describe('message.updated', () => {
    it('ignores message.updated from a different session', () => {
      const client = createClient();
      const params = makeParams({ sessionId: 'session-123' });

      (client as any).handleSseEvent({
        ...params,
        data: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'msg-1',
              role: 'assistant',
              sessionID: 'other-session',
              time: { completed: '2026-01-01T00:00:00Z' },
            },
          },
        },
      });

      // Role should NOT be tracked for a different session
      expect(params.messageRoleById.get('msg-1')).toBeUndefined();
      // Session end should NOT be triggered
      expect(params.handlers.calls['onSessionEnd']).toBeUndefined();
    });

    it('tracks role for message.updated from the matching session', () => {
      const client = createClient();
      const params = makeParams({ sessionId: 'session-123' });

      (client as any).handleSseEvent({
        ...params,
        data: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'msg-1',
              role: 'assistant',
              sessionID: 'session-123',
              time: { completed: '2026-01-01T00:00:00Z' },
            },
          },
        },
      });

      expect(params.messageRoleById.get('msg-1')).toBe('assistant');
    });

    it('does NOT call onSessionEnd when assistant message.updated has time.completed', () => {
      const client = createClient();
      const params = makeParams({ sessionId: 'session-123' });

      (client as any).handleSseEvent({
        ...params,
        data: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'msg-1',
              role: 'assistant',
              sessionID: 'session-123',
              time: { completed: '2026-01-01T00:00:00Z' },
            },
          },
        },
      });

      // This is the key fix — onSessionEnd must NOT fire here
      expect(params.handlers.calls['onSessionEnd']).toBeUndefined();
    });

    it('tracks user message ID on message.updated with role=user', () => {
      const client = createClient();
      const params = makeParams({ sessionId: 'session-123' });

      (client as any).handleSseEvent({
        ...params,
        data: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'msg-user-1',
              role: 'user',
              sessionID: 'session-123',
            },
          },
        },
      });

      expect(params.messageRoleById.get('msg-user-1')).toBe('user');
      expect(params.setLastUserMessageId).toHaveBeenCalledWith('msg-user-1');
    });

    it('allows message.updated without a session ID (backwards compat)', () => {
      const client = createClient();
      const params = makeParams({ sessionId: 'session-123' });

      // Event with no sessionID at all — should still be processed for
      // backwards compatibility (we only skip events with a DIFFERENT session)
      (client as any).handleSseEvent({
        ...params,
        data: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'msg-2',
              role: 'assistant',
            },
          },
        },
      });

      expect(params.messageRoleById.get('msg-2')).toBe('assistant');
    });
  });

  describe('message.finish', () => {
    it('triggers onSessionEnd for matching session', () => {
      const client = createClient();
      const params = makeParams({ sessionId: 'session-123' });

      (client as any).handleSseEvent({
        ...params,
        data: {
          type: 'message.finish',
          properties: { sessionID: 'session-123' },
        },
      });

      expect(params.handlers.calls['onSessionEnd']?.length).toBe(1);
    });

    it('does NOT trigger onSessionEnd for different session', () => {
      const client = createClient();
      const params = makeParams({ sessionId: 'session-123' });

      (client as any).handleSseEvent({
        ...params,
        data: {
          type: 'message.finish',
          properties: { sessionID: 'other-session' },
        },
      });

      expect(params.handlers.calls['onSessionEnd']).toBeUndefined();
    });
  });

  describe('session.status', () => {
    it('triggers onSessionEnd when session becomes idle', () => {
      const client = createClient();
      const params = makeParams({ sessionId: 'session-123' });

      (client as any).handleSseEvent({
        ...params,
        data: {
          type: 'session.status',
          properties: {
            sessionID: 'session-123',
            status: { type: 'idle' },
          },
        },
      });

      expect(params.handlers.calls['onSessionEnd']?.length).toBe(1);
    });

    it('does NOT trigger onSessionEnd for different session', () => {
      const client = createClient();
      const params = makeParams({ sessionId: 'session-123' });

      (client as any).handleSseEvent({
        ...params,
        data: {
          type: 'session.status',
          properties: {
            sessionID: 'other-session',
            status: { type: 'idle' },
          },
        },
      });

      expect(params.handlers.calls['onSessionEnd']).toBeUndefined();
    });
  });

  describe('message.part text delivery', () => {
    it('delivers text delta for matching session', () => {
      const client = createClient();
      const params = makeParams({ sessionId: 'session-123' });

      (client as any).handleSseEvent({
        ...params,
        data: {
          type: 'message.part',
          properties: {
            sessionID: 'session-123',
            part: {
              id: 'part-1',
              messageID: 'msg-1',
              type: 'text',
              text: 'Hello world',
              sessionID: 'session-123',
            },
          },
        },
      });

      expect(params.handlers.calls['onTextDelta']?.length).toBe(1);
      expect(params.handlers.calls['onTextDelta'][0][0]).toBe('Hello world');
    });

    it('ignores text part from a different session', () => {
      const client = createClient();
      const params = makeParams({ sessionId: 'session-123' });

      (client as any).handleSseEvent({
        ...params,
        data: {
          type: 'message.part',
          properties: {
            sessionID: 'other-session',
            part: {
              id: 'part-1',
              messageID: 'msg-1',
              type: 'text',
              text: 'Should be ignored',
              sessionID: 'other-session',
            },
          },
        },
      });

      expect(params.handlers.calls['onTextDelta']).toBeUndefined();
    });

    it('text parts arrive after message.updated with completed — text is still delivered', () => {
      const client = createClient();
      const params = makeParams({ sessionId: 'session-123' });

      // 1. message.updated with time.completed arrives first
      (client as any).handleSseEvent({
        ...params,
        data: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'msg-1',
              role: 'assistant',
              sessionID: 'session-123',
              time: { completed: '2026-01-01T00:00:00Z' },
            },
          },
        },
      });

      // Session should NOT be ended yet
      expect(params.handlers.calls['onSessionEnd']).toBeUndefined();

      // 2. Text part arrives after
      (client as any).handleSseEvent({
        ...params,
        data: {
          type: 'message.part',
          properties: {
            sessionID: 'session-123',
            part: {
              id: 'part-1',
              messageID: 'msg-1',
              type: 'text',
              text: 'This is the assistant response',
              sessionID: 'session-123',
            },
          },
        },
      });

      // Text should be delivered
      expect(params.handlers.calls['onTextDelta']?.length).toBe(1);
      expect(params.handlers.calls['onTextDelta'][0][0]).toBe('This is the assistant response');

      // 3. message.finish ends the session
      (client as any).handleSseEvent({
        ...params,
        data: {
          type: 'message.finish',
          properties: { sessionID: 'session-123' },
        },
      });

      expect(params.handlers.calls['onSessionEnd']?.length).toBe(1);
    });
  });

  describe('user message filtering', () => {
    it('skips parts matching the prompt text', () => {
      const client = createClient();
      const params = makeParams({ sessionId: 'session-123', prompt: 'test prompt' });

      (client as any).handleSseEvent({
        ...params,
        data: {
          type: 'message.part',
          properties: {
            sessionID: 'session-123',
            part: {
              id: 'part-user',
              messageID: 'msg-user',
              type: 'text',
              text: 'test prompt',
              sessionID: 'session-123',
            },
          },
        },
      });

      // Should be filtered out — not delivered as text delta
      expect(params.handlers.calls['onTextDelta']).toBeUndefined();
    });

    it('skips parts from user role messages', () => {
      const client = createClient();
      const params = makeParams({ sessionId: 'session-123' });

      // First register the message role
      params.messageRoleById.set('msg-user', 'user');

      (client as any).handleSseEvent({
        ...params,
        data: {
          type: 'message.part',
          properties: {
            sessionID: 'session-123',
            part: {
              id: 'part-user',
              messageID: 'msg-user',
              type: 'text',
              text: 'user typed this',
              sessionID: 'session-123',
            },
          },
        },
      });

      expect(params.handlers.calls['onTextDelta']).toBeUndefined();
    });
  });
});
