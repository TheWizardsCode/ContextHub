/**
 * Model display module for the Worklog Pi extension.
 *
 * Displays the resolved provider/model from llama-proxy responses in Pi's
 * status bar. Integrated from the standalone model-display extension
 * (previously at packages/tui/extensions/model-display.ts).
 *
 * Shows the format: `<provider>/<model-id>` (e.g., `openai/gpt-4`)
 * without the Pi model alias prefix.
 *
 * - Listens to `after_provider_response` to read the `X-Resolved-Model` header
 *   that the llama-proxy adds to every proxy-routed request.
 * - Listens to `model_select` to track whether a model is selected (for the
 *   `(pending)` fallback state), but does not display the model alias.
 * - Updates the status bar on every request so the user always sees which
 *   provider and model actually served their request.
 *
 * Requires the llama-proxy to be configured as Pi's provider and to include
 * the `X-Resolved-Model` header in its responses (see LP-0MR4ZIGDT004A3E1).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Status key used for the model/provider display in the footer.
 * Changed from "model-display" when this module was integrated into the
 * Worklog extension, to avoid conflicts with other status entries.
 */
export const MODEL_DISPLAY_STATUS_KEY = 'worklog-model';

/**
 * Register model-display event handlers with a Pi extension instance.
 *
 * Sets up listeners for:
 * - `model_select` — tracks whether a model is selected (for `(pending)` state)
 * - `after_provider_response` — reads the `X-Resolved-Model` header from
 *   llama-proxy responses and updates the status bar
 *
 * The status display shows only the resolved provider/model from the
 * `X-Resolved-Model` header. When no response has been received yet but a
 * model is selected, it shows `(pending)`. The Pi model alias is not shown.
 *
 * @param pi - The ExtensionAPI instance
 */
export function registerModelDisplay(pi: ExtensionAPI): void {
  // Track whether a model is selected (used for the (pending) fallback state)
  let selectedModel: string | null = null;

  // Track the resolved model from the last proxy response
  let resolvedModel: string | null = null;

  // Update the status display
  function updateStatus(ctx: { ui: { setStatus: (key: string, value: string) => void } }) {
    if (resolvedModel) {
      ctx.ui.setStatus(MODEL_DISPLAY_STATUS_KEY, resolvedModel);
    } else if (selectedModel) {
      ctx.ui.setStatus(MODEL_DISPLAY_STATUS_KEY, '(pending)');
    }
    // If neither resolvedModel nor selectedModel, no status call (nothing to display)
  }

  // Track model selection changes (used only for (pending) fallback)
  pi.on('model_select', (_event, ctx) => {
    // event.model has provider and id fields
    const model = _event.model;
    if (model && model.id) {
      selectedModel = model.id;
    }
    updateStatus(ctx);
  });

  // Extract resolved model from proxy response headers
  pi.on('after_provider_response', (event, ctx) => {
    // event.headers contains the normalized response headers
    // X-Resolved-Model header is lowercase in normalized form
    const headers = event.headers as Record<string, string>;
    const headerValue: string | undefined =
      headers['x-resolved-model'] ?? headers['X-Resolved-Model'];

    if (headerValue) {
      resolvedModel = headerValue;
    }
    updateStatus(ctx);
  });
}
