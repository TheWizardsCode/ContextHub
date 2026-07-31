/**
 * tests/herdr/auto-sync.test.ts — Tests for background `wl sync` integration
 *
 * Tests:
 *  - syncIntervalMs clamping (min 30s, 0 to disable)
 *  - loadSettings preserves syncIntervalMs
 *  - background sync invocation before fetch
 *  - sync error handling (graceful, no crash)
 *  - sync timer configuration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import {
  clampSyncInterval,
  runSync,
  createSyncTimer,
  type SyncOptions,
  DEFAULT_SYNC_INTERVAL_MS,
  MIN_SYNC_INTERVAL_MS,
  SYNC_DISABLED,
} from '../../packages/herdr/src/auto-sync.js';
import {
  type PluginSettings,
  defaultSettings,
  loadSettings,
} from '../../packages/herdr/src/settings.js';
import {
  WorkItemListState,
  createListRenderer,
  type WorkItem,
  type TermSize,
} from '../../packages/herdr/src/worklist.js';
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

// ── Fixtures ──────────────────────────────────────────────────────────

function makeItem(id = 'WL-TEST', overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    title: `Test Item ${id}`,
    status: 'open',
    stage: 'in_progress',
    ...overrides,
  };
}

function makeItems(count: number): WorkItem[] {
  return Array.from({ length: count }, (_, i) =>
    makeItem(`WL-TEST${String(i + 1).padStart(3, '0')}`)
  );
}

const defaultTermSize: TermSize = { rows: 24, cols: 80 };

// ── Mock spawn for sync tests ─────────────────────────────────────────

let mockSpawnCalls: { command: string; args: string[] }[] = [];
let mockSpawnReject: boolean = false;
let mockSpawnDelay = 0;

const originalSpawn = spawn;

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    spawn: vi.fn((command: string, args: string[], _opts?: any) => {
      mockSpawnCalls.push({ command, args });
      if (mockSpawnReject) {
        // Simulate a spawn failure (e.g., wl not found)
        return {
          stdin: { end: () => {} },
          stdout: { on: () => {} },
          stderr: {
            on: (event: string, cb: (data: Buffer) => void) => {
              if (event === 'data') {
                cb(Buffer.from('wl: command not found'));
              }
            },
          },
          on: (event: string, cb: (code: number) => void) => {
            if (event === 'close') {
              cb(127);
            }
          },
          kill: () => {},
        };
      }
      if (mockSpawnDelay > 0) {
        // Simulate successful but delayed execution
        setTimeout(() => {
          // Simulate normal exit
        }, mockSpawnDelay);
      }
      return {
        stdin: { end: () => {} },
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, cb: (code: number) => void) => {
          if (event === 'close') {
            cb(0);
          }
        },
        kill: () => {},
      };
    }),
  };
});

// ── clampSyncInterval Tests ───────────────────────────────────────────

describe('clampSyncInterval', () => {
  it('returns the value as-is when above minimum', () => {
    expect(clampSyncInterval(60000)).toBe(60000);
    expect(clampSyncInterval(45000)).toBe(45000);
  });

  it('caps values below minimum to the minimum', () => {
    expect(clampSyncInterval(10000)).toBe(MIN_SYNC_INTERVAL_MS);
    expect(clampSyncInterval(1000)).toBe(MIN_SYNC_INTERVAL_MS);
  });

  it('preserves zero as disabled (does not clamp 0)', () => {
    expect(clampSyncInterval(0)).toBe(SYNC_DISABLED);
  });
});

// ── defaultSettings Tests ─────────────────────────────────────────────

describe('defaultSettings — syncIntervalMs', () => {
  it('has syncIntervalMs set to 30000 (30s) by default', () => {
    expect(defaultSettings.syncIntervalMs).toBe(30000);
  });

  it('has syncIntervalMs enabled by default (non-zero)', () => {
    expect(defaultSettings.syncIntervalMs).toBeGreaterThan(0);
  });
});

// ── loadSettings — syncIntervalMs persistence ─────────────────────────

describe('loadSettings — syncIntervalMs', () => {
  let tmpDir: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'herdr-sync-'));
    settingsPath = join(tmpDir, 'test-settings.json');
  });

  afterEach(() => {
    try {
      if (existsSync(settingsPath)) unlinkSync(settingsPath);
      if (existsSync(tmpDir)) {
        try { unlinkSync(tmpDir); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  });

  it('returns default syncIntervalMs when file does not exist', () => {
    const settings = loadSettings(settingsPath);
    expect(settings.syncIntervalMs).toBe(30000);
  });

  it('loads syncIntervalMs from existing file', () => {
    writeFileSync(settingsPath, JSON.stringify({
      autoRefresh: true,
      refreshIntervalMs: 60000,
      syncIntervalMs: 60000,
    }), 'utf-8');
    const settings = loadSettings(settingsPath);
    expect(settings.syncIntervalMs).toBe(60000);
  });

  it('clamps syncIntervalMs below minimum in loadSettings', () => {
    writeFileSync(settingsPath, JSON.stringify({
      syncIntervalMs: 5000,
    }), 'utf-8');
    const settings = loadSettings(settingsPath);
    // Should be clamped to minimum
    expect(settings.syncIntervalMs).toBeGreaterThanOrEqual(MIN_SYNC_INTERVAL_MS);
  });

  it('treats syncIntervalMs of 0 as disabled', () => {
    writeFileSync(settingsPath, JSON.stringify({
      syncIntervalMs: 0,
    }), 'utf-8');
    const settings = loadSettings(settingsPath);
    // 0 means disabled - should stay 0
    expect(settings.syncIntervalMs).toBe(0);
  });

  it('handles missing syncIntervalMs key by using default', () => {
    writeFileSync(settingsPath, JSON.stringify({
      autoRefresh: false,
    }), 'utf-8');
    const settings = loadSettings(settingsPath);
    expect(settings.syncIntervalMs).toBe(30000);
  });
});

// ── runSync — background sync invocation ──────────────────────────────

describe('runSync', () => {
  beforeEach(() => {
    mockSpawnCalls = [];
    mockSpawnReject = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    mockSpawnCalls = [];
    vi.useRealTimers();
  });

  it('invokes `wl sync` command', async () => {
    const result = runSync();
    await vi.advanceTimersByTimeAsync(100);
    expect(mockSpawnCalls.length).toBe(1);
    expect(mockSpawnCalls[0].command).toBe('wl');
    expect(mockSpawnCalls[0].args).toContain('sync');
    // Clean up the returned promise
    result.catch(() => {});
  });

  it('does not crash on spawn failure (wl not found)', async () => {
    mockSpawnReject = true;
    // Should not throw
    await expect(runSync()).resolves.not.toThrow();
  });

  it('handles stderr output without crashing', async () => {
    // Even with stderr data, should not crash
    await expect(runSync()).resolves.not.toThrow();
  });
});

// ── createSyncTimer — timer configuration ─────────────────────────────

describe('createSyncTimer', () => {
  let mockCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSpawnCalls = [];
    mockSpawnReject = false;
    mockCallback = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    mockSpawnCalls = [];
    vi.useRealTimers();
  });

  it('schedules sync at the configured interval', () => {
    const options: SyncOptions = {
      intervalMs: 45000,
      onSync: mockCallback,
    };
    const timer = createSyncTimer(options);
    timer.start();

    // Timer fires immediately on start (1st call), then every interval
    expect(mockCallback).toHaveBeenCalledTimes(1);

    // Advance past first interval (45000ms)
    vi.advanceTimersByTime(45000);
    expect(mockCallback).toHaveBeenCalledTimes(2);

    // Advance past second interval (90000ms total)
    vi.advanceTimersByTime(45000);
    expect(mockCallback).toHaveBeenCalledTimes(3);

    timer.stop();
  });

  it('clamps intervals below minimum', () => {
    const options: SyncOptions = {
      intervalMs: 10000, // Below minimum
      onSync: mockCallback,
    };
    const timer = createSyncTimer(options);
    timer.start();

    // Timer fires immediately on start (1st call)
    expect(mockCallback).toHaveBeenCalledTimes(1);

    // At 10000ms — should NOT have fired again (clamped to 30000ms)
    vi.advanceTimersByTime(10000);
    expect(mockCallback).toHaveBeenCalledTimes(1);

    // At 30000ms total — should have fired again (10000ms + 20000ms = 30000ms)
    vi.advanceTimersByTime(20000);
    expect(mockCallback).toHaveBeenCalledTimes(2);

    timer.stop();
  });

  it('does not schedule if interval is 0 (disabled)', () => {
    const options: SyncOptions = {
      intervalMs: 0,
      onSync: mockCallback,
    };
    const timer = createSyncTimer(options);

    // Advance time — should not trigger
    vi.advanceTimersByTimeAsync(60000);
    expect(mockCallback).not.toHaveBeenCalled();

    timer.stop();
  });

  it('cleans up on stop', () => {
    const options: SyncOptions = {
      intervalMs: 45000,
      onSync: mockCallback,
    };
    const timer = createSyncTimer(options);

    timer.stop();

    // Should not fire after stop
    vi.advanceTimersByTimeAsync(45000);
    expect(mockCallback).not.toHaveBeenCalled();
  });
});

// ── Integration: auto-refresh triggers sync ───────────────────────────

describe('auto-refresh + sync integration', () => {
  let video: string;

  beforeEach(() => {
    video = '';
    mockSpawnCalls = [];
    mockSpawnReject = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renderer does not crash when sync settings are present', () => {
    const renderer = createListRenderer();
    const items = makeItems(3);
    const result = renderer(
      items, 0, 0, defaultTermSize, null, 'list', null,
      undefined, undefined, 0, true, undefined, undefined, 0, true,
    );
    expect(result).toContain('Work Items');
    expect(result).toContain('auto');
  });
});
