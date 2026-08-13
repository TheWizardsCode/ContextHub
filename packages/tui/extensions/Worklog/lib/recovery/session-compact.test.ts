/**
 * Tests for mid-session compaction auto-continue (session_compact event).
 *
 * Covers:
 * - shouldAutoContinueAfterCompaction — mid-session vs end-of-session
 *   classification, overflow (`willRetry: true`) exclusion, manual
 *   /compact semantics
 * - shouldTriggerCompactionContinue — abort / retry-mutex / continuation
 *   guards respected at the compaction entry point
 *
 * Session-switch guards (sessionGeneration capture + interruptible sleep)
 * are enforced inside the reused `triggerInvisibleContinue()` loop and are
 * covered by retry-loop.test.ts (interruptibleSleep).
 *
 * Run: cd /home/rgardler/projects/ContextHub && npx vitest run packages/tui/extensions/Worklog/lib/recovery/session-compact.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  shouldAutoContinueAfterCompaction,
  shouldTriggerCompactionContinue,
} from './recovery.js';

// ── shouldAutoContinueAfterCompaction ─────────────────────────────────

describe('shouldAutoContinueAfterCompaction', () => {
  // AC2: mid-session threshold compaction → auto-continue fires
  it('continues when queued messages are pending (pre-prompt threshold compaction)', () => {
    expect(shouldAutoContinueAfterCompaction(
      { reason: 'threshold', willRetry: false },
      { hasPendingMessages: true, isIdle: true, lastAssistantStopReason: undefined },
    )).toBe(true);
  });

  it('continues when the last assistant turn hit max output tokens (stopReason "length")', () => {
    expect(shouldAutoContinueAfterCompaction(
      { reason: 'threshold', willRetry: false },
      { hasPendingMessages: false, isIdle: true, lastAssistantStopReason: 'length' },
    )).toBe(true);
  });

  it('continues when the last assistant turn errored (stopReason "error")', () => {
    expect(shouldAutoContinueAfterCompaction(
      { reason: 'threshold', willRetry: false },
      { hasPendingMessages: false, isIdle: true, lastAssistantStopReason: 'error' },
    )).toBe(true);
  });

  it('continues when the agent was still running when compaction started', () => {
    expect(shouldAutoContinueAfterCompaction(
      { reason: 'threshold', willRetry: false },
      { hasPendingMessages: false, isIdle: false, lastAssistantStopReason: undefined },
    )).toBe(true);
  });

  // AC3: overflow compaction → no continuation (Pi retries the turn natively)
  it('never continues on overflow recovery (willRetry: true) — even with pending work', () => {
    expect(shouldAutoContinueAfterCompaction(
      { reason: 'overflow', willRetry: true },
      { hasPendingMessages: true, isIdle: false, lastAssistantStopReason: 'length' },
    )).toBe(false);
  });

  it('does not continue on overflow compaction without retry (completed turn)', () => {
    expect(shouldAutoContinueAfterCompaction(
      { reason: 'overflow', willRetry: false },
      { hasPendingMessages: false, isIdle: true, lastAssistantStopReason: 'stop' },
    )).toBe(false);
  });

  // AC4: end-of-session compaction → no auto-continue
  it('does not continue on end-of-session manual /compact after a completed turn', () => {
    expect(shouldAutoContinueAfterCompaction(
      { reason: 'manual', willRetry: false },
      { hasPendingMessages: false, isIdle: true, lastAssistantStopReason: 'stop' },
    )).toBe(false);
  });

  it('does not continue when the agent is settled with no assistant message', () => {
    expect(shouldAutoContinueAfterCompaction(
      { reason: 'manual', willRetry: false },
      { hasPendingMessages: false, isIdle: true, lastAssistantStopReason: undefined },
    )).toBe(false);
  });

  it('does not continue after an aborted turn (user-initiated stop)', () => {
    expect(shouldAutoContinueAfterCompaction(
      { reason: 'manual', willRetry: false },
      { hasPendingMessages: false, isIdle: true, lastAssistantStopReason: 'aborted' },
    )).toBe(false);
  });

  // Documented working assumption: manual /compact mid-session with pending work
  it('continues on manual /compact when demonstrably mid-session (pending work)', () => {
    expect(shouldAutoContinueAfterCompaction(
      { reason: 'manual', willRetry: false },
      { hasPendingMessages: true, isIdle: true, lastAssistantStopReason: 'stop' },
    )).toBe(true);
  });
});

// ── shouldTriggerCompactionContinue (guards) ──────────────────────────

describe('shouldTriggerCompactionContinue', () => {
  // AC5: user abort (ESC) respected
  it('does not continue when the user has aborted', () => {
    expect(shouldTriggerCompactionContinue({
      userAborted: true,
      continueInProgress: false,
      continuationInFlight: false,
    })).toBe(false);
  });

  // AC5: retry-loop mutex respected — no concurrent loop
  it('does not continue when a retry/continue loop is already in progress', () => {
    expect(shouldTriggerCompactionContinue({
      userAborted: false,
      continueInProgress: true,
      continuationInFlight: false,
    })).toBe(false);
  });

  // AC5: no double-trigger with the CONTEXT_LENGTH path
  it('does not continue when a continuation is already in flight', () => {
    expect(shouldTriggerCompactionContinue({
      userAborted: false,
      continueInProgress: false,
      continuationInFlight: true,
    })).toBe(false);
  });

  it('continues when all guards are clear', () => {
    expect(shouldTriggerCompactionContinue({
      userAborted: false,
      continueInProgress: false,
      continuationInFlight: false,
    })).toBe(true);
  });
});
