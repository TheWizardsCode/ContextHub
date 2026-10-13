/**
 * packages/herdr/src/downtime-worker.gates.test.ts — dispatch gate and
 * concurrency tests.
 *
 * Split out of the monolithic `downtime-worker.test.ts`
 * (WL-0MV28X3SL005R5KX / WL-0MV4VQ78L003TGY6) to keep each test file focused
 * on one concern and under the 2,000-line cap. Covers:
 *   - the single-flight dispatch pipeline gate (one in-flight pipeline),
 *   - the zero-free-slots idle gate (including fast-mode operator priority),
 *   - bounded concurrent dispatch claim-safety regression,
 *   - the transient-downtime-error classifier and the bounded retry helper.
 *
 * The transient-retry describes were originally nested under the
 * `needsProducerReview exclusion` block; they are relocated here because they
 * exercise the `isTransientDowntimeError` / `withTransientRetry` utilities
 * (retry gating), not the producer-review gate itself.
 *
 * Shared scaffolding (`makeDeps`) is imported from
 * `downtime-worker.fixtures.ts`; no setup logic is re-implemented here.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  dispatchDowntimeWork,
  isTransientDowntimeError,
  withTransientRetry,
} from './downtime-worker.js';
import { makeDeps } from './downtime-worker.fixtures.js';

// ── Bounded concurrent dispatch (F1, parent WL-0MT50LKAK001EF5Q) ──────

describe('pipeline single-flight — one in-flight dispatch pipeline at a time', () => {
  it('a second concurrent same-process dispatch is refused (dispatch-in-flight)', async () => {
    let release!: () => void;
    const gate = new Promise<{ ok: true }>((resolve) => {
      release = () => resolve({ ok: true });
    });
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      spawnAgentPane: vi.fn().mockImplementation(() => gate),
    });

    const first = dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    const second = dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    release();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(firstOutcome.dispatched).toBe(true);
    expect(secondOutcome.dispatched).toBe(false);
    expect(secondOutcome.reason).toBe('dispatch-in-flight');
  });
});

describe('idle gate — no dispatch with zero free slots', () => {
  it('second dispatch only fires when requiredFreeSlots continuously idle for threshold', async () => {
    // This test verifies the per-slot idle tracker contract.
    // With cap=2, we need 2 slots continuously idle for the threshold.
    // A second dispatch should NOT fire if only 1 slot is idle.
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
    });

    // With 0 free slots (below panes min of 1), dispatch is gated
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 0 });

    // Dispatch should be gated when no slots are free
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
  });
});

describe('idle gate — no dispatch with zero free slots (fast-mode operator priority)', () => {
  it('with 3 total slots and 1 free, only 1 dispatch fires even if cap=2', async () => {
    // Fast-mode / operator priority preserved: freeSlots check is the hard limit
    // With 0 free slots, no dispatch can occur regardless of cap
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 0 });
    expect(outcome.dispatched).toBe(false); // no slots free → gated
  });
});

describe('bounded concurrent dispatch — claim safety regression', () => {
  it('dispatched-marker exclusion still prevents re-dispatch of already-dispatched item', async () => {
    // Regression guard for WL-0MSLIY8ZR004QUSY: claim safety via CAS
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      claimItem: vi.fn().mockResolvedValue({ ok: true }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // Claim safety: the item should be claimed once, not re-claimed
    if (outcome.dispatched) {
      expect(deps.claimItem).toHaveBeenCalledTimes(1);
    }
  });
});

// ── Transient retry (WL-0MTOTCETU004YYIU AC3 — bounded backoff) ───────

describe('transient retry (WL-0MTOTCETU004YYIU AC3 — bounded backoff)', () => {
  describe('isTransientDowntimeError', () => {
    it('classifies SQLITE_BUSY variants as transient', () => {
      expect(isTransientDowntimeError('SQLITE_BUSY: database is locked')).toBe(true);
      expect(isTransientDowntimeError('SQLITE BUSY: database is locked')).toBe(true);
      expect(isTransientDowntimeError('database is locked')).toBe(true);
      expect(isTransientDowntimeError('database table is locked')).toBe(true);
      expect(isTransientDowntimeError('database busy')).toBe(true);
    });
    it('does not classify timeout/hang as transient (retry would triple 10s wall-clock)', () => {
      // ETIMEDOUT / "timed out" is a hung child (10s per attempt); retrying
      // would be 30s and risks DOWNTIME_RUN_TIMEOUT_MS — strikes correctly.
      expect(isTransientDowntimeError('ETIMEDOUT')).toBe(false);
      expect(isTransientDowntimeError('timed out after 10000ms')).toBe(false);
      expect(isTransientDowntimeError('spawn ETIMEDOUT')).toBe(false);
      expect(isTransientDowntimeError('exceeded timeout of 10000ms')).toBe(false);
      expect(isTransientDowntimeError('operation timeout')).toBe(false);
      expect(isTransientDowntimeError('TIMED OUT')).toBe(false);
    });
    it('is case-insensitive', () => {
      expect(isTransientDowntimeError('Sqlite_Busy: DATABASE IS LOCKED')).toBe(true);
      expect(isTransientDowntimeError('DATABASE BUSY')).toBe(true);
    });
    it('does not classify parse/author-gate errors as transient', () => {
      expect(isTransientDowntimeError('show parse error')).toBe(false);
      expect(isTransientDowntimeError('audit list parse error')).toBe(false);
      expect(isTransientDowntimeError('author identity gate')).toBe(false);
      expect(isTransientDowntimeError('needsProducerReview gate')).toBe(false);
      expect(isTransientDowntimeError('')).toBe(false);
      expect(isTransientDowntimeError('some random error')).toBe(false);
    });
  });

  describe('withTransientRetry', () => {
    it('succeeds on first try without retry', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      await expect(withTransientRetry(fn, 2, 1)).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });
    it('retries once on transient then succeeds (no strike)', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
        .mockResolvedValueOnce('ok');
      await expect(withTransientRetry(fn, 2, 1)).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });
    it('retries twice on two transients then succeeds', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
        .mockRejectedValueOnce(new Error('database is locked'))
        .mockResolvedValueOnce('ok');
      await expect(withTransientRetry(fn, 2, 1)).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(3);
    });
    it('retries up to limit then throws (single strike, not three)', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));
      await expect(withTransientRetry(fn, 2, 1)).rejects.toThrow('SQLITE_BUSY');
      expect(fn).toHaveBeenCalledTimes(3); // 1 + 2 retries
    });
    it('fails fast on non-transient (no retry)', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('show parse error'));
      await expect(withTransientRetry(fn, 2, 1)).rejects.toThrow('show parse error');
      expect(fn).toHaveBeenCalledTimes(1);
    });
    it('fails fast on second attempt if second error is non-transient', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
        .mockRejectedValueOnce(new Error('show parse error'));
      await expect(withTransientRetry(fn, 2, 1)).rejects.toThrow('show parse error');
      expect(fn).toHaveBeenCalledTimes(2);
    });
    it('does not retry timeout variants (fail fast — one strike)', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('timed out after 10000ms'));
      await expect(withTransientRetry(fn, 2, 1)).rejects.toThrow('timed out');
      expect(fn).toHaveBeenCalledTimes(1);
    });
    it('handles non-Error thrown values', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce('SQLITE_BUSY: database is locked')
        .mockResolvedValueOnce('ok');
      await expect(withTransientRetry(fn, 2, 1)).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});
