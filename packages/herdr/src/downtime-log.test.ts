/**
 * Unit tests for downtime-log.ts — bounded JSONL audit log for herdr
 * downtime dispatches (WL-0MSGPI4AR000YOK8, parent WL-0MSF49FMW009M06K).
 *
 * The log lives at `<cwd>/.worklog/downtime-dispatches.log` and is bounded
 * (rolling): the file keeps only the most recent DOWNTIME_LOG_MAX_ENTRIES
 * entries so it cannot grow unbounded over a long-lived plugin pane.
 *
 * Stale-window marker filter tests (WL-0MT47BMR7003ZQ66, parent
 * WL-0MT3PHW4I002SNOV): recentAuditDispatchedItemIds pins the 2h stale
 * window that powers the single-active-audit guard — an audit dispatch
 * marker older than the window is treated as stale (the audit pane may
 * have crashed without updating the work item) and ignored, so a new audit
 * dispatch can proceed. Red phase: the helper does not exist yet — the new
 * tests fail and the existing suite stays green until the implementation
 * slice lands (WL-0MT47BQAT00375VB).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendDowntimeLogEntry,
  appendCoordinationLogEntry,
  auditDispatchedItemIds,
  implementDispatchedItemIds,
  planDispatchedItemStages,
  intakeDispatchedItemStages,
  dispatchedItemStages,
  readDowntimeLogEntries,
  DOWNTIME_LOG_FILE,
  COORDINATION_LOG_FILE,
  DOWNTIME_LOG_MAX_ENTRIES,
  recentAuditDispatchedItemIds,
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

describe('coordination log (WL-0MSXHAE290067VAL)', () => {
  it('appends coordination operations to a SEPARATE rolling file', async () => {
    const cwd = makeTempCwd();
    await appendCoordinationLogEntry(cwd, {
      kind: 'coordination',
      operation: 'checkin',
      instanceId: 'inst-1',
      workItemId: 'WL-A',
      at: '2026-01-01T00:00:00.000Z',
    });
    // The DISPATCH log is untouched by coordination entries (the marker
    // readers that scan it must never see coordination records).
    expect(existsInLog(cwd, DOWNTIME_LOG_FILE)).toBe(false);
    // The COORDINATION log carries the entry.
    const raw = readFileSync(join(cwd, '.worklog', COORDINATION_LOG_FILE), 'utf8');
    expect(raw).toContain('"operation":"checkin"');
    expect(raw).toContain('"workItemId":"WL-A"');
  });

  it('never throws when the worklog dir is unwritable (fail-closed)', async () => {
    const cwd = '/nonexistent/path/' + Math.random().toString(36).slice(2);
    await expect(appendCoordinationLogEntry(cwd, { kind: 'coordination', operation: 'election', at: 'x' })).resolves.toBeUndefined();
  });
});

function existsInLog(cwd: string, file: string): boolean {
  try {
    readFileSync(join(cwd, '.worklog', file), 'utf8');
    return true;
  } catch {
    return false;
  }
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

describe('recentAuditDispatchedItemIds (stale-window marker filter)', () => {
  // Stale-audit window shared with the dispatcher (WL-0MT3PHW4I002SNOV): an
  // audit dispatch marker older than 2h is treated as stale — the audit
  // pane may have crashed without updating the work item — so it must not
  // block a new audit dispatch.
  const WINDOW_MS = 2 * 60 * 60 * 1000; // 2h
  const NOW = new Date('2026-01-01T12:00:00.000Z').getTime();
  const freshAudit = {
    itemId: 'WL-FRESH',
    kind: 'audit',
    dispatchedAt: new Date(NOW - 10 * 60 * 1000).toISOString(), // 10m ago
  };
  const staleAudit = {
    itemId: 'WL-STALE',
    kind: 'audit',
    dispatchedAt: new Date(NOW - WINDOW_MS - 60 * 1000).toISOString(), // >2h ago
  };

  it('keeps only audit-kind markers whose dispatchedAt is within the stale window', () => {
    const ids = recentAuditDispatchedItemIds(
      [
        freshAudit,
        staleAudit,
        { itemId: 'WL-PLAN', kind: 'plan', dispatchedAt: freshAudit.dispatchedAt }, // other kind → scoped out
        { kind: 'audit' }, // error-style entry without itemId → ignored
      ],
      WINDOW_MS,
      NOW,
    );
    expect([...ids]).toEqual(['WL-FRESH']);
  });

  it('boundary inclusive: a marker dispatched exactly windowMs ago is kept', () => {
    const ids = recentAuditDispatchedItemIds(
      [{ itemId: 'WL-EDGE', kind: 'audit', dispatchedAt: new Date(NOW - WINDOW_MS).toISOString() }],
      WINDOW_MS,
      NOW,
    );
    expect([...ids]).toEqual(['WL-EDGE']);
  });

  it('boundary: a marker just past the window is dropped (stale)', () => {
    const ids = recentAuditDispatchedItemIds(
      [{ itemId: 'WL-PAST', kind: 'audit', dispatchedAt: new Date(NOW - WINDOW_MS - 1).toISOString() }],
      WINDOW_MS,
      NOW,
    );
    expect([...ids]).toEqual([]);
  });

  it('a marker without a parseable dispatchedAt is excluded (fail-closed: no active evidence)', () => {
    const ids = recentAuditDispatchedItemIds(
      [
        { itemId: 'WL-NODATE', kind: 'audit' }, // missing dispatchedAt
        { itemId: 'WL-BADDATE', kind: 'audit', dispatchedAt: 'not-a-date' },
      ],
      WINDOW_MS,
      NOW,
    );
    expect([...ids]).toEqual([]);
  });

  it('returns an empty set for empty input', () => {
    expect([...recentAuditDispatchedItemIds([], WINDOW_MS, NOW)]).toEqual([]);
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
