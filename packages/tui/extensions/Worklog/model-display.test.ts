/**
 * Unit tests for model-display.ts — Model/provider display in Pi's status bar.
 *
 * Verifies that:
 * 1. registerModelDisplay() sets up event listeners for model_select and
 *    after_provider_response.
 * 2. The status display shows only the resolved provider/model (no model alias).
 * 3. after_provider_response updates the status bar with the resolved
 *    provider/model from X-Resolved-Model header.
 * 4. When no proxy response has been received yet, the status bar shows (pending).
 * 5. The status bar key is "worklog-model" (not "model-display").
 * 6. The module exports the MODEL_DISPLAY_STATUS_KEY constant.
 *
 * Run: npx vitest run packages/tui/extensions/Worklog/model-display.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @earendil-works/pi-coding-agent ──────────────────────────────

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/home/test-user/.pi/agent',
}));

// ── Module under test ─────────────────────────────────────────────────

import { registerModelDisplay, MODEL_DISPLAY_STATUS_KEY } from './model-display.js';

describe('model-display', () => {
  /** Tracks event listeners registered by registerModelDisplay. */
  const registeredListeners: Record<string, Function> = {};
  /** Tracks status bar calls: { key: value } */
  const statusCalls: Record<string, string | undefined> = {};

  /** Mock ExtensionAPI with on() and a minimal context with ui. */
  let mockPi: any;
  let mockCtx: any;

  beforeEach(() => {
    // Reset tracking
    Object.keys(registeredListeners).forEach(k => delete registeredListeners[k]);
    Object.keys(statusCalls).forEach(k => delete statusCalls[k]);

    // Mock extension context
    mockCtx = {
      ui: {
        setStatus: vi.fn((key: string, value: string | undefined) => {
          statusCalls[key] = value;
        }),
      },
    };

    // Mock Pi API
    mockPi = {
      on: vi.fn((event: string, handler: Function) => {
        registeredListeners[event] = handler;
      }),
    };
  });

  // ── Exports ───────────────────────────────────────────────────────

  it('exports MODEL_DISPLAY_STATUS_KEY', () => {
    expect(MODEL_DISPLAY_STATUS_KEY).toBe('worklog-model');
  });

  it('exports registerModelDisplay as a function', () => {
    expect(typeof registerModelDisplay).toBe('function');
  });

  // ── Event registration ───────────────────────────────────────────

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

  // ── model_select behavior ────────────────────────────────────────

  it('model_select sets status to (pending) when no response yet', () => {
    registerModelDisplay(mockPi);
    const handler = registeredListeners['model_select'];

    handler({ model: { id: 'plan', provider: 'openai' } }, mockCtx);

    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith(
      'worklog-model',
      '(pending)',
    );
  });

  it('model_select without model id does not crash and does not set status', () => {
    registerModelDisplay(mockPi);
    const handler = registeredListeners['model_select'];

    handler({ model: null }, mockCtx);

    // No status call expected because there's nothing to display
    expect(mockCtx.ui.setStatus).not.toHaveBeenCalled();
  });

  it('model_select no longer shows model alias when after_provider_response was previously received', () => {
    registerModelDisplay(mockPi);
    const modelHandler = registeredListeners['model_select'];
    const responseHandler = registeredListeners['after_provider_response'];

    // First, receive a provider response
    responseHandler({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);
    expect(mockCtx.ui.setStatus).toHaveBeenLastCalledWith(
      'worklog-model',
      'openai/gpt-4',
    );

    // Then, select a model — should still show provider/model only (no model alias)
    modelHandler({ model: { id: 'plan' } }, mockCtx);
    expect(mockCtx.ui.setStatus).toHaveBeenLastCalledWith(
      'worklog-model',
      'openai/gpt-4',
    );
  });

  // ── after_provider_response behavior ──────────────────────────────

  it('after_provider_response extracts X-Resolved-Model from headers (no arrow prefix)', () => {
    registerModelDisplay(mockPi);
    const handler = registeredListeners['after_provider_response'];

    handler({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);

    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith(
      'worklog-model',
      'openai/gpt-4',
    );
  });

  it('after_provider_response handles uppercase X-Resolved-Model header', () => {
    registerModelDisplay(mockPi);
    const handler = registeredListeners['after_provider_response'];

    handler({ headers: { 'X-Resolved-Model': 'anthropic/claude-3' } }, mockCtx);

    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith(
      'worklog-model',
      'anthropic/claude-3',
    );
  });

  it('after_provider_response without resolved model header does not crash', () => {
    registerModelDisplay(mockPi);
    const handler = registeredListeners['after_provider_response'];

    handler({ headers: {} }, mockCtx);

    // No call expected because nothing to update
    expect(mockCtx.ui.setStatus).not.toHaveBeenCalled();
  });

  it('after_provider_response shows provider/model (no model alias) when model was previously selected', () => {
    registerModelDisplay(mockPi);
    const modelHandler = registeredListeners['model_select'];
    const responseHandler = registeredListeners['after_provider_response'];

    // First, select a model
    modelHandler({ model: { id: 'code' } }, mockCtx);

    // Then, receive a provider response
    responseHandler({ headers: { 'x-resolved-model': 'anthropic/claude-sonnet-4' } }, mockCtx);

    expect(mockCtx.ui.setStatus).toHaveBeenLastCalledWith(
      'worklog-model',
      'anthropic/claude-sonnet-4',
    );
  });

  // ── Status key verification ───────────────────────────────────────

  it('uses status key "worklog-model" not "model-display"', () => {
    registerModelDisplay(mockPi);
    const handler = registeredListeners['model_select'];

    handler({ model: { id: 'plan', provider: 'openai' } }, mockCtx);

    // Verify the old key is NOT used
    expect(statusCalls['model-display']).toBeUndefined();
    // Verify the new key IS used
    expect(statusCalls['worklog-model']).toBeDefined();
  });

  // ── Edge cases ───────────────────────────────────────────────────

  it('handles multiple model_select calls, staying in pending state', () => {
    registerModelDisplay(mockPi);
    const handler = registeredListeners['model_select'];

    handler({ model: { id: 'plan' } }, mockCtx);
    handler({ model: { id: 'code' } }, mockCtx);

    expect(mockCtx.ui.setStatus).toHaveBeenLastCalledWith(
      'worklog-model',
      '(pending)',
    );
  });

  it('handles multiple after_provider_response calls, overwriting previous resolved model', () => {
    registerModelDisplay(mockPi);
    const modelHandler = registeredListeners['model_select'];
    const responseHandler = registeredListeners['after_provider_response'];

    modelHandler({ model: { id: 'code' } }, mockCtx);
    responseHandler({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);
    responseHandler({ headers: { 'x-resolved-model': 'anthropic/claude-sonnet-4' } }, mockCtx);

    expect(mockCtx.ui.setStatus).toHaveBeenLastCalledWith(
      'worklog-model',
      'anthropic/claude-sonnet-4',
    );
  });

  it('after_provider_response with no prior model_select shows provider/model only', () => {
    registerModelDisplay(mockPi);
    const handler = registeredListeners['after_provider_response'];

    // Without any prior model_select
    handler({ headers: { 'x-resolved-model': 'openai/gpt-4' } }, mockCtx);

    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith(
      'worklog-model',
      'openai/gpt-4',
    );
  });
});
