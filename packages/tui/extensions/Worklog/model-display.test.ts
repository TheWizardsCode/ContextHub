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

    handler({ model: { id: 'plan', provider: 'openai' } }, mockCtx);

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
});
