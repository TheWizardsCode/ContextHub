/**
 * LLM chat-completion module for Worklog
 *
 * Provides a small, dependency-injectable abstraction over an
 * OpenAI-compatible chat-completions provider, used by LLM-assisted features
 * such as the `wl interview` producer-review explanation.
 *
 * Architecture:
 *   ChatClient          — abstraction over chat providers
 *     OpenAIChatClient  — OpenAI-compatible `/chat/completions` client
 *
 * The client mirrors the `OpenAIEmbedder` graceful-degradation pattern in
 * `src/lib/search.ts`: when no explicit configuration (and no `LLM_*`
 * environment variable) is present it reports `available = false` and
 * `complete()` throws a descriptive error rather than making a request. This
 * lets callers fall back silently to non-LLM behaviour.
 *
 * Configuration priority (mirroring `OpenAIEmbedder` and
 * `resolveLlmConfig` in `src/config.ts`):
 *   1. constructor config
 *   2. `LLM_*` environment variables
 *   3. built-in defaults (local LLM proxy, `compact` model, 15 s timeout)
 *
 * No new runtime dependencies — uses the native `fetch` (Node 18+).
 *
 * WL-0MULI0LXL00829JI
 */

import type { LlmConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default OpenAI-compatible base URL — the local LLM proxy. */
export const DEFAULT_LLM_BASE_URL = 'http://192.168.0.199:8000/v1';

/** Default chat model — the proxy's `compact` model. */
export const DEFAULT_LLM_MODEL = 'compact';

/** Default request timeout in milliseconds. */
export const DEFAULT_LLM_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-call options for {@link ChatClient.complete}. */
export interface ChatCompleteOptions {
  /** Cap on generated tokens, forwarded as `max_tokens`. */
  maxTokens?: number;
  /** Per-call timeout override in milliseconds (defaults to the client's). */
  timeoutMs?: number;
}

/** Abstraction over an OpenAI-compatible chat-completion provider. */
export interface ChatClient {
  /** Whether this client is available/configured. */
  readonly available: boolean;
  /** Generate a completion for `prompt`. Rejects when unavailable or on error. */
  complete(prompt: string, options?: ChatCompleteOptions): Promise<string>;
}

/**
 * Configuration accepted by {@link OpenAIChatClient}.
 *
 * Extends the shared {@link LlmConfig} with `hasExplicitConfig`, which
 * mirrors `OpenAIEmbedder`: it marks that the caller explicitly requested the
 * LLM path (e.g. the feature is default-on) even when neither a config section
 * nor an environment variable is set.
 */
export interface OpenAIChatClientConfig extends LlmConfig {
  /** Treat the client as configured even without config/env values. */
  hasExplicitConfig?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a positive finite number from an environment string, else null. */
function parsePositiveNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// ---------------------------------------------------------------------------
// OpenAIChatClient
// ---------------------------------------------------------------------------

/**
 * OpenAI-compatible chat-completions client.
 *
 * Posts `{ model, messages: [{ role: 'user', content: prompt }] }` to
 * `${baseUrl}/chat/completions` and returns
 * `choices[0].message.content`. The request is bounded by an
 * {@link AbortController}-driven timeout (15 s by default) so a hung provider
 * can never block the caller indefinitely.
 */
export class OpenAIChatClient implements ChatClient {
  readonly available: boolean;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(config?: OpenAIChatClientConfig) {
    // Priority: 1) constructor config, 2) env vars, 3) defaults
    this.apiKey = config?.apiKey ?? process.env.LLM_API_KEY ?? '';
    this.baseUrl = config?.baseUrl ?? process.env.LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL;
    this.model = config?.model ?? process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL;
    this.timeoutMs =
      config?.timeoutMs ??
      parsePositiveNumber(process.env.LLM_TIMEOUT_MS) ??
      DEFAULT_LLM_TIMEOUT_MS;

    // Available when the caller explicitly requested the LLM path, an API key
    // is set, or any LLM_* env var signals explicit user intent.
    this.available = Boolean(
      this.apiKey ||
      config?.hasExplicitConfig ||
      process.env.LLM_BASE_URL ||
      process.env.LLM_MODEL ||
      process.env.LLM_API_KEY ||
      process.env.LLM_TIMEOUT_MS
    );
  }

  async complete(prompt: string, options: ChatCompleteOptions = {}): Promise<string> {
    if (!this.available) {
      throw new Error(
        'Chat provider is not configured. ' +
        'Set LLM_API_KEY or LLM_BASE_URL, configure llm in .worklog/config.yaml, ' +
        'or refer to CLI.md for local provider setup.'
      );
    }

    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;

    // Build headers conditionally — local providers don't need auth
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
    };
    if (options.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseBody = await response.text().catch(() => '');
        throw new Error(
          `Chat API error: ${response.status} ${response.statusText}` +
          `${responseBody ? ` — ${responseBody.slice(0, 200)}` : ''}`
        );
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;

      if (typeof content !== 'string' || content.trim() === '') {
        throw new Error('Chat API returned an empty response');
      }

      return content;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Chat API request timed out after ${timeoutMs} ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
