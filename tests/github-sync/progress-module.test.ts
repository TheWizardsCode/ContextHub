/**
 * tests/github-sync/progress-module.test.ts — behaviour of the extracted
 * `src/github-sync/progress.ts` factory.
 *
 * `createProgressEmitter` replaced the two near-identical private emitters in
 * `src/github-sync.ts` (WL-0MW0JF6TH00749I2, child 3 of 8). These tests pin the
 * contract the flows rely on: the emitted `GithubProgress` shape, the
 * per-phase rate/ETA arithmetic, the throttler snapshot mapping and the
 * no-callback / throwing-consumer safety. Fake timers make the arithmetic
 * deterministic.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import type { GithubProgress } from '../../src/github-sync/types.js';
import {
  createProgressEmitter,
  type ThrottlerStats,
} from '../../src/github-sync/progress.js';

const START = new Date('2025-01-01T00:00:00.000Z');

function useClockAt(iso: string): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createProgressEmitter', () => {
  it('is a no-op when no progress callback is supplied', () => {
    const getStats = vi.fn(() => ({ active: 0, queueLength: 0 }));
    const emit = createProgressEmitter(getStats);

    expect(() => emit(undefined, 'push', 1, 10)).not.toThrow();
    expect(getStats).not.toHaveBeenCalled();
  });

  it('emits the documented GithubProgress shape', () => {
    useClockAt(START.toISOString());
    const events: GithubProgress[] = [];
    const emit = createProgressEmitter(() => undefined);

    emit((p) => events.push(p), 'push', 0, 10, 'starting', 'boom');

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      phase: 'push',
      current: 0,
      total: 10,
      rate: 0,
      etaMs: null,
      note: 'starting',
      lastError: 'boom',
      throttler: null,
    });
  });

  it('defaults lastError to null and leaves note undefined when omitted', () => {
    useClockAt(START.toISOString());
    const events: GithubProgress[] = [];
    const emit = createProgressEmitter(() => undefined);

    emit((p) => events.push(p), 'import', 1, 5);

    expect(events[0].lastError).toBeNull();
    expect(events[0].note).toBeUndefined();
  });

  it('computes rate and ETA from the phase start time', () => {
    useClockAt(START.toISOString());
    const events: GithubProgress[] = [];
    const emit = createProgressEmitter(() => undefined);

    // First event starts the phase clock; no measurable rate yet.
    emit((p) => events.push(p), 'push', 0, 10);
    // 1 s later, 5 of 10 done → 5 items/s, 5 remaining → ETA 1000 ms.
    vi.advanceTimersByTime(1000);
    emit((p) => events.push(p), 'push', 5, 10);

    expect(events[0].rate).toBe(0);
    expect(events[0].etaMs).toBeNull();
    expect(events[1].rate).toBe(5);
    expect(events[1].etaMs).toBe(1000);
  });

  it('measures each phase from its own first event', () => {
    useClockAt(START.toISOString());
    const events: GithubProgress[] = [];
    const emit = createProgressEmitter(() => undefined);

    emit((p) => events.push(p), 'push', 0, 4);
    vi.advanceTimersByTime(1000);
    // Import's clock starts here, so its rate is measured over 1 s from now.
    emit((p) => events.push(p), 'import', 1, 2);
    vi.advanceTimersByTime(1000);
    emit((p) => events.push(p), 'import', 2, 2);

    const importEvents = events.filter((e) => e.phase === 'import');
    expect(importEvents[0].rate).toBe(1000); // 1 item / 0.001 s floor at t0
    expect(importEvents[0].etaMs).toBe(1); // 1 remaining at 1000 items/s → 1 ms
    expect(importEvents[1].rate).toBe(2); // 2 items over 1 s
    expect(importEvents[1].etaMs).toBe(0);
  });

  it('maps the throttler statistics onto the snapshot fields', () => {
    useClockAt(START.toISOString());
    const stats: ThrottlerStats = {
      active: 2,
      queueLength: 3,
      tokens: 4,
      rate: 5,
      burst: 6,
      concurrency: 7,
    };
    const events: GithubProgress[] = [];
    const emit = createProgressEmitter(() => stats);

    emit((p) => events.push(p), 'push', 1, 2);

    expect(events[0].throttler).toEqual({
      active: 2,
      queueLength: 3,
      tokens: 4,
      rate: 5,
      burst: 6,
      concurrency: 7,
    });
  });

  it('still emits when reading throttler statistics throws', () => {
    useClockAt(START.toISOString());
    const events: GithubProgress[] = [];
    const emit = createProgressEmitter(() => {
      throw new Error('throttler unavailable');
    });

    expect(() => emit((p) => events.push(p), 'push', 1, 2)).not.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0].throttler).toBeNull();
  });

  it('swallows a throwing consumer callback', () => {
    useClockAt(START.toISOString());
    const emit = createProgressEmitter(() => undefined);

    expect(() =>
      emit(() => {
        throw new Error('consumer blew up');
      }, 'push', 1, 2),
    ).not.toThrow();
  });

  it('omits a non-finite rate (Number.isFinite guard)', () => {
    vi.useFakeTimers();
    vi.spyOn(Date, 'now').mockReturnValue(Number.NaN);
    const events: GithubProgress[] = [];
    const emit = createProgressEmitter(() => undefined);

    emit((p) => events.push(p), 'push', 5, 10);

    expect(events[0].rate).toBeUndefined();
  });
});
