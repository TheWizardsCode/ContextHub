/**
 * Tests for label event fetching, caching, and helper functions in github.ts
 *
 * Validates that:
 * - LabelEventCache stores and retrieves events correctly
 * - fetchLabelEventsAsync fetches, filters, caches, and handles errors
 * - labelFieldsDiffer detects differences between label-derived and local fields
 * - getLatestLabelEventTimestamp finds the most recent label event for a category
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LabelEventCache,
  labelFieldsDiffer,
  getLatestLabelEventTimestamp,
  fetchLabelEventsAsync,
} from '../src/github.js';
import type { LabelEvent, GithubConfig } from '../src/github.js';
import type { WorkItemStatus, WorkItemPriority } from '../src/types.js';

// Mock child_process.spawn to control GitHub API responses
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

const { mockSpawn } = vi.hoisted(() => {
  return { mockSpawn: vi.fn() };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: mockSpawn };
});

function createMockSpawnImpl(
  stdout: string,
  exitCode: number = 0,
  stderr: string = ''
) {
  return (_cmd: string, _args: string[], _opts: any) => {
    const proc = new EventEmitter() as any;
    proc.stdin = new Writable({ write: (_c: any, _e: any, cb: () => void) => cb() });
    proc.stdout = new Readable({
      read() {
        this.push(stdout);
        this.push(null);
      },
    });
    proc.stdout.setEncoding = () => proc.stdout;
    proc.stderr = new Readable({
      read() {
        this.push(stderr);
        this.push(null);
      },
    });
    proc.stderr.setEncoding = () => proc.stderr;
    proc.exitCode = exitCode;
    proc.kill = () => {};

    // Emit close asynchronously to simulate real process
    setImmediate(() => {
      proc.emit('close', exitCode);
    });

    return proc;
  };
}

const defaultConfig: GithubConfig = { repo: 'owner/repo', labelPrefix: 'wl:' };

describe('LabelEventCache', () => {
  let cache: LabelEventCache;

  beforeEach(() => {
    cache = new LabelEventCache();
  });

  it('starts empty', () => {
    expect(cache.size).toBe(0);
    expect(cache.has(1)).toBe(false);
    expect(cache.get(1)).toBeUndefined();
  });

  it('stores and retrieves events', () => {
    const events: LabelEvent[] = [
      { label: 'wl:stage:done', action: 'labeled', createdAt: '2025-01-01T00:00:00Z' },
    ];
    cache.set(42, events);
    expect(cache.has(42)).toBe(true);
    expect(cache.get(42)).toEqual(events);
    expect(cache.size).toBe(1);
  });

  it('returns different events for different issue numbers', () => {
    const events1: LabelEvent[] = [
      { label: 'wl:stage:idea', action: 'labeled', createdAt: '2025-01-01T00:00:00Z' },
    ];
    const events2: LabelEvent[] = [
      { label: 'wl:stage:done', action: 'labeled', createdAt: '2025-01-02T00:00:00Z' },
    ];
    cache.set(1, events1);
    cache.set(2, events2);
    expect(cache.get(1)).toEqual(events1);
    expect(cache.get(2)).toEqual(events2);
    expect(cache.size).toBe(2);
  });

  it('overwrites cached events for the same issue', () => {
    const events1: LabelEvent[] = [
      { label: 'wl:stage:idea', action: 'labeled', createdAt: '2025-01-01T00:00:00Z' },
    ];
    const events2: LabelEvent[] = [
      { label: 'wl:stage:done', action: 'labeled', createdAt: '2025-01-02T00:00:00Z' },
    ];
    cache.set(1, events1);
    cache.set(1, events2);
    expect(cache.get(1)).toEqual(events2);
    expect(cache.size).toBe(1);
  });

  it('caches empty arrays (e.g. after API failure)', () => {
    cache.set(99, []);
    expect(cache.has(99)).toBe(true);
    expect(cache.get(99)).toEqual([]);
  });

  it('clears all entries', () => {
    cache.set(1, []);
    cache.set(2, []);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has(1)).toBe(false);
    expect(cache.has(2)).toBe(false);
  });
});

describe('labelFieldsDiffer', () => {
  const baseFields = {
    status: 'open' as WorkItemStatus,
    priority: 'medium' as WorkItemPriority,
    stage: 'idea',
    issueType: 'bug',
    risk: 'Low',
    effort: 'M',
  };

  it('returns false when all fields match', () => {
    expect(labelFieldsDiffer(baseFields, { ...baseFields })).toBe(false);
  });

  it('detects status difference', () => {
    expect(
      labelFieldsDiffer(
        { ...baseFields, status: 'in-progress' },
        baseFields
      )
    ).toBe(true);
  });

  it('detects priority difference', () => {
    expect(
      labelFieldsDiffer(
        { ...baseFields, priority: 'critical' },
        baseFields
      )
    ).toBe(true);
  });

  it('detects stage difference', () => {
    expect(
      labelFieldsDiffer(
        { ...baseFields, stage: 'done' },
        baseFields
      )
    ).toBe(true);
  });

  it('detects issueType difference', () => {
    expect(
      labelFieldsDiffer(
        { ...baseFields, issueType: 'feature' },
        baseFields
      )
    ).toBe(true);
  });

  it('detects risk difference', () => {
    expect(
      labelFieldsDiffer(
        { ...baseFields, risk: 'High' },
        baseFields
      )
    ).toBe(true);
  });

  it('detects effort difference', () => {
    expect(
      labelFieldsDiffer(
        { ...baseFields, effort: 'XL' },
        baseFields
      )
    ).toBe(true);
  });

  it('ignores empty label fields (does not treat empty as different)', () => {
    // When label field is empty string, it means the label was not present
    // on GitHub, so it should not be considered different from local value
    expect(
      labelFieldsDiffer(
        { ...baseFields, stage: '', issueType: '', risk: '', effort: '' },
        baseFields
      )
    ).toBe(false);
  });

  it('treats empty local value as different when label has a value', () => {
    expect(
      labelFieldsDiffer(
        { ...baseFields, stage: 'done' },
        { ...baseFields, stage: '' }
      )
    ).toBe(true);
  });
});

describe('getLatestLabelEventTimestamp', () => {
  const events: LabelEvent[] = [
    { label: 'wl:stage:idea', action: 'labeled', createdAt: '2025-01-01T00:00:00Z' },
    { label: 'wl:priority:high', action: 'labeled', createdAt: '2025-01-02T00:00:00Z' },
    { label: 'wl:stage:idea', action: 'unlabeled', createdAt: '2025-01-03T00:00:00Z' },
    { label: 'wl:stage:done', action: 'labeled', createdAt: '2025-01-04T00:00:00Z' },
    { label: 'wl:type:bug', action: 'labeled', createdAt: '2025-01-05T00:00:00Z' },
  ];

  it('returns the most recent labeled timestamp for stage:', () => {
    const result = getLatestLabelEventTimestamp(events, 'wl:', 'stage:');
    expect(result).toBe('2025-01-04T00:00:00Z');
  });

  it('returns the most recent labeled timestamp for priority:', () => {
    const result = getLatestLabelEventTimestamp(events, 'wl:', 'priority:');
    expect(result).toBe('2025-01-02T00:00:00Z');
  });

  it('returns the most recent labeled timestamp for type:', () => {
    const result = getLatestLabelEventTimestamp(events, 'wl:', 'type:');
    expect(result).toBe('2025-01-05T00:00:00Z');
  });

  it('returns null when no events match the category', () => {
    const result = getLatestLabelEventTimestamp(events, 'wl:', 'effort:');
    expect(result).toBeNull();
  });

  it('returns null for empty events array', () => {
    const result = getLatestLabelEventTimestamp([], 'wl:', 'stage:');
    expect(result).toBeNull();
  });

  it('ignores unlabeled events', () => {
    // Only labeled events at 01 and 04 for stage
    // The unlabeled at 03 should not be returned
    const onlyUnlabeled: LabelEvent[] = [
      { label: 'wl:stage:idea', action: 'unlabeled', createdAt: '2025-01-03T00:00:00Z' },
    ];
    const result = getLatestLabelEventTimestamp(onlyUnlabeled, 'wl:', 'stage:');
    expect(result).toBeNull();
  });

  it('respects custom label prefix', () => {
    const customEvents: LabelEvent[] = [
      { label: 'myapp:stage:done', action: 'labeled', createdAt: '2025-01-10T00:00:00Z' },
    ];
    const result = getLatestLabelEventTimestamp(customEvents, 'myapp:', 'stage:');
    expect(result).toBe('2025-01-10T00:00:00Z');
  });

  it('does not match wl: events when using custom prefix', () => {
    const result = getLatestLabelEventTimestamp(events, 'myapp:', 'stage:');
    expect(result).toBeNull();
  });
});

describe('fetchLabelEventsAsync', () => {
  afterEach(() => {
    mockSpawn.mockReset();
  });

  it('fetches and filters label events from API', async () => {
    const apiResponse = [
      { event: 'labeled', label: { name: 'wl:stage:done' }, created_at: '2025-01-01T00:00:00Z' },
      { event: 'labeled', label: { name: 'wl:priority:high' }, created_at: '2025-01-02T00:00:00Z' },
      { event: 'closed', created_at: '2025-01-03T00:00:00Z' }, // not a label event
      { event: 'labeled', label: { name: 'bug' }, created_at: '2025-01-04T00:00:00Z' }, // not wl: prefix
      { event: 'unlabeled', label: { name: 'wl:stage:idea' }, created_at: '2025-01-05T00:00:00Z' },
    ];

    mockSpawn.mockImplementation(createMockSpawnImpl(JSON.stringify(apiResponse)) as any);
    const cache = new LabelEventCache();
    const events = await fetchLabelEventsAsync(defaultConfig, 42, cache);

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ label: 'wl:stage:done', action: 'labeled', createdAt: '2025-01-01T00:00:00Z' });
    expect(events[1]).toEqual({ label: 'wl:priority:high', action: 'labeled', createdAt: '2025-01-02T00:00:00Z' });
    expect(events[2]).toEqual({ label: 'wl:stage:idea', action: 'unlabeled', createdAt: '2025-01-05T00:00:00Z' });
  });

  it('returns cached results on second call', async () => {
    const apiResponse = [
      { event: 'labeled', label: { name: 'wl:stage:done' }, created_at: '2025-01-01T00:00:00Z' },
    ];

    mockSpawn.mockImplementation(createMockSpawnImpl(JSON.stringify(apiResponse)) as any);
    const cache = new LabelEventCache();

    // First call — should hit the API
    const events1 = await fetchLabelEventsAsync(defaultConfig, 42, cache);
    expect(events1).toHaveLength(1);

    // Second call — should return cached results (spawn not called again)
    const callCount = mockSpawn.mock.calls.length;
    const events2 = await fetchLabelEventsAsync(defaultConfig, 42, cache);
    expect(events2).toEqual(events1);
    expect(mockSpawn.mock.calls.length).toBe(callCount); // no additional calls
  });

  it('returns empty array and caches on API failure', async () => {
    mockSpawn.mockImplementation(createMockSpawnImpl('', 1, 'API error') as any);
    const cache = new LabelEventCache();
    const events = await fetchLabelEventsAsync(defaultConfig, 99, cache);

    expect(events).toEqual([]);
    expect(cache.has(99)).toBe(true);
    expect(cache.get(99)).toEqual([]);
  });

  it('returns empty array for non-array API response', async () => {
    mockSpawn.mockImplementation(createMockSpawnImpl('{"message": "Not Found"}') as any);
    const cache = new LabelEventCache();
    const events = await fetchLabelEventsAsync(defaultConfig, 99, cache);

    expect(events).toEqual([]);
    expect(cache.has(99)).toBe(true);
  });

  it('returns empty array for invalid JSON response', async () => {
    mockSpawn.mockImplementation(createMockSpawnImpl('not valid json') as any);
    const cache = new LabelEventCache();
    const events = await fetchLabelEventsAsync(defaultConfig, 99, cache);

    expect(events).toEqual([]);
  });

  it('sorts events by createdAt ascending', async () => {
    const apiResponse = [
      { event: 'labeled', label: { name: 'wl:stage:done' }, created_at: '2025-01-03T00:00:00Z' },
      { event: 'labeled', label: { name: 'wl:stage:idea' }, created_at: '2025-01-01T00:00:00Z' },
      { event: 'labeled', label: { name: 'wl:priority:high' }, created_at: '2025-01-02T00:00:00Z' },
    ];

    mockSpawn.mockImplementation(createMockSpawnImpl(JSON.stringify(apiResponse)) as any);
    const cache = new LabelEventCache();
    const events = await fetchLabelEventsAsync(defaultConfig, 42, cache);

    expect(events[0].createdAt).toBe('2025-01-01T00:00:00Z');
    expect(events[1].createdAt).toBe('2025-01-02T00:00:00Z');
    expect(events[2].createdAt).toBe('2025-01-03T00:00:00Z');
  });

  it('filters to configured label prefix only', async () => {
    const apiResponse = [
      { event: 'labeled', label: { name: 'wl:stage:done' }, created_at: '2025-01-01T00:00:00Z' },
      { event: 'labeled', label: { name: 'myapp:stage:done' }, created_at: '2025-01-02T00:00:00Z' },
    ];

    mockSpawn.mockImplementation(createMockSpawnImpl(JSON.stringify(apiResponse)) as any);
    const cache = new LabelEventCache();
    const events = await fetchLabelEventsAsync(defaultConfig, 42, cache);

    expect(events).toHaveLength(1);
    expect(events[0].label).toBe('wl:stage:done');
  });

  it('handles events with missing label name gracefully', async () => {
    const apiResponse = [
      { event: 'labeled', label: { name: 'wl:stage:done' }, created_at: '2025-01-01T00:00:00Z' },
      { event: 'labeled', label: {}, created_at: '2025-01-02T00:00:00Z' }, // no name
      { event: 'labeled', created_at: '2025-01-03T00:00:00Z' }, // no label object
    ];

    mockSpawn.mockImplementation(createMockSpawnImpl(JSON.stringify(apiResponse)) as any);
    const cache = new LabelEventCache();
    const events = await fetchLabelEventsAsync(defaultConfig, 42, cache);

    expect(events).toHaveLength(1);
    expect(events[0].label).toBe('wl:stage:done');
  });

  it('handles events with missing created_at gracefully', async () => {
    const apiResponse = [
      { event: 'labeled', label: { name: 'wl:stage:done' }, created_at: '2025-01-01T00:00:00Z' },
      { event: 'labeled', label: { name: 'wl:stage:idea' } }, // no created_at
    ];

    mockSpawn.mockImplementation(createMockSpawnImpl(JSON.stringify(apiResponse)) as any);
    const cache = new LabelEventCache();
    const events = await fetchLabelEventsAsync(defaultConfig, 42, cache);

    expect(events).toHaveLength(1);
    expect(events[0].label).toBe('wl:stage:done');
  });

  it('returns empty array for empty events API response', async () => {
    mockSpawn.mockImplementation(createMockSpawnImpl('[]') as any);
    const cache = new LabelEventCache();
    const events = await fetchLabelEventsAsync(defaultConfig, 42, cache);

    expect(events).toEqual([]);
    expect(cache.has(42)).toBe(true);
  });
});
