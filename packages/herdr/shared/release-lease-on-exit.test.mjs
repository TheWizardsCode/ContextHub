/**
 * Unit tests for packages/herdr/shared/release-lease-on-exit.mjs
 * (WL-0MSGI7UIH008USVB).
 *
 * The script is the thin executor the Herdr pane wrapper
 * (run-pi-agent.sh) invokes when a pi session ends. Its only job is to
 * forward the pane's session id to the shared `releaseLease()`
 * implementation in `@worklog/shared/lease-release` — the same code path
 * the Pi extension uses (the HTTP contract itself is covered by
 * packages/shared/src/lease-release.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the shared lease-release module ───────────────────────────────

const mockReleaseLease = vi.fn();
vi.mock('@worklog/shared/lease-release', () => ({
  releaseLease: mockReleaseLease,
}));

// ── Module under test (loaded lazily) ─────────────────────────────────

const { releaseLeaseOnExit } = await import('./release-lease-on-exit.mjs');

describe('release-lease-on-exit.mjs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards the session id to the shared releaseLease', async () => {
    await releaseLeaseOnExit('herdr-1723456789-1234-5678');
    expect(mockReleaseLease).toHaveBeenCalledWith('herdr-1723456789-1234-5678', {
      timeoutMs: expect.any(Number),
    });
  });

  it('passes a bounded timeout so a hung fetch never delays pane teardown', async () => {
    await releaseLeaseOnExit('herdr-1723456789-1234-5678');
    const timeoutMs = mockReleaseLease.mock.calls[0][1].timeoutMs;
    expect(typeof timeoutMs).toBe('number');
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(60_000);
  });

  it('does nothing when the session id is empty', async () => {
    await releaseLeaseOnExit('');
    expect(mockReleaseLease).not.toHaveBeenCalled();
  });

  it('does nothing when the session id is undefined', async () => {
    await releaseLeaseOnExit(undefined);
    expect(mockReleaseLease).not.toHaveBeenCalled();
  });

  it('swallows errors from the shared releaseLease (never throws)', async () => {
    mockReleaseLease.mockRejectedValue(new Error('boom'));
    await expect(releaseLeaseOnExit('s1')).resolves.toBeUndefined();
  });
});
