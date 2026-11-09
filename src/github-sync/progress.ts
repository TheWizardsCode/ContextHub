/**
 * src/github-sync/progress.ts — the single progress emitter of the github-sync
 * flows.
 *
 * Concern: turning the coarse `{phase, current, total}` progress events the
 * push and import flows emit into the richer `GithubProgress` shape the TUI
 * consumes — items-per-second rate, estimated time remaining and a snapshot of
 * the central throttler. One factory replaces the two near-identical private
 * emitters the flows used to carry, so the emitted shape and the rate/ETA
 * arithmetic are defined in exactly one place.
 *
 * Moved verbatim from `emitProgress` / `emitProgressImport` in
 * `src/github-sync.ts` (WL-0MW0JF6TH00749I2, child 3 of 8 of the
 * WL-0MVGKH9Z900178UF `src/github-sync.ts` decomposition). The per-phase start
 * time, the `Number.isFinite` rate guard and the throttler snapshot fields are
 * unchanged. This module depends only on `./types.js` and never on the
 * `./github-sync.js` barrel.
 */

import type { GithubProgress } from './types.js';

/**
 * The raw statistics the central throttler exposes via `getStats()`.
 *
 * Only the subset surfaced on {@link GithubProgress.throttler} is required;
 * extra throttler fields (e.g. retry counters) are ignored.
 */
export type ThrottlerStats = {
  active: number;
  queueLength: number;
  tokens?: number;
  rate?: number;
  burst?: number;
  concurrency?: number;
};

/** The consumer callback a flow passes when it wants progress events. */
export type ProgressCallback = (progress: GithubProgress) => void;

/**
 * A progress emitter bound to one flow's per-phase statistics.
 *
 * Mirrors the historical private emitter signature, with the (optional)
 * consumer callback supplied per call so one factory can serve both flows.
 */
export type ProgressEmitter = (
  onProgress: ProgressCallback | undefined,
  phase: GithubProgress['phase'],
  current: number,
  total: number,
  note?: string,
  lastError?: string | null
) => void;

/**
 * Create a progress emitter that tracks its own per-phase start time.
 *
 * The factory closes over a per-phase stats map, so the first event of each
 * phase starts that phase's clock and every later event reuses it — rate and
 * ETA are therefore measured from the phase's first event, exactly as before.
 *
 * @param getStats - reads the current throttler statistics; called on every
 *   emitted event and swallowed if it throws.
 * @returns the emitter; it is a no-op when no consumer callback is supplied.
 */
export function createProgressEmitter(
  getStats: () => ThrottlerStats | undefined | null
): ProgressEmitter {
  const stats = new Map<string, { start: number; lastEmit: number }>();

  return (onProgress, phase, current, total, note, lastError) => {
    if (!onProgress) return;
    const now = Date.now();
    let st = stats.get(phase as string);
    if (!st) {
      st = { start: now, lastEmit: 0 };
      stats.set(phase as string, st);
    }
    const elapsedMs = Math.max(1, now - st.start);
    const rate = current > 0 ? (current / (elapsedMs / 1000)) : 0;
    const remaining = Math.max(0, total - current);
    const etaMs = rate > 0 ? Math.round((remaining / rate) * 1000) : null;
    let throttlerSnapshot: GithubProgress['throttler'] = null;
    try {
      const s = getStats();
      if (s) {
        throttlerSnapshot = {
          active: s.active,
          queueLength: s.queueLength,
          tokens: s.tokens,
          rate: s.rate,
          burst: s.burst,
          concurrency: s.concurrency,
        };
      }
    } catch (_) {}
    try {
      onProgress({
        phase,
        current,
        total,
        rate: Number.isFinite(rate) ? rate : undefined,
        etaMs,
        note,
        lastError: lastError ?? null,
        throttler: throttlerSnapshot,
      });
    } catch (_) {}
    st.lastEmit = now;
  };
}
