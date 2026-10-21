/**
 * Unit tests for model-display.ts — Model/provider display state management.
 *
 * Verifies that:
 * 1. registerModelDisplay() sets up event listeners for session_start,
 *    model_select, and after_provider_response.
 * 2. The getters return the correct values after events fire.
 * 3. after_provider_response updates the resolved model from X-Resolved-Model header.
 * 4. When no proxy response has been received yet, getResolvedModel() returns null.
 * 5. The module exports the MODEL_DISPLAY_STATUS_KEY and getter/registration functions.
 * 6. onModelChange() notifies consumers when model state changes.
 *
 * Run: npx vitest run packages/tui/extensions/Worklog/model-display.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @earendil-works/pi-coding-agent ──────────────────────────────

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/home/test-user/.pi/agent',
}));

// ── Module under test ─────────────────────────────────────────────────

import {
  registerModelDisplay,
  MODEL_DISPLAY_STATUS_KEY,
  getResolvedModel,
  getSelectedModel,
  onModelChange,
  _resetModelDisplayState,
} from './model-display.js';

describe('model-display', () => {
  /** Tracks event listeners registered by registerModelDisplay. */
  const registeredListeners: Record<string, Function> = {};

  /** Mock ExtensionAPI with on(). */
  let mockPi: any;
  /** Mock context (minimal, not used after the refactor). */
  let mockCtx: any;

  beforeEach(() => {
    // Reset tracking
    Object.keys(registeredListeners).forEach(k => delete registeredListeners[k]);

    // Mock extension context
    mockCtx = {
      ui: {
        setStatus: vi.fn(),
      },
    };

    // Mock Pi API
    mockPi = {
      on: vi.fn((event: string, handler: Function) => {
        registeredListeners[event] = handler;
      }),
    };

    // Reset module-level state so each test starts clean
    _resetModelDisplayState();
  });



  // ── Exports ───────────────────────────────────────────────────────

  it('exports MODEL_DISPLAY_STATUS_KEY', () => {
    expect(MODEL_DISPLAY_STATUS_KEY).toBe('worklog-0model');
  });

  it('exports registerModelDisplay as a function', () => {
    expect(typeof registerModelDisplay).toBe('function');
  });

  it('exports getResolvedModel and getSelectedModel as functions', () => {
    expect(typeof getResolvedModel).toBe('function');
    expect(typeof getSelectedModel).toBe('function');
  });

  it('exports onModelChange as a function', () => {
    expect(typeof onModelChange).toBe('function');
  });

  // ── Initial state ──────────────────────────────────────────────────

  it('getResolvedModel returns null before any events', () => {
    expect(getResolvedModel()).toBeNull();
  });

  it('getSelectedModel returns null before any events', () => {
    expect(getSelectedModel()).toBeNull();
  });

  // ── Event registration ───────────────────────────────────────────

  it('registers session_start listener', () => {
    registerModelDisplay(mockPi);
    expect(mockPi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(registeredListeners['session_start']).toBeDefined();
  });

  it('registers model_select listener', () => {
    registerModelDisplay(mockPi);
    expect(mockPi.on).toHaveBeenCalledWith('model_select', expect.any(Function));
    expect(registeredListeners['model_select']).toBeDefined();
  });

  it('registers after_provider_response listener', () => {
    registerModelDisplay(mockPi);
    expect(mockPi.on).toHaveBeenCalledWith('after_provider_response', expect.any(Function));
    expect(registeredListeners['after_provider_response']).toBeDefined();
  });

  // ── session_start behavior ──────────────────────────────────────

  it('session_start captures Pi model alias from context', () => {
    registerModelDisplay(mockPi);
    const handler = registeredListeners['session_start'];

    handler({}, { model: { id: 'code' } });

    expect(getSelectedModel()).toBe('code');
    expect(getResolvedModel()).toBeNull();
  });

  it('session_start resets resolvedModel from previous session', () => {
    registerModelDisplay(mockPi);
    const sessionHandler = registeredListeners['session_start'];
    const responseHandler = registeredListeners['after_provider_response'];

    // Simulate a previous session that resolved a model
    responseHandler({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);
    expect(getResolvedModel()).toBe('openai/gpt-4');

    // Track onModelChange
    const changeCb = vi.fn();
    onModelChange(changeCb);

    // New session starts — should reset the resolved model
    sessionHandler({}, { model: { id: 'code' } });

    expect(getResolvedModel()).toBeNull();
    expect(getSelectedModel()).toBe('code');
    // onModelChange should have been called for the resolved model reset
    expect(changeCb).toHaveBeenCalled();
  });

  it('session_start does not overwrite an already-set selectedModel', () => {
    registerModelDisplay(mockPi);
    const modelHandler = registeredListeners['model_select'];
    const sessionHandler = registeredListeners['session_start'];

    // Model already selected
    modelHandler({ model: { id: 'plan' } }, mockCtx);
    expect(getSelectedModel()).toBe('plan');

    // session_start with a different model context
    sessionHandler({}, { model: { id: 'code' } });

    // Should NOT overwrite — model_select is the authoritative source
    expect(getSelectedModel()).toBe('plan');
  });

  // ── model_select behavior ────────────────────────────────────────

  it('model_select sets selectedModel when model id is provided', () => {
    registerModelDisplay(mockPi);
    const handler = registeredListeners['model_select'];

    // A Local Proxy selection keeps the resolved value null until a proxy
    // header arrives. (WL-0MVGU4S58003IRXV: a *non-proxy* provider now
    // falls back to `${provider}/${id}` immediately, so the fixture must use
    // the proxy provider to keep asserting the `(resolving)` state.)
    handler({ model: { id: 'plan', provider: 'Local Proxy' } }, mockCtx);

    expect(getSelectedModel()).toBe('plan');
    expect(getResolvedModel()).toBeNull();
  });

  it('model_select without model id does not crash and does not change state', () => {
    registerModelDisplay(mockPi);
    const handler = registeredListeners['model_select'];

    handler({ model: null }, mockCtx);

    // State should remain unchanged (null)
    expect(getSelectedModel()).toBeNull();
    expect(getResolvedModel()).toBeNull();
  });

  it('model_select clears selectedModel when model is null after being set', () => {
    registerModelDisplay(mockPi);
    const handler = registeredListeners['model_select'];

    // First set a model
    handler({ model: { id: 'plan' } }, mockCtx);
    expect(getSelectedModel()).toBe('plan');

    // Then clear it
    handler({ model: null }, mockCtx);
    expect(getSelectedModel()).toBeNull();
  });

  it('after_provider_response overwrites resolvedModel even when model_select was previously received', () => {
    registerModelDisplay(mockPi);
    const modelHandler = registeredListeners['model_select'];
    const responseHandler = registeredListeners['after_provider_response'];

    // First, select a model
    modelHandler({ model: { id: 'code' } }, mockCtx);

    // Then, receive a provider response
    responseHandler({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);

    expect(getResolvedModel()).toBe('openai/gpt-4');
    expect(getSelectedModel()).toBe('code');
  });

  // ── after_provider_response behavior ──────────────────────────────

  it('after_provider_response extracts X-Resolved-Model from headers', () => {
    registerModelDisplay(mockPi);
    const handler = registeredListeners['after_provider_response'];

    handler({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);

    expect(getResolvedModel()).toBe('openai/gpt-4');
  });

  it('after_provider_response handles uppercase X-Resolved-Model header', () => {
    registerModelDisplay(mockPi);
    const handler = registeredListeners['after_provider_response'];

    handler({ headers: { 'X-Resolved-Model': 'anthropic/claude-3' } }, mockCtx);

    expect(getResolvedModel()).toBe('anthropic/claude-3');
  });

  it('after_provider_response without resolved model header does not crash', () => {
    registerModelDisplay(mockPi);
    const handler = registeredListeners['after_provider_response'];

    handler({ headers: {} }, mockCtx);

    expect(getResolvedModel()).toBeNull();
  });

  it('after_provider_response shows provider/model even when no model was previously selected', () => {
    registerModelDisplay(mockPi);
    const handler = registeredListeners['after_provider_response'];

    // Without any prior model_select
    handler({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);

    expect(getResolvedModel()).toBe('openai/gpt-4');
    expect(getSelectedModel()).toBeNull();
  });

  // ── onModelChange behavior ────────────────────────────────────────

  it('onModelChange fires on session_start when model is available', () => {
    registerModelDisplay(mockPi);
    const changeCb = vi.fn();
    onModelChange(changeCb);

    const handler = registeredListeners['session_start'];
    handler({}, { model: { id: 'code' } });

    expect(changeCb).toHaveBeenCalledOnce();
  });

  it('onModelChange fires on model_select', () => {
    registerModelDisplay(mockPi);
    const changeCb = vi.fn();
    onModelChange(changeCb);

    const handler = registeredListeners['model_select'];
    handler({ model: { id: 'plan' } }, mockCtx);

    expect(changeCb).toHaveBeenCalledOnce();
  });

  it('onModelChange fires on after_provider_response', () => {
    registerModelDisplay(mockPi);
    const changeCb = vi.fn();
    onModelChange(changeCb);

    const handler = registeredListeners['after_provider_response'];
    handler({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);

    expect(changeCb).toHaveBeenCalledOnce();
  });

  it('onModelChange disposer stops notifications', () => {
    registerModelDisplay(mockPi);
    const changeCb = vi.fn();
    const dispose = onModelChange(changeCb);

    dispose(); // Unregister

    const handler = registeredListeners['after_provider_response'];
    handler({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);

    expect(changeCb).not.toHaveBeenCalled();
  });

  // ── Edge cases ───────────────────────────────────────────────────

  it('handles multiple model_select calls, tracking the latest selection', () => {
    registerModelDisplay(mockPi);
    const handler = registeredListeners['model_select'];

    handler({ model: { id: 'plan' } }, mockCtx);
    expect(getSelectedModel()).toBe('plan');

    handler({ model: { id: 'code' } }, mockCtx);
    expect(getSelectedModel()).toBe('code');
  });

  it('handles multiple after_provider_response calls, overwriting previous resolved model', () => {
    registerModelDisplay(mockPi);
    const handler = registeredListeners['after_provider_response'];

    handler({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);
    expect(getResolvedModel()).toBe('openai/gpt-4');

    handler({ headers: { 'x-resolved-model': 'anthropic/claude-sonnet-4' } }, mockCtx);
    expect(getResolvedModel()).toBe('anthropic/claude-sonnet-4');
  });

  it('does not fire onModelChange when resolved model value does not change', () => {
    registerModelDisplay(mockPi);
    const changeCb = vi.fn();
    onModelChange(changeCb);

    const handler = registeredListeners['after_provider_response'];
    handler({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);
    expect(changeCb).toHaveBeenCalledTimes(1);

    // Same value again — should not fire
    handler({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);
    expect(changeCb).toHaveBeenCalledTimes(1);
  });

  it('does not fire onModelChange when header value is undefined', () => {
    registerModelDisplay(mockPi);
    const changeCb = vi.fn();
    onModelChange(changeCb);

    const handler = registeredListeners['after_provider_response'];
    handler({ headers: {} }, mockCtx);

    expect(changeCb).not.toHaveBeenCalled();
  });

  // ── Mid-session model switch (WL-0MVGU4S58003IRXV, WL-0MVGU7H24009G8II) ──
  //
  // These specs were landed as `it.fails(...)` (TDD red) by WL-0MVGU4S58003IRXV
  // and flipped to `it(...)` here as the sibling implementation
  // (WL-0MVGU7H24009G8II) landed (the same convention used by
  // WL-0MVFE0T0M009ZCPM / WL-0MT1EE3S7005DJ1F).
  //
  // Contract pinned here:
  //   * every mid-session `model_select` (source `set`/`cycle`/`restore`)
  //     invalidates the previously resolved model;
  //   * the invalidation notifies `onModelChange` exactly once;
  //   * a non-proxy provider (anything that is not `Local Proxy`) resolves to
  //     the selected model's own `${provider}/${id}` immediately, so the
  //     footer never shows a stale proxy value or an endless `(resolving)`;
  //   * a `Local Proxy` selection keeps `null` until its `x-resolved-model`
  //     header arrives (the proxy header remains the source of truth);
  //   * fail-open: a missing model or provider never throws.
  describe('mid-session model switch', () => {
    /**
     * The name of the Local Proxy provider in models.json.
     *
     * This is the canonical project convention centralised in
     * `@worklog/shared/lease-release` (`LOCAL_PROVIDER_NAME`).
     */
    const LOCAL_PROXY_PROVIDER = 'Local Proxy';

    /** Register the extension and return the event handlers under test. */
    function registerWithHandlers() {
      registerModelDisplay(mockPi);
      return {
        modelSelect: registeredListeners['model_select'],
        response: registeredListeners['after_provider_response'],
      };
    }

    // ── AC1: mid-session invalidation, all sources ────────────────────

    for (const source of ['set', 'cycle', 'restore'] as const) {
      it(
        `invalidates the resolved model on a mid-session model_select with source "${source}"`,
        () => {
          const { modelSelect, response } = registerWithHandlers();

          // A previous proxy response has resolved a provider/model.
          response({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);
          expect(getResolvedModel()).toBe('openai/gpt-4');

          // A mid-session switch to another proxy-routed alias must drop the
          // stale value immediately (restore included: uniform behaviour with
          // the session_start reset, WL-0MRZ1EIY5008VBE6 / assumption A3).
          modelSelect(
            {
              model: { id: 'plan', provider: LOCAL_PROXY_PROVIDER },
              previousModel: { id: 'code', provider: LOCAL_PROXY_PROVIDER },
              source,
            },
            mockCtx,
          );

          expect(getResolvedModel()).toBeNull();
          expect(getSelectedModel()).toBe('plan');
        },
      );
    }

    // ── AC1/AC5: exactly one notification per invalidation ────────────

    it(
      'notifies onModelChange exactly once when a mid-session switch invalidates the resolved model',
      () => {
        const { modelSelect, response } = registerWithHandlers();
        response({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);

        const changeCb = vi.fn();
        onModelChange(changeCb);

        modelSelect(
          { model: { id: 'plan', provider: LOCAL_PROXY_PROVIDER }, source: 'set' },
          mockCtx,
        );

        // Exactly once: not zero (the footer must re-render) and not twice
        // (a single batched state change drives one re-render).
        expect(changeCb).toHaveBeenCalledTimes(1);
        expect(getResolvedModel()).toBeNull();
        expect(getSelectedModel()).toBe('plan');
      },
    );

    // ── AC2: non-proxy provider/id fallback ───────────────────────────

    it(
      'adopts the selected model provider/id immediately for a non-proxy provider (deepseek)',
      () => {
        const { modelSelect } = registerWithHandlers();

        modelSelect(
          { model: { id: 'deepseek-v4-pro', provider: 'deepseek' }, source: 'set' },
          mockCtx,
        );

        // No x-resolved-model header can ever arrive for a non-proxy model, so
        // waiting for one would show `(resolving)` forever.
        expect(getSelectedModel()).toBe('deepseek-v4-pro');
        expect(getResolvedModel()).toBe('deepseek/deepseek-v4-pro');
      },
    );

    it(
      'replaces a stale proxy-resolved value when switching to a non-proxy provider (opencode)',
      () => {
        const { modelSelect, response } = registerWithHandlers();
        response({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);
        expect(getResolvedModel()).toBe('openai/gpt-4');

        modelSelect(
          { model: { id: 'big-pickle', provider: 'opencode' }, source: 'cycle' },
          mockCtx,
        );

        expect(getSelectedModel()).toBe('big-pickle');
        expect(getResolvedModel()).toBe('opencode/big-pickle');
      },
    );

    // ── AC3: proxy header remains the source of truth ─────────────────

    it(
      'keeps a Local Proxy selection unresolved until its x-resolved-model header arrives',
      () => {
        const { modelSelect, response } = registerWithHandlers();
        response({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);

        modelSelect(
          { model: { id: 'plan', provider: LOCAL_PROXY_PROVIDER }, source: 'set' },
          mockCtx,
        );
        expect(getResolvedModel()).toBeNull();

        // The proxy response then resolves the newly selected model.
        response({ headers: { 'x-resolved-model': 'anthropic/claude-sonnet-4' } }, mockCtx);
        expect(getResolvedModel()).toBe('anthropic/claude-sonnet-4');
        expect(getSelectedModel()).toBe('plan');
      },
    );

    it(
      'adopts the proxy header after a non-proxy fallback value was displayed',
      () => {
        const { modelSelect, response } = registerWithHandlers();
        modelSelect(
          { model: { id: 'deepseek-v4-pro', provider: 'deepseek' }, source: 'set' },
          mockCtx,
        );
        expect(getResolvedModel()).toBe('deepseek/deepseek-v4-pro');

        // Header extraction is unchanged: a proxy response always wins.
        response({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);
        expect(getResolvedModel()).toBe('openai/gpt-4');
      },
    );

    // ── AC5: last-write-wins across consecutive selections ────────────

    it(
      'uses the last selection across consecutive mid-session switches (last-write-wins)',
      () => {
        const { modelSelect } = registerWithHandlers();

        modelSelect(
          { model: { id: 'deepseek-v4-pro', provider: 'deepseek' }, source: 'set' },
          mockCtx,
        );
        modelSelect(
          { model: { id: 'big-pickle', provider: 'opencode' }, source: 'cycle' },
          mockCtx,
        );

        expect(getSelectedModel()).toBe('big-pickle');
        expect(getResolvedModel()).toBe('opencode/big-pickle');
      },
    );

    // ── AC6: fail-open ────────────────────────────────────────────────

    it(
      'does not throw and degrades safely when model_select has no model',
      () => {
        const { modelSelect, response } = registerWithHandlers();
        response({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);

        expect(() => modelSelect({ model: null }, mockCtx)).not.toThrow();
        expect(getSelectedModel()).toBeNull();
        expect(getResolvedModel()).toBeNull();
      },
    );

    it(
      'does not throw and degrades to (resolving) when the provider is missing',
      () => {
        const { modelSelect, response } = registerWithHandlers();
        response({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);

        expect(() => modelSelect({ model: { id: 'plan' } }, mockCtx)).not.toThrow();
        expect(getSelectedModel()).toBe('plan');
        // Provider unknown: the code cannot prove it is non-proxy, so it must
        // invalidate (honest `(resolving)`) rather than fabricate a value.
        expect(getResolvedModel()).toBeNull();
      },
    );
  });
});
