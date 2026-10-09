/**
 * tests/herdr/fetcher-memo.test.ts — In-process fetch memoization (F4)
 *
 * Verifies that racing identical `runWl` read fetches within one process
 * share a single in-flight promise (spawning `wl` once), while sequential
 * reads, writes, different args, and worklog-dir changes always spawn fresh.
 *
 * All `fetchItemsByStage` calls use valid CLI stages: since
 * WL-0MUY1CRS7001UTQJ, invalid/removed stages are rejected without spawning
 * `wl`, so a bogus stage could not exercise the memo at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  fetchItemsByStage,
  fetchItemsByPriority,
  claimWorkItem,
  setExecFileAsync,
  resetExecFileAsync,
  setWorklogDir,
  resetWorklogDir,
  clearFetchMemo,
  _fetchMemoSize,
} from '../../packages/herdr/src/fetcher.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const EMPTY_OUTPUT = JSON.stringify({ results: [], workItems: [] });

function installMock() {
  return vi.fn().mockResolvedValue({ stdout: EMPTY_OUTPUT });
}

describe('in-process fetch memoization (F4)', () => {
  beforeEach(() => {
    resetExecFileAsync();
    resetWorklogDir();
    clearFetchMemo();
  });

  afterEach(() => {
    clearFetchMemo();
    resetWorklogDir();
    resetExecFileAsync();
  });

  it('AC1: two racing identical fetches spawn wl once and share the result', async () => {
    const d = deferred<{ stdout: string }>();
    const mock = vi.fn().mockReturnValue(d.promise);
    setExecFileAsync(mock as any);

    const p1 = fetchItemsByStage('plan_complete');
    const p2 = fetchItemsByStage('plan_complete'); // identical, concurrent

    expect(mock).toHaveBeenCalledTimes(1); // ONE spawn for both

    d.resolve({ stdout: EMPTY_OUTPUT });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
  });

  it('sequential identical fetches both spawn (memo only dedupes concurrent)', async () => {
    const mock = installMock();
    setExecFileAsync(mock as any);

    await fetchItemsByStage('plan_complete');
    await fetchItemsByStage('plan_complete');
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('a write between two reads prevents sharing (memo never serves across DB writes)', async () => {
    const d = deferred<{ stdout: string }>();
    const mock = vi.fn().mockReturnValueOnce(d.promise).mockResolvedValue({ stdout: EMPTY_OUTPUT });
    setExecFileAsync(mock as any);

    const read1 = fetchItemsByStage('plan_complete'); // in-flight read
    const claim = await claimWorkItem('WL-X', 'alice'); // write → clears memo
    expect(claim.success).toBe(true);
    const read2 = fetchItemsByStage('plan_complete'); // must spawn fresh, not share read1

    expect(mock).toHaveBeenCalledTimes(3); // read + write + read

    d.resolve({ stdout: EMPTY_OUTPUT });
    await Promise.all([read1, read2]);
  });

  it('different args (different stage) are not deduplicated', async () => {
    const d1 = deferred<{ stdout: string }>();
    const d2 = deferred<{ stdout: string }>();
    const mock = vi.fn().mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    setExecFileAsync(mock as any);

    const p1 = fetchItemsByStage('plan_complete');
    const p2 = fetchItemsByStage('intake_complete');
    expect(mock).toHaveBeenCalledTimes(2);

    d1.resolve({ stdout: EMPTY_OUTPUT });
    d2.resolve({ stdout: EMPTY_OUTPUT });
    await Promise.all([p1, p2]);
  });

  it('setWorklogDir changes isolate the memo (no cross-dir sharing)', async () => {
    const d1 = deferred<{ stdout: string }>();
    const d2 = deferred<{ stdout: string }>();
    const mock = vi.fn().mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    setExecFileAsync(mock as any);

    setWorklogDir('/projA/.worklog');
    const p1 = fetchItemsByStage('plan_complete');
    setWorklogDir('/projB/.worklog'); // dir change clears the memo
    const p2 = fetchItemsByStage('plan_complete'); // same args, different dir → fresh spawn

    expect(mock).toHaveBeenCalledTimes(2);
    d1.resolve({ stdout: EMPTY_OUTPUT });
    d2.resolve({ stdout: EMPTY_OUTPUT });
    await Promise.all([p1, p2]);
  });

  it('memo stays bounded under many concurrent distinct fetches', async () => {
    const deferreds: Array<ReturnType<typeof deferred<{ stdout: string }>>> = [];
    const mock = vi.fn(() => {
      const d = deferred<{ stdout: string }>();
      deferreds.push(d);
      return d.promise;
    });
    setExecFileAsync(mock as any);

    const promises = [];
    // 70 distinct fetches via the priority axis (which has no stage guard);
    // each distinct arg must spawn its own `wl` process.
    for (let i = 0; i < 70; i++) {
      promises.push(fetchItemsByPriority(`prio-${i}`));
    }
    // 70 distinct in-flight fetches: none deduped, memo capped at 64.
    expect(mock).toHaveBeenCalledTimes(70);
    expect(_fetchMemoSize()).toBeLessThanOrEqual(64);

    for (const d of deferreds) d.resolve({ stdout: EMPTY_OUTPUT });
    await Promise.all(promises);
    expect(_fetchMemoSize()).toBe(0); // settled entries removed
  });
});
