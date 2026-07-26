/**
 * Model display module for the Worklog Pi extension.
 *
 * Tracks the resolved provider/model from llama-proxy responses and the
 * user-selected model alias. Exports getters so that other modules (e.g.
 * session-health) can read the current provider/model for display in the
 * footer, without needing to go through `setStatus`.
 *
 * Integrated from the standalone model-display extension
 * (previously at packages/tui/extensions/model-display.ts).
 *
 * Shows the format: `<provider>/<model-id>` (e.g., `openai/gpt-4`)
 * without the Pi model alias prefix.
 *
 * - Listens to `after_provider_response` to read the `X-Resolved-Model` header
 *   that the llama-proxy adds to every proxy-routed request.
 * - Listens to `model_select` to track whether a model is selected (for the
 *   `(pending)` fallback state), but does not display the model alias.
 * - Exports `getResolvedModel()` and `getSelectedModel()` so the footer renderer
 *   can display the model on its own dedicated line.
 * - Exports `onModelChange()` so consumers can be notified when state changes.
 *
 * Requires the llama-proxy to be configured as Pi's provider and to include
 * the `X-Resolved-Model` header in its responses (see LP-0MR4ZIGDT004A3E1).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// ── Module-level state ────────────────────────────────────────────────────

/** The most recently resolved provider/model from a proxy response. */
let _resolvedModel: string | null = null;

/** The most recently selected Pi model alias. */
let _selectedModel: string | null = null;

/** Optional callback invoked whenever the model state changes. */
let _onModelChange: (() => void) | null = null;

/**
 * Reset all module-level state to initial values.
 *
 * @internal Used by tests to ensure isolation between test cases.
 */
export function _resetModelDisplayState(): void {
  _resolvedModel = null;
  _selectedModel = null;
  _onModelChange = null;
}

// ── Public getters ────────────────────────────────────────────────────────

/**
 * Return the resolved provider/model string (e.g. `"openai/gpt-4"`)
 * from the last `after_provider_response` event, or `null` if no
 * proxy response has been received yet.
 */
export function getResolvedModel(): string | null {
  return _resolvedModel;
}

/**
 * Return the Pi model alias (e.g. `"code"`, `"plan"`) from the last
 * `model_select` event, or `null` if no model is selected.
 */
export function getSelectedModel(): string | null {
  return _selectedModel;
}

/**
 * Status key used for the model/provider display in the footer.
 * The `0` prefix ensures this status sorts first in the extension status
 * line (localeCompare order), placing the provider/model at the start.
 * Changed from "model-display" when this module was integrated into the
 * Worklog extension, to avoid conflicts with other status entries.
 *
 * @deprecated The model is now displayed on a dedicated footer line
 *   managed by session-health.ts. This constant is retained for
 *   backward compatibility with any external consumers.
 */
export const MODEL_DISPLAY_STATUS_KEY = 'worklog-0model';

/**
 * Register a callback that fires whenever the resolved model or selected
 * model changes. Returns a disposer function that unregisters the callback.
 *
 * @param cb - Callback to invoke on model state change
 * @returns Disposer function to unregister the callback
 */
export function onModelChange(cb: () => void): () => void {
  _onModelChange = cb;
  return () => {
    _onModelChange = null;
  };
}

/**
 * Register model-display event handlers with a Pi extension instance.
 *
 * Sets up listeners for:
 * - `session_start` — captures the current Pi model alias from context
 * - `model_select` — tracks model selection changes
 * - `after_provider_response` — reads the `X-Resolved-Model` header from
 *   llama-proxy responses
 *
 * The resolved provider/model can be read via `getResolvedModel()`.
 * When no response has been received yet but a model is selected,
 * `getSelectedModel()` returns the model alias (for `(pending)` display).
 * The Pi model alias is not exposed in the resolved model value.
 *
 * @param pi - The ExtensionAPI instance
 */
export function registerModelDisplay(pi: ExtensionAPI): void {
  // Capture initial Pi model alias from session context.
  // This runs before the footer is set up, ensuring getSelectedModel()
  // returns the alias even when no model_select event has fired yet.
  // Only populates if model_select hasn't already set the value.
  pi.on('session_start', (_event, ctx) => {
    // Reset the resolved model for the new session — the new session
    // may resolve to a different provider/model than the previous one.
    // Without this, the old resolved model from the previous session
    // would show in the footer until the new proxy response arrives.
    if (_resolvedModel !== null) {
      _resolvedModel = null;
      _onModelChange?.();
    }
    if (ctx.model?.id && !_selectedModel) {
      _selectedModel = ctx.model.id;
      _onModelChange?.();
    }
  });

  // Track model selection changes
  pi.on('model_select', (_event, _ctx) => {
    // event.model has provider and id fields
    const model = _event.model;
    if (model && model.id) {
      _selectedModel = model.id;
      _onModelChange?.();
    } else if (_selectedModel !== null) {
      _selectedModel = null;
      _onModelChange?.();
    }
  });

  // Extract resolved model from proxy response headers
  pi.on('after_provider_response', (event, _ctx) => {
    // event.headers contains the normalized response headers
    // X-Resolved-Model header is lowercase in normalized form
    const headers = event.headers as Record<string, string>;
    const headerValue: string | undefined =
      headers['x-resolved-model'] ?? headers['X-Resolved-Model'];

    if (headerValue !== undefined && headerValue !== _resolvedModel) {
      _resolvedModel = headerValue;
      _onModelChange?.();
    }
  });
}
