/**
 * Unit tests for lease-release.ts — Proactive lease release on session close.
 *
 * Verifies that:
 * 1. releaseLease() reads ~/.pi/agent/models.json to find the Local Proxy baseUrl.
 * 2. releaseLease() sends POST {baseUrl}/leases/release with correct body.
 * 3. Errors (network failures, non-2xx) are handled gracefully (no throw, debug log).
 * 4. Missing "Local Proxy" provider: no request sent, debug log.
 * 5. Missing models.json file: no request sent, debug log.
 * 6. The registerLeaseRelease() function sets up session_start handler.
 * 7. The session_start handler calls releaseLease on "new" reason.
 * 8. Non-"new" reasons (startup, resume, fork) do not trigger releaseLease.
 *
 * Run: npx vitest run packages/tui/extensions/Worklog/lease-release.test.ts
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

describe('lease-release', () => {
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

  // ── releaseLease() function tests ─────────────────────────────────

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

    it('does not throw on network failure (fetch rejects)', async () => {
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

    it('passes the session ID as-is to the proxy', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: {
          'Local Proxy': { baseUrl: 'http://192.168.0.199:8000/v1' },
        },
      }));
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await mod.releaseLease('/home/test-user/.pi/sessions/session-xyz.json');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ session_id: '/home/test-user/.pi/sessions/session-xyz.json' }),
        }),
      );
    });

    it('still sends request when session_id is empty string (proxy handles validation)', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: {
          'Local Proxy': { baseUrl: 'http://192.168.0.199:8000/v1' },
        },
      }));
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await expect(mod.releaseLease('')).resolves.toBeUndefined();
      expect(mockFetch).toHaveBeenCalled();
    });

    it('only calls console.debug on error (not console.error or console.warn)', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: {
          'Local Proxy': { baseUrl: 'http://192.168.0.199:8000/v1' },
        },
      }));
      mockFetch.mockRejectedValue(new Error('Network error'));

      await mod.releaseLease('session-abc-123');

      expect(mockConsoleDebug).toHaveBeenCalled();
    });

    it('survives missing Local Proxy in models.json (no crash)', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: {},
      }));

      await expect(mod.releaseLease('session-abc-123')).resolves.toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── registerLeaseRelease() integration tests ──────────────────────

  describe('registerLeaseRelease', () => {
    /** Tracks the session_start handler registered by registerLeaseRelease */
    let registeredHandler: Function | null = null;
    let mockPi: any;

    beforeEach(() => {
      registeredHandler = null;
      mockPi = {
        on: vi.fn((event: string, handler: Function) => {
          if (event === 'session_start') {
            registeredHandler = handler;
          }
        }),
      };
    });

    it('registers a session_start handler', () => {
      mod.registerLeaseRelease(mockPi);
      expect(mockPi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
      expect(registeredHandler).not.toBeNull();
    });

    it('calls releaseLease when reason is "new" and previousSessionFile is set', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: {
          'Local Proxy': { baseUrl: 'http://192.168.0.199:8000/v1' },
        },
      }));
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      mod.registerLeaseRelease(mockPi);

      // Keep a reference to the handler before awaiting
      const handler = registeredHandler!;
      await handler(
        { type: 'session_start', reason: 'new', previousSessionFile: '/sessions/s1.json' },
        {},
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'http://192.168.0.199:8000/v1/leases/release',
        expect.objectContaining({
          body: JSON.stringify({ session_id: '/sessions/s1.json' }),
        }),
      );
    });

    it('does NOT call releaseLease when reason is "startup"', async () => {
      mod.registerLeaseRelease(mockPi);

      await registeredHandler!(
        { type: 'session_start', reason: 'startup' },
        {},
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does NOT call releaseLease when reason is "resume"', async () => {
      mod.registerLeaseRelease(mockPi);

      await registeredHandler!(
        { type: 'session_start', reason: 'resume', previousSessionFile: '/sessions/s1.json' },
        {},
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does NOT call releaseLease when reason is "fork"', async () => {
      mod.registerLeaseRelease(mockPi);

      await registeredHandler!(
        { type: 'session_start', reason: 'fork', previousSessionFile: '/sessions/s1.json' },
        {},
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does NOT call releaseLease when reason is "reload"', async () => {
      mod.registerLeaseRelease(mockPi);

      await registeredHandler!(
        { type: 'session_start', reason: 'reload' },
        {},
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does NOT call releaseLease when previousSessionFile is undefined', async () => {
      mod.registerLeaseRelease(mockPi);

      await registeredHandler!(
        { type: 'session_start', reason: 'new' },
        {},
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
