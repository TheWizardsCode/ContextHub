import { describe, it, expect, vi } from 'vitest';
import { OpencodeClient } from '../../src/tui/opencode-client.js';

describe('OpencodeClient (TUI) defensive shutdown on input.request', () => {
  it('calls stopServer when input.request handler is invoked', () => {
    const logs: string[] = [];
    const options: any = {
      port: 0,
      log: (m: string) => logs.push(m),
      showToast: (_: string) => undefined,
      modalDialogs: {},
      render: () => undefined,
      persistedState: { load: async () => null, save: async () => undefined, getPrefix: () => undefined },
    };

    const client = new OpencodeClient(options);

    const pane: any = {
      pushLine: vi.fn(),
      setContent: vi.fn(),
      getContent: vi.fn(() => ''),
      setLabel: vi.fn(),
      setScrollPerc: vi.fn(),
      focus: vi.fn(),
    };

    const indicator: any = {
      setContent: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
    };

    // inputField.once should register a handler for 'submit'. We'll simulate
    // registration by storing the handler so tests can invoke it if desired.
    let registeredHandler: ((v: string) => void) | null = null;
    const inputField: any = {
      setLabel: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      focus: vi.fn(),
      clearValue: vi.fn(),
      once: vi.fn((event: string, handler: (v: string) => void) => {
        if (event === 'submit') registeredHandler = handler;
      }),
    };

    const onSessionEnd = vi.fn();

    // Access the private createSessionTools helper (allowed in tests via any)
    // to obtain the handlers object used during SSE parsing.
    const tools = (client as any).createSessionTools('session-1', pane, indicator, inputField, onSessionEnd);
    expect(tools).toBeTruthy();
    const handlers = tools.handlers as any;

    // Spy on stopServer to ensure it is invoked by the input.request path.
    const stopSpy = vi.spyOn(client as any, 'stopServer');

    // Invoke the onInputRequest handler, which should call stopServer defensively.
    handlers.onInputRequest({ type: 'text', prompt: 'Please provide value' });

    expect(stopSpy).toHaveBeenCalled();

    // Ensure UI bits were updated as expected.
    expect(indicator.setContent).toHaveBeenCalled();
    expect(indicator.show).toHaveBeenCalled();
    expect(inputField.setLabel).toHaveBeenCalled();
    expect(inputField.show).toHaveBeenCalled();
    expect(inputField.focus).toHaveBeenCalled();
    // The pane should have received the prompt line
    expect((pane.pushLine as any).mock.calls.length).toBeGreaterThanOrEqual(1);

    // If a submit handler was registered, simulate submission to ensure no crash
    // (the handler will call sendInputResponse which will use httpImpl; we won't
    // assert network activity here, just that the handler exists and can be invoked)
    if (registeredHandler) {
      expect(typeof registeredHandler).toBe('function');
    }
  });
});

describe('OpencodeClient history rendering markers', () => {
  it('does not render tool or step marker lines in session history pane content', async () => {
    const httpImpl: any = {
      request: (opts: any, cb: Function) => {
        const method = (opts.method || 'GET').toUpperCase();
        const path = opts.path || '';

        const routeKey = `${method} ${path}`;
        const routes: Record<string, { statusCode: number; body?: string }> = {
          'GET /session/sess-h1': { statusCode: 200, body: '' },
          'GET /session/sess-h1/message': {
            statusCode: 200,
            body: JSON.stringify([
              {
                info: { role: 'assistant' },
                parts: [
                  { type: 'text', text: 'hello from history' },
                  { type: 'tool-use', tool: { name: 'bash', description: 'npm test' } },
                  { type: 'step-start', title: 'running' },
                ],
              },
            ]),
          },
          'POST /session/sess-h1/prompt_async': { statusCode: 204 },
        };

        const route = routes[routeKey] || { statusCode: 200, body: '' };

        const listeners: Record<string, Function[]> = {};
        const res = {
          statusCode: route.statusCode,
          on: (event: string, fn: Function) => {
            (listeners[event] = listeners[event] || []).push(fn);
          },
          resume: vi.fn(),
        } as any;

        cb(res);

        queueMicrotask(() => {
          if (route.body !== undefined) {
            for (const fn of listeners.data || []) fn(route.body);
          }
          for (const fn of listeners.end || []) fn();
        });

        return {
          on: vi.fn(),
          write: vi.fn(),
          end: vi.fn(),
          abort: vi.fn(),
          removeAllListeners: vi.fn(),
        } as any;
      },
    };

    const options: any = {
      port: 1234,
      log: () => {},
      showToast: () => undefined,
      modalDialogs: { selectList: async () => null, editTextarea: async () => null, confirmTextbox: async () => true },
      render: () => undefined,
      persistedState: {
        load: async () => ({ sessionMap: { 'WL-H1': 'sess-h1' } }),
        save: async () => undefined,
        getPrefix: () => undefined,
      },
      httpImpl,
      spawnImpl: () => { throw new Error('not used'); },
    };

    const client = new OpencodeClient(options);
    (client as any).connectToSSE = vi.fn((
      _sessionId: string,
      _prompt: string,
      _pane: any,
      _indicator: any,
      _inputField: any,
      resolve: () => void,
    ) => {
      resolve();
    });

    const paneContent: { value: string } = { value: '' };
    const pane: any = {
      getContent: () => paneContent.value,
      setContent: vi.fn((s: string) => { paneContent.value = s; }),
      setLabel: vi.fn(),
      setScrollPerc: vi.fn(),
      pushLine: vi.fn(),
      focus: vi.fn(),
    };

    await client.sendPrompt({
      prompt: 'hello',
      pane,
      getSelectedItemId: () => 'WL-H1',
      onComplete: () => {},
    });

    expect(paneContent.value).toContain('hello from history');
    expect(paneContent.value).not.toContain('Tool: bash');
    expect(paneContent.value).not.toContain('Step: running');
  });
});
