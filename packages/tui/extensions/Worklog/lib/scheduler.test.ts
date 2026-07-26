/**
 * Unit tests for lib/scheduler.ts — Periodic request scheduler for the
 * Worklog Pi extension.
 *
 * Tests cover:
 * 1. Cron expression parsing and matching
 * 2. Schedule entry management (add, remove, toggle, list)
 * 3. Scheduler lifecycle (start, tick, stop)
 * 4. Idle check before submission
 * 5. Duplicate fire prevention
 * 6. Configuration persistence
 *
 * Run: npx vitest run packages/tui/extensions/Worklog/lib/scheduler.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// ── Mocks ─────────────────────────────────────────────────────────────

// Mock the settings module so we can control schedule config in tests
const mockGetSetting = vi.hoisted(() => vi.fn());
const mockUpdateSetting = vi.hoisted(() => vi.fn());

vi.mock('./settings.js', () => ({
  currentSettings: {
    get schedules() { return mockGetSetting(); },
  },
  reloadSettings: vi.fn(),
}));

// Track sendUserMessage calls
const mockSendUserMessage = vi.hoisted(() => vi.fn());
const mockIsIdle = vi.hoisted(() => vi.fn());

function createMockPi(overrides: Record<string, any> = {}): ExtensionAPI {
  return {
    on: vi.fn(),
    sendUserMessage: mockSendUserMessage,
    ...overrides,
  } as unknown as ExtensionAPI;
}

describe('cronMatch', () => {
  it('should match * * * * * (every minute)', async () => {
    const { cronMatch } = await import('./scheduler.js');
    const date = new Date('2026-07-12T15:30:00Z');
    expect(cronMatch('* * * * *', date)).toBe(true);
  });

  it('should match exact minute', async () => {
    const { cronMatch } = await import('./scheduler.js');
    // At 15:30, minute=30 should match
    const date = new Date('2026-07-12T15:30:00Z');
    expect(cronMatch('30 * * * *', date)).toBe(true);
  });

  it('should not match different minute', async () => {
    const { cronMatch } = await import('./scheduler.js');
    const date = new Date('2026-07-12T15:30:00Z');
    expect(cronMatch('0 * * * *', date)).toBe(false);
  });

  it('should match exact hour', async () => {
    const { cronMatch } = await import('./scheduler.js');
    const date = new Date('2026-07-12T15:30:00Z');
    expect(cronMatch('* 15 * * *', date)).toBe(true);
  });

  it('should not match different hour', async () => {
    const { cronMatch } = await import('./scheduler.js');
    const date = new Date('2026-07-12T15:30:00Z');
    expect(cronMatch('* 14 * * *', date)).toBe(false);
  });

  it('should match exact day of month', async () => {
    const { cronMatch } = await import('./scheduler.js');
    const date = new Date('2026-07-12T00:00:00Z');
    expect(cronMatch('* * 12 * *', date)).toBe(true);
  });

  it('should match exact month', async () => {
    const { cronMatch } = await import('./scheduler.js');
    const date = new Date('2026-07-12T00:00:00Z');
    expect(cronMatch('* * * 7 *', date)).toBe(true);
  });

  it('should match exact day of week (0=Sunday)', async () => {
    const { cronMatch } = await import('./scheduler.js');
    // 2026-07-12 is a Sunday (getUTCDay() returns 0)
    const date = new Date('2026-07-12T00:00:00Z');
    expect(cronMatch('* * * * 0', date)).toBe(true);
  });

  it('should match day of week 7 as Sunday', async () => {
    const { cronMatch } = await import('./scheduler.js');
    const date = new Date('2026-07-12T00:00:00Z');
    expect(cronMatch('* * * * 7', date)).toBe(true);
  });

  it('should handle comma-separated lists', async () => {
    const { cronMatch } = await import('./scheduler.js');
    const date = new Date('2026-07-12T15:30:00Z');
    expect(cronMatch('15,30,45 * * * *', date)).toBe(true);
    expect(cronMatch('0,15,45 * * * *', date)).toBe(false);
  });

  it('should handle ranges', async () => {
    const { cronMatch } = await import('./scheduler.js');
    const date = new Date('2026-07-12T15:30:00Z');
    expect(cronMatch('15-45 * * * *', date)).toBe(true);
    expect(cronMatch('0-15 * * * *', date)).toBe(false);
  });

  it('should handle step values with wildcard', async () => {
    const { cronMatch } = await import('./scheduler.js');
    const date = new Date('2026-07-12T15:30:00Z');
    // */15 matches 0,15,30,45
    expect(cronMatch('*/15 * * * *', date)).toBe(true);
    expect(cronMatch('*/10 * * * *', date)).toBe(true); // 30 is divisible by 10
    expect(cronMatch('*/31 * * * *', date)).toBe(false); // 30 not divisible by 31
  });

  it('should handle step values with ranges', async () => {
    const { cronMatch } = await import('./scheduler.js');
    const date = new Date('2026-07-12T15:30:00Z');
    // 0-30/10 matches 0,10,20,30
    expect(cronMatch('0-30/10 * * * *', date)).toBe(true);
    // 1-31/10 matches 1,11,21,31 — 30 not included
    expect(cronMatch('1-31/10 * * * *', date)).toBe(false);
  });

  it('should reject invalid cron expressions', async () => {
    const { cronMatch } = await import('./scheduler.js');
    expect(() => cronMatch('invalid', new Date())).toThrow();
    expect(() => cronMatch('* * * *', new Date())).toThrow(); // 4 fields
    expect(() => cronMatch('* * * * * *', new Date())).toThrow(); // 6 fields
    expect(() => cronMatch('a b c d e', new Date())).toThrow();
  });

  it('should handle "daily at 1am" pattern (0 1 * * *)', async () => {
    const { cronMatch } = await import('./scheduler.js');
    const matching = new Date('2026-07-12T01:00:00Z');
    const nonMatching = new Date('2026-07-12T02:00:00Z');
    expect(cronMatch('0 1 * * *', matching)).toBe(true);
    expect(cronMatch('0 1 * * *', nonMatching)).toBe(false);
  });

  it('should handle "every hour" pattern (0 * * * *)', async () => {
    const { cronMatch } = await import('./scheduler.js');
    const date0 = new Date('2026-07-12T15:00:00Z');
    const date30 = new Date('2026-07-12T15:30:00Z');
    expect(cronMatch('0 * * * *', date0)).toBe(true);
    expect(cronMatch('0 * * * *', date30)).toBe(false);
  });

  it('should handle "weekdays at 9am" pattern (0 9 * * 1-5)', async () => {
    const { cronMatch } = await import('./scheduler.js');
    // 2026-07-13 is a Monday
    const monday = new Date('2026-07-13T09:00:00Z');
    // 2026-07-12 is a Sunday
    const sunday = new Date('2026-07-12T09:00:00Z');
    expect(cronMatch('0 9 * * 1-5', monday)).toBe(true);
    expect(cronMatch('0 9 * * 1-5', sunday)).toBe(false);
  });
});

