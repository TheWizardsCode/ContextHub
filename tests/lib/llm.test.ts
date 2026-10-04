/**
 * Tests for the LLM chat-completion client (src/lib/llm.ts).
 *
 * Covers:
 * - `available` resolution from config, environment variables and defaults
 *   (mirroring the `OpenAIEmbedder` pattern).
 * - `complete()` request construction (URL, model, user message, auth header,
 *   optional max_tokens) and response parsing via a mocked global `fetch`.
 * - Graceful degradation: unavailable client, non-2xx responses, empty
 *   responses and timeouts all surface as descriptive errors — no network
 *   calls are ever made.
 *
 * WL-0MULI0LXL00829JI (ChatClient: OpenAI-compatible chat completions)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OpenAIChatClient,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_TIMEOUT_MS,
  type ChatClient,
} from '../../src/lib/llm.js';

/** Environment variables consulted by the client (isolated per test). */
const LLM_ENV_KEYS = [
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_API_KEY',
  'LLM_TIMEOUT_MS',
] as const;

/** Build an OpenAI-compatible JSON response with one completion choice. */
function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('OpenAIChatClient', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of LLM_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of LLM_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── Availability ───────────────────────────────────────────────────────

  describe('availability', () => {
    it('is unavailable when no config and no env vars are set', () => {
      expect(new OpenAIChatClient().available).toBe(false);
    });

    it('is available when hasExplicitConfig is true', () => {
      expect(new OpenAIChatClient({ hasExplicitConfig: true }).available).toBe(true);
    });

    it('is available when an apiKey is provided via config', () => {
      expect(new OpenAIChatClient({ apiKey: 'test-key' }).available).toBe(true);
    });

    it('is available when LLM_BASE_URL is set in the environment', () => {
      process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
      expect(new OpenAIChatClient().available).toBe(true);
    });

    it('is available when LLM_MODEL is set in the environment', () => {
      process.env.LLM_MODEL = 'compact';
      expect(new OpenAIChatClient().available).toBe(true);
    });

    it('satisfies the ChatClient interface contract', () => {
      const client: ChatClient = new OpenAIChatClient({ hasExplicitConfig: true });
      expect(typeof client.complete).toBe('function');
    });
  });

  // ── complete() ─────────────────────────────────────────────────────────

  describe('complete()', () => {
    function mockFetch(
      impl: (url: string, init: RequestInit) => Promise<Response>,
    ): ReturnType<typeof vi.fn> {
      const fn = vi.fn(impl);
      vi.stubGlobal('fetch', fn);
      return fn;
    }

    it('posts the prompt to {baseUrl}/chat/completions and returns the content', async () => {
      const fetchMock = mockFetch(async () => chatResponse('Do this.'));
      const client = new OpenAIChatClient({
        hasExplicitConfig: true,
        baseUrl: 'http://proxy.local/v1',
        model: 'compact',
      });

      const result = await client.complete('Explain the flag');

      expect(result).toBe('Do this.');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://proxy.local/v1/chat/completions');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        model: 'compact',
        messages: [{ role: 'user', content: 'Explain the flag' }],
      });
    });

    it('strips a trailing slash from the base URL', async () => {
      const fetchMock = mockFetch(async () => chatResponse('ok'));
      const client = new OpenAIChatClient({
        hasExplicitConfig: true,
        baseUrl: 'http://proxy.local/v1/',
      });

      await client.complete('hi');
      expect(fetchMock.mock.calls[0][0]).toBe('http://proxy.local/v1/chat/completions');
    });

    it('defaults the model to compact when unset', async () => {
      const fetchMock = mockFetch(async () => chatResponse('ok'));
      const client = new OpenAIChatClient({ hasExplicitConfig: true });

      await client.complete('hi');
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).model).toBe(
        DEFAULT_LLM_MODEL,
      );
    });

    it('forwards maxTokens as max_tokens when provided', async () => {
      const fetchMock = mockFetch(async () => chatResponse('ok'));
      const client = new OpenAIChatClient({ hasExplicitConfig: true });

      await client.complete('hi', { maxTokens: 42 });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).max_tokens).toBe(42);
    });

    it('omits max_tokens when not provided', async () => {
      const fetchMock = mockFetch(async () => chatResponse('ok'));
      const client = new OpenAIChatClient({ hasExplicitConfig: true });

      await client.complete('hi');
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).not.toHaveProperty(
        'max_tokens',
      );
    });

    it('sends an Authorization header when an apiKey is configured', async () => {
      const fetchMock = mockFetch(async () => chatResponse('ok'));
      const client = new OpenAIChatClient({ apiKey: 'secret-key' });

      await client.complete('hi');
      const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer secret-key');
    });

    it('omits the Authorization header when no apiKey is configured', async () => {
      const fetchMock = mockFetch(async () => chatResponse('ok'));
      const client = new OpenAIChatClient({ hasExplicitConfig: true });

      await client.complete('hi');
      const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    });

    it('throws a descriptive error when the client is unavailable', async () => {
      const fetchMock = mockFetch(async () => chatResponse('never'));
      const client = new OpenAIChatClient();

      await expect(client.complete('hi')).rejects.toThrow(/not configured/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws on a non-2xx response', async () => {
      mockFetch(
        async () =>
          new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
      );
      const client = new OpenAIChatClient({ hasExplicitConfig: true });

      await expect(client.complete('hi')).rejects.toThrow(/Chat API error: 500/);
    });

    it('throws when the response contains no content', async () => {
      mockFetch(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
      const client = new OpenAIChatClient({ hasExplicitConfig: true });

      await expect(client.complete('hi')).rejects.toThrow(/empty/i);
    });

    it('rejects with a timeout error when the request exceeds the configured timeout', async () => {
      mockFetch(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          }),
      );
      const client = new OpenAIChatClient({ hasExplicitConfig: true, timeoutMs: 20 });

      await expect(client.complete('hi')).rejects.toThrow(/timed out/i);
    });

    it('honours a per-call timeout override', async () => {
      mockFetch(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          }),
      );
      // Config timeout is long; the per-call override must win and fire fast.
      const client = new OpenAIChatClient({ hasExplicitConfig: true, timeoutMs: 10_000 });

      await expect(client.complete('hi', { timeoutMs: 20 })).rejects.toThrow(/timed out/i);
    });

    it('propagates network errors', async () => {
      mockFetch(async () => {
        throw new TypeError('fetch failed');
      });
      const client = new OpenAIChatClient({ hasExplicitConfig: true });

      await expect(client.complete('hi')).rejects.toThrow(/fetch failed/);
    });
  });

  // ── Defaults ───────────────────────────────────────────────────────────

  describe('defaults', () => {
    it('exposes the documented default base URL, model and timeout', () => {
      expect(DEFAULT_LLM_BASE_URL).toBe('http://192.168.0.199:8000/v1');
      expect(DEFAULT_LLM_MODEL).toBe('compact');
      expect(DEFAULT_LLM_TIMEOUT_MS).toBe(15000);
    });
  });
});
