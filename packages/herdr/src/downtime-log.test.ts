/**
 * Unit tests for downtime-log.ts — bounded JSONL audit log for herdr
 * downtime dispatches (WL-0MSGPI4AR000YOK8, parent WL-0MSF49FMW009M06K).
 *
 * The log lives at `<cwd>/.worklog/downtime-dispatches.log` and is bounded
 * (rolling): the file keeps only the most recent DOWNTIME_LOG_MAX_ENTRIES
 * entries so it cannot grow unbounded over a long-lived plugin pane.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendDowntimeLogEntry,
  auditDispatchedItemIds,
  implementDispatchedItemIds,
  planDispatchedItemStages,
  intakeDispatchedItemStages,
  dispatchedItemStages,
  readDowntimeLogEntries,
  DOWNTIME_LOG_FILE,
  DOWNTIME_LOG_MAX_ENTRIES,
} from './downtime-log.js';

const tempDirs: string[] = [];

function makeTempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'downtime-log-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readLog(cwd: string): string[] {
  const raw = readFileSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '');
}

describe('downtime rolling log', () => {
  it('creates .worklog and appends a JSONL entry under the given cwd', async () => {
    const cwd = makeTempCwd();
    const entry = JSON.stringify({ itemId: 'WL-A', kind: 'plan', n: 1 });

    await appendDowntimeLogEntry(cwd, entry);

    const lines = readLog(cwd);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ itemId: 'WL-A', kind: 'plan', n: 1 });
  });

  it('appends to an existing log file without truncating prior entries', async () => {
    const cwd = makeTempCwd();
    mkdirSync(join(cwd, '.worklog'));
    writeFileSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), '{"n":1}\n', 'utf8');

    await appendDowntimeLogEntry(cwd, '{"n":2}');

    const lines = readLog(cwd);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ n: 1 });
    expect(JSON.parse(lines[1])).toEqual({ n: 2 });
  });

  it('keeps only the most recent DOWNTIME_LOG_MAX_ENTRIES entries (rolling bound)', async () => {
    const cwd = makeTempCwd();
    const total = DOWNTIME_LOG_MAX_ENTRIES + 20;

    for (let i = 0; i < total; i++) {
      await appendDowntimeLogEntry(cwd, JSON.stringify({ n: i }));
    }

    const lines = readLog(cwd);
    expect(lines).toHaveLength(DOWNTIME_LOG_MAX_ENTRIES);
    expect(JSON.parse(lines[0])).toEqual({ n: total - DOWNTIME_LOG_MAX_ENTRIES });
    expect(JSON.parse(lines[lines.length - 1])).toEqual({ n: total - 1 });
  });
});

describe('readDowntimeLogEntries (fail-safe lookup)', () => {
  it('returns [] when the log file does not exist', async () => {
    const cwd = makeTempCwd();
    expect(await readDowntimeLogEntries(cwd)).toEqual([]);
  });

  it('returns [] when the log file is unreadable', async () => {
    const cwd = makeTempCwd();
    // A directory at the log path cannot be read as a file (EISDIR).
    mkdirSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), { recursive: true });
    expect(await readDowntimeLogEntries(cwd)).toEqual([]);
  });

  it('skips malformed JSONL lines and parses the valid ones', async () => {
    const cwd = makeTempCwd();
    mkdirSync(join(cwd, '.worklog'));
    writeFileSync(
      join(cwd, '.worklog', DOWNTIME_LOG_FILE),
      '{"itemId":"WL-A","kind":"audit"}\nnot-json\n{"itemId":"WL-B","kind":"plan"}\n\n',
      'utf8',
    );
    expect(await readDowntimeLogEntries(cwd)).toEqual([
      { itemId: 'WL-A', kind: 'audit' },
      { itemId: 'WL-B', kind: 'plan' },
    ]);
  });

  it('round-trips entries written by appendDowntimeLogEntry', async () => {
    const cwd = makeTempCwd();
    const entry = { itemId: 'WL-A', kind: 'audit', dispatchedAt: '2026-01-01T00:00:00.000Z', cwd };
    await appendDowntimeLogEntry(cwd, JSON.stringify(entry));
    expect(await readDowntimeLogEntries(cwd)).toEqual([entry]);
  });
});

describe('auditDispatchedItemIds (audit-tier-only scope guard)', () => {
  it('collects only audit-kind entries that carry an itemId', () => {
    const ids = auditDispatchedItemIds([
      { itemId: 'WL-A', kind: 'audit' },
      { itemId: 'WL-B', kind: 'plan' },
      { itemId: 'WL-C', kind: 'intake' },
      { kind: 'audit' }, // error-style entry without itemId → ignored
      { itemId: 'WL-D', kind: 'audit' },
    ]);
    expect([...ids].sort()).toEqual(['WL-A', 'WL-D']);
  });

  it('returns an empty set for empty input', () => {
    expect([...auditDispatchedItemIds([])]).toEqual([]);
  });
});

describe('implementDispatchedItemIds (implement-tier-only scope guard)', () => {
  it('collects only implement-kind entries that carry an itemId', () => {
    const ids = implementDispatchedItemIds([
      { itemId: 'WL-A', kind: 'implement' },
      { itemId: 'WL-B', kind: 'plan' },
      { itemId: 'WL-C', kind: 'audit' },
      { kind: 'implement' }, // error-style entry without itemId → ignored
      { itemId: 'WL-D', kind: 'implement' },
    ]);
    expect([...ids].sort()).toEqual(['WL-A', 'WL-D']);
  });

  it('does not collect audit markers (implement tier is scoped to kind implement only)', () => {
    const ids = implementDispatchedItemIds([
      { itemId: 'WL-AUD', kind: 'audit' },
      { itemId: 'WL-IMP', kind: 'implement' },
    ]);
    expect([...ids]).toEqual(['WL-IMP']);
  });

  it('returns an empty set for empty input', () => {
    expect([...implementDispatchedItemIds([])]).toEqual([]);
  });
});

describe('plan/intake dispatched-item stages (change-guard maps)', () => {
  it('planDispatchedItemStages maps plan markers to their dispatched-at stage', () => {
    const stages = planDispatchedItemStages([
      { itemId: 'WL-A', kind: 'plan', stage: 'intake_complete' },
      { itemId: 'WL-B', kind: 'intake', stage: 'idea' },
      { itemId: 'WL-C', kind: 'plan' }, // legacy entry without stage → ''
      { kind: 'plan' }, // no itemId → ignored
    ]);
    expect(stages.get('WL-A')).toBe('intake_complete');
    expect(stages.get('WL-C')).toBe('');
    expect(stages.has('WL-B')).toBe(false); // intake markers are scoped out
  });

  it('intakeDispatchedItemStages maps intake markers to their dispatched-at stage', () => {
    const stages = intakeDispatchedItemStages([
      { itemId: 'WL-A', kind: 'intake', stage: 'idea' },
      { itemId: 'WL-B', kind: 'plan', stage: 'intake_complete' },
    ]);
    expect(stages.get('WL-A')).toBe('idea');
    expect(stages.has('WL-B')).toBe(false);
  });

  it('dispatchedItemStages is kind-scoped and tolerant of malformed entries', () => {
    const stages = dispatchedItemStages(
      [
        { itemId: 'WL-A', kind: 'plan', stage: 'intake_complete' },
        { itemId: 'WL-B', kind: 'plan', stage: 42 as unknown as string }, // non-string stage → ''
        { itemId: 'WL-C', kind: 'plan' },
      ],
      'plan',
    );
    expect(stages.get('WL-A')).toBe('intake_complete');
    expect(stages.get('WL-B')).toBe('');
    expect(stages.get('WL-C')).toBe('');
  });

  it('returns an empty map for empty input', () => {
    expect(planDispatchedItemStages([]).size).toBe(0);
    expect(intakeDispatchedItemStages([]).size).toBe(0);
  });
});