describe('parseScheduleEntry', () => {
  it('should parse a valid schedule entry config', async () => {
    const { parseScheduleEntry } = await import('./scheduler.js');
    const entry = parseScheduleEntry({
      cron: '0 1 * * *',
      request: '/skill:audit',
      enabled: true,
      id: 'sched-1',
    });
    expect(entry.cron).toBe('0 1 * * *');
    expect(entry.request).toBe('/skill:audit');
    expect(entry.enabled).toBe(true);
    expect(entry.id).toBe('sched-1');
  });

  it('should default enabled to true if not specified', async () => {
    const { parseScheduleEntry } = await import('./scheduler.js');
    const entry = parseScheduleEntry({
      cron: '0 * * * *',
      request: 'daily audit',
    });
    expect(entry.enabled).toBe(true);
    expect(entry.id).toBeDefined();
  });

  it('should generate an id if not provided', async () => {
    const { parseScheduleEntry } = await import('./scheduler.js');
    const entry = parseScheduleEntry({
      cron: '0 * * * *',
      request: 'test',
    });
    expect(entry.id).toBeDefined();
    expect(typeof entry.id).toBe('string');
    expect(entry.id.length).toBeGreaterThan(0);
  });

  it('should reject invalid cron expressions', async () => {
    const { parseScheduleEntry } = await import('./scheduler.js');
    expect(() => parseScheduleEntry({
      cron: 'bad cron',
      request: 'test',
    })).toThrow();
  });
});

