/**
 * Unit tests for packages/shared/src/lease-release.ts — the shared Local
 * Proxy model-lease release helper (WL-0MSGI7UIH008USVB).
 *
 * The helper is the single implementation shared by:
 *   - the Pi extension  (packages/tui/extensions/Worklog/lease-release.ts)
 *   - the Herdr plugin's pane-close release executor
 *     (packages/herdr/shared/release-lease-on-exit.mjs)
 *
 * Verifies that:
 * 1. releaseLease() reads ~/.pi/agent/models.json to find the Local Proxy baseUrl.
 * 2. releaseLease() sends POST {baseUrl}/leases/release with correct body.
 * 3. The base URL is cached at module level (no repeated filesystem reads),
 *    and _resetLeaseReleaseState() clears the cache.
 * 4. Errors (network failures, non-2xx) are handled gracefully
 *    (no throw, debug log only).
 * 5. Missing "Local Proxy" provider / missing models.json file: no request.
 *
 * Run: npx vitest run packages/shared/src/lease-release.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

// ── Mock node:fs/promises ────────────────────────────────────────────

const mockReadFile = vi.fn();
vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

// ── Mock global fetch ────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Mock console.debug ───────────────────────────────────────────────

const mockConsoleDebug = vi.fn();
const origConsoleDebug = console.debug;

// ── Module under test (loaded lazily) ────────────────────────────────

let mod: typeof import('./lease-release.js');

describe('shared lease-release', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.HOME = '/home/test-user';
    // Patch console.debug for this test
    console.debug = mockConsoleDebug;
    // Re-import fresh each test so module-level state is reset
    mod = await import('./lease-release.js');
    mod._resetLeaseReleaseState();
  });

  afterEach(() => {
    console.debug = origConsoleDebug;
  });

  afterAll(() => {
    console.debug = origConsoleDebug;
  });

  describe('releaseLease', () => {
    it('reads models.json and sends POST to correct endpoint with session ID', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: {
          'Local Proxy': { baseUrl: 'http://192.168.0.199:8000/v1' },
        },
      }));
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await mod.releaseLease('session-abc-123');

      expect(mockReadFile).toHaveBeenCalledWith(
        '/home/test-user/.pi/agent/models.json',
        'utf-8',
      );
      expect(mockFetch).toHaveBeenCalledWith(
        'http://192.168.0.199:8000/v1/leases/release',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: 'session-abc-123' }),
        }),
      );
    });

    it('strips a trailing slash from the baseUrl before appending the path', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: {
          'Local Proxy': { baseUrl: 'http://192.168.0.199:8000/v1/' },
        },
      }));
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await mod.releaseLease('s1');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://192.168.0.199:8000/v1/leases/release',
        expect.any(Object),
      );
    });

    it('does not throw on network failure (fetch rejects) and logs at debug level', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: {
          'Local Proxy': { baseUrl: 'http://192.168.0.199:8000/v1' },
        },
      }));
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(mod.releaseLease('session-abc-123')).resolves.toBeUndefined();
      expect(mockConsoleDebug).toHaveBeenCalled();
    });

    it('does not throw on non-2xx response', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: {
          'Local Proxy': { baseUrl: 'http://192.168.0.199:8000/v1' },
        },
      }));
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      await expect(mod.releaseLease('session-abc-123')).resolves.toBeUndefined();
      expect(mockConsoleDebug).toHaveBeenCalled();
    });

    it('does not send request when "Local Proxy" provider is missing', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: {
          'Other Provider': { baseUrl: 'http://other:8000/v1' },
        },
      }));

      await mod.releaseLease('session-abc-123');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not send request when models.json cannot be read', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT: file not found'));

      await mod.releaseLease('session-abc-123');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockConsoleDebug).toHaveBeenCalled();
    });

    it('does not send request when Local Proxy provider has no baseUrl', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: {
          'Local Proxy': {},
        },
      }));

      await mod.releaseLease('session-abc-123');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not send request when models.json is not valid JSON', async () => {
      mockReadFile.mockResolvedValue('not json at all');

      await mod.releaseLease('session-abc-123');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('aborts the request when timeoutMs is provided and the fetch hangs', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: {
          'Local Proxy': { baseUrl: 'http://192.168.0.199:8000/v1' },
        },
      }));
      // Simulate a fetch that never resolves but respects the abort signal.
      mockFetch.mockImplementation((_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          );
        }),
      );

      await mod.releaseLease('session-abc-123', { timeoutMs: 50 });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      // Failure is swallowed — debug log only, never throws.
      expect(mockConsoleDebug).toHaveBeenCalled();
    });

    it('passes the session ID as-is to the proxy', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: {
          'Local Proxy': { baseUrl: 'http://192.168.0.199:8000/v1' },
        },
      }));
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await mod.releaseLease('herdr-1723456789-1234-5678');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ session_id: 'herdr-1723456789-1234-5678' }),
        }),
      );
    });

    it('skips the request when session_id is empty (proxy would 400)', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: {
          'Local Proxy': { baseUrl: 'http://192.168.0.199:8000/v1' },
        },
      }));

      await expect(mod.releaseLease('')).resolves.toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('skips the request when session_id is whitespace only', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: {
          'Local Proxy': { baseUrl: 'http://192.168.0.199:8000/v1' },
        },
      }));

      await mod.releaseLease('   ');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('only calls console.debug on error (not console.error or console.warn)', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: {
          'Local Proxy': { baseUrl: 'http://192.168.0.199:8000/v1' },
        },
      }));
      mockFetch.mockRejectedValue(new Error('Network error'));
      const mockConsoleError = vi.fn();
      const origConsoleError = console.error;
      console.error = mockConsoleError;

      await mod.releaseLease('session-abc-123');

      expect(mockConsoleDebug).toHaveBeenCalled();
      expect(mockConsoleError).not.toHaveBeenCalled();
      console.error = origConsoleError;
    });
  });

  describe('module-level baseUrl cache', () => {
    it('reuses the cached baseUrl on subsequent calls (single file read)', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: {
          'Local Proxy': { baseUrl: 'http://192.168.0.199:8000/v1' },
        },
      }));
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await mod.releaseLease('s1');
      await mod.releaseLease('s2');

      expect(mockReadFile).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('re-reads models.json after _resetLeaseReleaseState() clears the cache', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: {
          'Local Proxy': { baseUrl: 'http://192.168.0.199:8000/v1' },
        },
      }));
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await mod.releaseLease('s1');
      mod._resetLeaseReleaseState();
      await mod.releaseLease('s2');

      expect(mockReadFile).toHaveBeenCalledTimes(2);
    });

    it('caches a negative result (no provider) without re-reading', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ providers: {} }));

      await mod.releaseLease('s1');
      await mod.releaseLease('s2');

      expect(mockReadFile).toHaveBeenCalledTimes(1);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