describe('Scheduler', () => {
  let mockPi: ExtensionAPI;
  let Scheduler: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSendUserMessage.mockReset();
    mockIsIdle.mockReset();
    mockGetSetting.mockReset();

    const mod = await import('./scheduler.js');
    Scheduler = mod.Scheduler;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should start and stop without errors', () => {
    const scheduler = new Scheduler(createMockPi());
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  it('should not start if already running', () => {
    const scheduler = new Scheduler(createMockPi());
    scheduler.start();
    // Clear mocks to verify no additional setup
    scheduler.start(); // Should be no-op
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
  });

  it('should stop gracefully even if never started', () => {
    const scheduler = new Scheduler(createMockPi());
    expect(() => scheduler.stop()).not.toThrow();
  });

  it('should read schedules from settings on tick', async () => {
    mockGetSetting.mockReturnValue([
      { cron: '*/5 * * * *', request: '/skill:audit', enabled: true, id: 'sched-1' },
    ]);

    const scheduler = new Scheduler(createMockPi());
    scheduler.start();

    // Manually trigger a tick
    await scheduler.tick();

    // Should have checked settings
    expect(mockGetSetting).toHaveBeenCalled();
    scheduler.stop();
  });

  it('should submit request via sendUserMessage when schedule fires and agent is idle', async () => {
    mockIsIdle.mockReturnValue(true);
    mockGetSetting.mockReturnValue([
      // Match current minute — using * for all fields so it always matches
      { cron: '* * * * *', request: 'test request', enabled: true, id: 'sched-1' },
    ]);

    const scheduler = new Scheduler(createMockPi(), {
      isIdleFn: mockIsIdle,
    });

    await scheduler.tick();

    expect(mockSendUserMessage).toHaveBeenCalledWith('test request', { deliverAs: 'steer' });
  });

  it('should not submit request when agent is not idle', async () => {
    mockIsIdle.mockReturnValue(false);
    mockGetSetting.mockReturnValue([
      { cron: '* * * * *', request: 'test request', enabled: true, id: 'sched-1' },
    ]);

    const scheduler = new Scheduler(createMockPi(), {
      isIdleFn: mockIsIdle,
    });

    await scheduler.tick();

    expect(mockSendUserMessage).not.toHaveBeenCalled();
  });

  it('should not submit request for disabled schedules', async () => {
    mockIsIdle.mockReturnValue(true);
    mockGetSetting.mockReturnValue([
      { cron: '* * * * *', request: 'test request', enabled: false, id: 'sched-1' },
    ]);

    const scheduler = new Scheduler(createMockPi(), {
      isIdleFn: mockIsIdle,
    });

    await scheduler.tick();

    expect(mockSendUserMessage).not.toHaveBeenCalled();
  });

  it('should not submit request if cron expression does not match current time', async () => {
    mockIsIdle.mockReturnValue(true);
    mockGetSetting.mockReturnValue([
      // Match a minute that will never match current time (impossible combo)
      { cron: '0 0 1 1 0', request: 'test request', enabled: true, id: 'sched-1' },
    ]);

    const scheduler = new Scheduler(createMockPi(), {
      isIdleFn: mockIsIdle,
    });

    await scheduler.tick();

    expect(mockSendUserMessage).not.toHaveBeenCalled();
  });

  it('should prevent duplicate fires within the same tick', async () => {
    mockIsIdle.mockReturnValue(true);
    const requestText = 'duplicate test';
    mockGetSetting.mockReturnValue([
      { cron: '* * * * *', request: requestText, enabled: true, id: 'sched-1' },
    ]);

    const scheduler = new Scheduler(createMockPi(), {
      isIdleFn: mockIsIdle,
    });

    // Two ticks in the same minute should only fire once
    await scheduler.tick();
    await scheduler.tick();

    expect(mockSendUserMessage).toHaveBeenCalledTimes(1);
    expect(mockSendUserMessage).toHaveBeenCalledWith(requestText, { deliverAs: 'steer' });
  });

  it('should handle empty schedule list gracefully', async () => {
    mockGetSetting.mockReturnValue(undefined);

    const scheduler = new Scheduler(createMockPi(), {
      isIdleFn: mockIsIdle,
    });

    await expect(scheduler.tick()).resolves.not.toThrow();
  });

  it('should handle missing schedules setting gracefully', async () => {
    mockGetSetting.mockReturnValue(null);

    const scheduler = new Scheduler(createMockPi(), {
      isIdleFn: mockIsIdle,
    });

    await expect(scheduler.tick()).resolves.not.toThrow();
  });

  it('should handle schedule with invalid cron expression gracefully', async () => {
    mockIsIdle.mockReturnValue(true);
    mockGetSetting.mockReturnValue([
      { cron: 'invalid!!!', request: 'test', enabled: true, id: 'sched-bad' },
    ]);

    const scheduler = new Scheduler(createMockPi(), {
      isIdleFn: mockIsIdle,
    });

    // Should not throw — invalid cron expressions should be logged and skipped
    await expect(scheduler.tick()).resolves.not.toThrow();
    expect(mockSendUserMessage).not.toHaveBeenCalled();
  });

  it('should track last fire time per schedule to prevent double fire across ticks', async () => {
    mockIsIdle.mockReturnValue(true);
    mockGetSetting.mockReturnValue([
      { cron: '* * * * *', request: 'test', enabled: true, id: 'sched-1' },
    ]);

    const scheduler = new Scheduler(createMockPi(), {
      isIdleFn: mockIsIdle,
    });

    // First tick: should fire
    await scheduler.tick();
    expect(mockSendUserMessage).toHaveBeenCalledTimes(1);

    // Simulate next minute by advancing last-fires but still same minute
    // The scheduler should see lastFires has an entry for this minute
    await scheduler.tick();
    expect(mockSendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('should fire again in a new minute', async () => {
    mockIsIdle.mockReturnValue(true);

    const scheduler = new Scheduler(createMockPi(), {
      isIdleFn: mockIsIdle,
    });

    // Set up a schedule
    mockGetSetting.mockReturnValue([
      { cron: '* * * * *', request: 'test', enabled: true, id: 'sched-1' },
    ]);

    // First tick — should fire
    await scheduler.tick();
    expect(mockSendUserMessage).toHaveBeenCalledTimes(1);

    // Clear last-fires to simulate passing to a new minute
    scheduler.clearLastFires();

    // Second tick — should fire again
    await scheduler.tick();
    expect(mockSendUserMessage).toHaveBeenCalledTimes(2);
  });
});

describe('scheduleCliCommand', () => {
  let scheduleCliCommand: any;
  let setSchedulePersister: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSetting.mockReset();
    mockUpdateSetting.mockReset();
    const mod = await import('./scheduler.js');
    scheduleCliCommand = mod.scheduleCliCommand;
    setSchedulePersister = mod.setSchedulePersister;
    // Wire the persister to the mock update function
    setSchedulePersister((schedules: any) => {
      mockUpdateSetting({ schedules });
    });
  });

  it('should list schedules (empty list)', () => {
    mockGetSetting.mockReturnValue([]);
    const result = scheduleCliCommand('');
    expect(result).toContain('No');
  });

  it('should list schedules (with entries)', () => {
    mockGetSetting.mockReturnValue([
      { cron: '0 1 * * *', request: 'daily task', enabled: true, id: 'sched-1', label: 'Daily' },
    ]);
    const result = scheduleCliCommand('list');
    expect(result).toContain('sched-1');
    expect(result).toContain('0 1 * * *');
    expect(result).toContain('daily task');
    expect(result).toContain('Daily');
  });

  it('should add a schedule', () => {
    mockGetSetting.mockReturnValue([]);
    const result = scheduleCliCommand('add "0 1 * * *" "daily audit"');
    expect(result).not.toContain('Error');
    expect(mockUpdateSetting).toHaveBeenCalled();
  });

  it('should reject add with invalid cron', () => {
    mockGetSetting.mockReturnValue([]);
    const result = scheduleCliCommand('add "bad" "test"');
    expect(result).toContain('Error');
    expect(mockUpdateSetting).not.toHaveBeenCalled();
  });

  it('should reject add with missing arguments', () => {
    mockGetSetting.mockReturnValue([]);
    const result = scheduleCliCommand('add');
    expect(result).toContain('Usage');
  });

  it('should remove a schedule by id', () => {
    mockGetSetting.mockReturnValue([
      { cron: '0 1 * * *', request: 'test', enabled: true, id: 'sched-1' },
      { cron: '0 2 * * *', request: 'test2', enabled: true, id: 'sched-2' },
    ]);
    const result = scheduleCliCommand('remove sched-1');
    expect(result).not.toContain('Error');
    // Should have called update with only sched-2 remaining
    const updateCall = mockUpdateSetting.mock.calls[0];
    const remainingSchedules = updateCall[0].schedules;
    expect(remainingSchedules).toHaveLength(1);
    expect(remainingSchedules[0].id).toBe('sched-2');
  });

  it('should show error when removing non-existent id', () => {
    mockGetSetting.mockReturnValue([
      { cron: '0 1 * * *', request: 'test', enabled: true, id: 'sched-1' },
    ]);
    const result = scheduleCliCommand('remove non-existent');
    expect(result).toContain('Error');
    expect(result).toContain('not found');
  });

  it('should toggle a schedule on/off', () => {
    mockGetSetting.mockReturnValue([
      { cron: '0 1 * * *', request: 'test', enabled: true, id: 'sched-1' },
    ]);
    const result = scheduleCliCommand('toggle sched-1');
    expect(result).not.toContain('Error');
    const updateCall = mockUpdateSetting.mock.calls[0];
    expect(updateCall[0].schedules[0].enabled).toBe(false);
  });

  it('should show error when toggling non-existent id', () => {
    mockGetSetting.mockReturnValue([
      { cron: '0 1 * * *', request: 'test', enabled: true, id: 'sched-1' },
    ]);
    const result = scheduleCliCommand('toggle bad-id');
    expect(result).toContain('Error');
    expect(result).toContain('not found');
  });

  it('should show help text for unrecognized subcommand', () => {
    const result = scheduleCliCommand('unknown');
    expect(result).toContain('Usage');
  });

  afterEach(() => {
    // Reset the persister to avoid interfering with other test blocks
    setSchedulePersister(() => {});
  });
});

describe('validateCronExpression', () => {
  it('should return true for valid cron expressions', async () => {
    const { validateCronExpression } = await import('./scheduler.js');
    expect(validateCronExpression('* * * * *')).toBe(true);
    expect(validateCronExpression('0 1 * * *')).toBe(true);
    expect(validateCronExpression('*/15 * * * *')).toBe(true);
    expect(validateCronExpression('1-30/10 * * * *')).toBe(true);
    expect(validateCronExpression('0 9 * * 1-5')).toBe(true);
    expect(validateCronExpression('30 4 1,15 * 0')).toBe(true);
  });

  it('should return false for invalid cron expressions', async () => {
    const { validateCronExpression } = await import('./scheduler.js');
    expect(validateCronExpression('')).toBe(false);
    expect(validateCronExpression('* * * *')).toBe(false); // 4 fields
    expect(validateCronExpression('* * * * * *')).toBe(false); // 6 fields
    expect(validateCronExpression('a b c d e')).toBe(false);
    expect(validateCronExpression('60 * * * *')).toBe(false); // minute > 59
    expect(validateCronExpression('* 24 * * *')).toBe(false); // hour > 23
    expect(validateCronExpression('* * 32 * *')).toBe(false); // day > 31
    expect(validateCronExpression('* * * 13 *')).toBe(false); // month > 12
    expect(validateCronExpression('* * * * 8')).toBe(false); // day-of-week > 7
  });

  it('should return false for null/undefined', async () => {
    const { validateCronExpression } = await import('./scheduler.js');
    expect(validateCronExpression(null as any)).toBe(false);
    expect(validateCronExpression(undefined as any)).toBe(false);
  });
});
