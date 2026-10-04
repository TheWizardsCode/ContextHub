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
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendDowntimeLogEntry,
  appendCoordinationLogEntry,
  appendPaneCloseLogEntry,
  auditDispatchedItemIds,
  implementDispatchedItemIds,
  riskEffortDispatchedItemIds,
  planDispatchedItemStages,
  intakeDispatchedItemStages,
  dispatchedItemStages,
  dispatchedItemMarkers,
  markerStillExcludes,
  readDowntimeLogEntries,
  recentDispatchedItems,
  groupRecentDispatchesByTimeBlock,
  dispatchTimeBlockLabel,
  UNKNOWN_TIME_BLOCK_LABEL,
  DOWNTIME_LOG_FILE,
  COORDINATION_LOG_FILE,
  DOWNTIME_LOG_MAX_ENTRIES,
  recentAuditDispatchedItemIds,
  isNonTerminalCooldownActive,
} from './downtime-log.js';
import type { DowntimeLogEntry, RecentDispatchRow } from './downtime-log.js';

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

  // ── Enriched per-strike error entries (WL-0MTJPYM53003ORCV) ─────────

  it('tolerantly parses error entries with the new structured fields (WL-0MTJPYM53003ORCV)', async () => {
    const cwd = makeTempCwd();
    const enrichedEntry = JSON.stringify({
      cwd: '/repo',
      at: '2026-09-07T01:00:00.000Z',
      message: '3 consecutive wl CLI errors — pausing dispatch for 3600000ms.',
      error: 'SQLITE_BUSY',
      stderrExcerpt: 'database is locked',
      exitCode: 1,
      timeoutMs: 10_000,
      workItemId: 'WL-ABC',
      command: 'wl show WL-ABC',
      attempt: 2,
      probeContext: 'dispatch-cli',
    });
    await appendDowntimeLogEntry(cwd, enrichedEntry);
    const entries = await readDowntimeLogEntries(cwd);
    expect(entries).toHaveLength(1);
    expect(entries[0].stderrExcerpt).toBe('database is locked');
    expect(entries[0].exitCode).toBe(1);
    expect(entries[0].timeoutMs).toBe(10_000);
    expect(entries[0].workItemId).toBe('WL-ABC');
    expect(entries[0].attempt).toBe(2);
    expect(entries[0].probeContext).toBe('dispatch-cli');
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

  it('rolling bound DOWNTIME_LOG_MAX_ENTRIES=100 trimming still works with enriched error entries (WL-0MTJPYM53003ORCV)', async () => {
    const cwd = makeTempCwd();
    const total = DOWNTIME_LOG_MAX_ENTRIES + 5;
    // Write enriched error entries simulating per-strike logs
    for (let i = 0; i < total; i++) {
      await appendDowntimeLogEntry(cwd, JSON.stringify({
        cwd: '/repo',
        at: `2026-09-07T01:00:${String(i).padStart(2, '0')}.000Z`,
        message: `Strike ${i % 3 + 1} error`,
        attempt: i % 3 + 1,
        probeContext: 'dispatch-cli',
        timeoutMs: 10_000,
      }));
    }
    const lines = readLog(cwd);
    expect(lines).toHaveLength(DOWNTIME_LOG_MAX_ENTRIES);
    // The newest entries are retained (last 100 of 105)
    const lastEntry = JSON.parse(lines[lines.length - 1]);
    expect(lastEntry.attempt).toBe(3);
  });
});

// ── Atomic rolling-log writes (F5 WL-0MUBVL1FI0071WN3) ─────────────────
// `appendRollingJsonl` previously did readFile → push → trim → writeFile
// directly on the target, so a concurrent reader could observe a truncated or
// empty file and momentarily lose the dispatched marker (RCA H3,
// WL-0MUBEZ6PE002WLP4). The writer is now temp-file + rename (atomic within a
// filesystem).

describe('atomic rolling-log writes (WL-0MUBVL1FI0071WN3 / F5)', () => {
  const tmpFilesIn = (cwd: string): string[] =>
    readdirSync(join(cwd, '.worklog')).filter((f) => f.endsWith('.tmp'));

  it('AC4.1: replaces the target atomically and leaves no temp file behind on success', async () => {
    const cwd = makeTempCwd();
    await appendDowntimeLogEntry(cwd, JSON.stringify({ n: 1 }));
    const inoBefore = statSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE)).ino;

    await appendDowntimeLogEntry(cwd, JSON.stringify({ n: 2 }));

    const inoAfter = statSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE)).ino;
    // The target was REPLACED (rename), never written in place.
    expect(inoAfter).not.toBe(inoBefore);
    expect(tmpFilesIn(cwd)).toEqual([]);
    expect(readLog(cwd)).toHaveLength(2);
  });

  it('AC4.1: a write failure leaves the target untouched and cleans up the temp file', async () => {
    const cwd = makeTempCwd();
    // Make the TARGET a directory so the final rename fails (EISDIR/ENOTDIR).
    mkdirSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), { recursive: true });

    await expect(
      appendDowntimeLogEntry(cwd, JSON.stringify({ n: 1 })),
    ).rejects.toThrow();

    // No temp file leaked, and the target (directory) is untouched.
    expect(tmpFilesIn(cwd)).toEqual([]);
    expect(statSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE)).isDirectory()).toBe(true);
  });

  it('AC4.2: concurrent appends and reads never observe an empty or partial line', async () => {
    const cwd = makeTempCwd();
    await appendDowntimeLogEntry(cwd, JSON.stringify({ n: -1 }));

    const appends = Array.from({ length: 40 }, (_, i) =>
      appendDowntimeLogEntry(cwd, JSON.stringify({ n: i })),
    );
    const reads = Array.from({ length: 60 }, async () => {
      // Each read must resolve (never throw) and see a consistent snapshot.
      await readDowntimeLogEntries(cwd);
    });
    await Promise.all([...appends, ...reads]);

    // After settling, the raw file is a sequence of complete JSONL lines.
    const raw = readFileSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // No temp files leaked under concurrency.
    expect(tmpFilesIn(cwd)).toEqual([]);
  });

  it('AC4.4: the coordination log uses the same atomic writer (no temp files leak)', async () => {
    const cwd = makeTempCwd();
    await appendCoordinationLogEntry(cwd, { kind: 'coordination', operation: 'checkin', instanceId: 'i1' });
    expect(tmpFilesIn(cwd)).toEqual([]);
    const raw = readFileSync(join(cwd, '.worklog', COORDINATION_LOG_FILE), 'utf8');
    expect(() => JSON.parse(raw.trim())).not.toThrow();
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

// risk-effort dispatched markers (WL-0MTTSWCJR003OMN7)
describe('riskEffortDispatchedItemIds (risk-effort-tier-only scope guard)', () => {
  it('collects only risk-effort-kind entries that carry an itemId', () => {
    const ids = riskEffortDispatchedItemIds([
      { itemId: 'WL-A', kind: 'risk-effort' },
      { itemId: 'WL-B', kind: 'implement' },
      { itemId: 'WL-C', kind: 'plan' },
      { kind: 'risk-effort' }, // error-style entry without itemId → ignored
      { itemId: 'WL-D', kind: 'risk-effort' },
    ]);
    expect([...ids].sort()).toEqual(['WL-A', 'WL-D']);
  });

  it('does not collect implement markers (risk-effort tier is scoped to kind risk-effort only)', () => {
    const ids = riskEffortDispatchedItemIds([
      { itemId: 'WL-AUD', kind: 'audit' },
      { itemId: 'WL-RE', kind: 'risk-effort' },
    ]);
    expect([...ids]).toEqual(['WL-RE']);
  });

  it('returns an empty set for empty input', () => {
    expect([...riskEffortDispatchedItemIds([])]).toEqual([]);
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

  // risk-effort stage guard (WL-0MTTSWCJR003OMN7)
  it('dispatchedItemStages with risk-effort maps to plan_complete stage', () => {
    const stages = dispatchedItemStages(
      [
        { itemId: 'WL-RE1', kind: 'risk-effort', stage: 'plan_complete' },
        { itemId: 'WL-RE2', kind: 'risk-effort' }, // legacy entry without stage
        { itemId: 'WL-X', kind: 'implement', stage: 'plan_complete' },
      ],
      'risk-effort',
    );
    expect(stages.get('WL-RE1')).toBe('plan_complete');
    expect(stages.get('WL-RE2')).toBe('');
    expect(stages.has('WL-X')).toBe(false);
  });
});

describe('spawn-failed markers are non-excluding (WL-0MT32F908002YFFA AC2)', () => {
  it('excludes spawn-failed entries from the dispatched-id readers, while standing success markers still exclude', () => {
    const entries = [
      { itemId: 'WL-IMP-OK', kind: 'implement' },
      { itemId: 'WL-IMP-FAIL', kind: 'implement', outcome: 'spawn-failed' },
      { itemId: 'WL-AUD-OK', kind: 'audit' },
      { itemId: 'WL-AUD-FAIL', kind: 'audit', outcome: 'spawn-failed' },
      { itemId: 'WL-RE-FAIL', kind: 'risk-effort', outcome: 'spawn-failed' },
    ];

    // AC3 regression: a STANDING success marker (no outcome) is unchanged and
    // still excludes the item — never a double dispatch.
    expect([...implementDispatchedItemIds(entries)]).toEqual(['WL-IMP-OK']);
    expect([...auditDispatchedItemIds(entries)]).toEqual(['WL-AUD-OK']);
    // AC2: a failed spawn never blocks the tier again.
    expect([...riskEffortDispatchedItemIds(entries)]).toEqual([]);
  });

  it('excludes spawn-failed entries from the plan/intake stage change-guard maps', () => {
    const entries = [
      { itemId: 'WL-PLAN-OK', kind: 'plan', stage: 'intake_complete' },
      { itemId: 'WL-PLAN-FAIL', kind: 'plan', stage: 'intake_complete', outcome: 'spawn-failed' },
      { itemId: 'WL-INT-FAIL', kind: 'intake', stage: 'idea', outcome: 'spawn-failed' },
    ];

    expect([...planDispatchedItemStages(entries).keys()]).toEqual(['WL-PLAN-OK']);
    expect([...intakeDispatchedItemStages(entries).keys()]).toEqual([]);
  });

  it('does not treat a spawn-failed audit marker as an active audit', () => {
    const now = Date.now();
    const windowMs = 2 * 60 * 60 * 1000;
    const entries = [
      {
        itemId: 'WL-AUD-FAIL',
        kind: 'audit',
        outcome: 'spawn-failed',
        dispatchedAt: new Date(now - 1000).toISOString(),
      },
      { itemId: 'WL-AUD-OK', kind: 'audit', dispatchedAt: new Date(now - 1000).toISOString() },
    ];

    expect([...recentAuditDispatchedItemIds(entries, windowMs, now)]).toEqual(['WL-AUD-OK']);
  });

  it('round-trips a real spawn-failed log entry into a non-excluding reader result', async () => {
    const cwd = makeTempCwd();
    await appendDowntimeLogEntry(
      cwd,
      JSON.stringify({
        itemId: 'WL-FAILED',
        kind: 'implement',
        stage: 'plan_complete',
        outcome: 'spawn-failed',
        error: 'ENOENT',
      }),
    );
    await appendDowntimeLogEntry(
      cwd,
      JSON.stringify({ itemId: 'WL-DONE', kind: 'implement', stage: 'plan_complete' }),
    );

    const entries = await readDowntimeLogEntries(cwd);
    expect([...implementDispatchedItemIds(entries)]).toEqual(['WL-DONE']);
  });
});

// ── Dispatched success-marker staleness (WL-0MU6UL0RJ008IHGT) ────────
//
// A SUCCESS marker (no `outcome`) historically excluded its item forever, so
// a pane that spawned but whose agent never advanced the item stranded it
// permanently. These tests pin the marker-lifecycle contract: a marker
// excludes only while the item is STILL at the marker's dispatched-at stage
// AND the marker is fresh (age ≤ the configurable staleness window). An
// advanced item releases the marker, and a missing/unparseable
// `dispatchedAt` fails closed (keeps excluding).
describe('dispatched success-marker staleness (WL-0MU6UL0RJ008IHGT)', () => {
  const NOW = new Date('2026-01-02T12:00:00.000Z').getTime();
  const WINDOW_MS = 24 * 60 * 60 * 1000; // 24h default
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it('dispatchedItemMarkers maps id → {stage, dispatchedAt}, kind-scoped, spawn-failed excluded', () => {
    const markers = dispatchedItemMarkers(
      [
        { itemId: 'WL-A', kind: 'plan', stage: 'intake_complete', dispatchedAt: ago(1000) },
        { itemId: 'WL-B', kind: 'intake', stage: 'idea', dispatchedAt: ago(1000) },
        { itemId: 'WL-C', kind: 'plan', stage: 'intake_complete', outcome: 'spawn-failed' },
        { kind: 'plan' }, // error-style/scheduled entry without itemId
      ],
      'plan',
    );
    expect(markers.get('WL-A')).toEqual({
      stage: 'intake_complete',
      dispatchedAt: ago(1000),
    });
    expect(markers.has('WL-B')).toBe(false); // other kind → scoped out
    expect(markers.has('WL-C')).toBe(false); // spawn-failed is not a success marker
    expect(markers.size).toBe(1);
  });

  it('dispatchedItemMarkers tolerates a missing stage/timestamp and keeps the last entry', () => {
    const markers = dispatchedItemMarkers(
      [
        { itemId: 'WL-A', kind: 'implement', stage: 'plan_complete', dispatchedAt: ago(9999) },
        { itemId: 'WL-A', kind: 'implement', stage: 'plan_complete', dispatchedAt: ago(1000) },
        { itemId: 'WL-LEGACY', kind: 'implement' }, // legacy: no stage, no timestamp
      ],
      'implement',
    );
    expect(markers.get('WL-A')?.dispatchedAt).toBe(ago(1000)); // most recent wins
    expect(markers.get('WL-LEGACY')).toEqual({ stage: '', dispatchedAt: undefined });
  });

  it('a fresh marker at the unchanged stage still excludes', () => {
    expect(
      markerStillExcludes(
        { stage: 'intake_complete', dispatchedAt: ago(60 * 1000) },
        'intake_complete',
        NOW,
        WINDOW_MS,
      ),
    ).toBe(true);
  });

  it('a stale marker at the unchanged stage no longer excludes', () => {
    expect(
      markerStillExcludes(
        { stage: 'intake_complete', dispatchedAt: ago(WINDOW_MS + 1) },
        'intake_complete',
        NOW,
        WINDOW_MS,
      ),
    ).toBe(false);
  });

  it('boundary: exactly at the window still excludes; one ms past releases', () => {
    expect(
      markerStillExcludes({ stage: 'idea', dispatchedAt: ago(WINDOW_MS) }, 'idea', NOW, WINDOW_MS),
    ).toBe(true);
    expect(
      markerStillExcludes({ stage: 'idea', dispatchedAt: ago(WINDOW_MS + 1) }, 'idea', NOW, WINDOW_MS),
    ).toBe(false);
  });

  it('a stage-advanced marker does not exclude (no behaviour change for healthy flow)', () => {
    expect(
      markerStillExcludes(
        { stage: 'intake_complete', dispatchedAt: ago(60 * 1000) },
        'plan_complete',
        NOW,
        WINDOW_MS,
      ),
    ).toBe(false);
  });

  it('unparseable/missing dispatchedAt fails closed (keeps excluding)', () => {
    expect(markerStillExcludes({ stage: 'idea' }, 'idea', NOW, WINDOW_MS)).toBe(true);
    expect(
      markerStillExcludes({ stage: 'idea', dispatchedAt: 'not-a-date' }, 'idea', NOW, WINDOW_MS),
    ).toBe(true);
  });

  it('a legacy marker without a recorded stage releases under the stage-guard mode', () => {
    // The historical plan/intake/risk-effort change-guard: a missing
    // dispatched-at stage never suppressed selection.
    expect(
      markerStillExcludes({ stage: '' }, 'intake_complete', NOW, WINDOW_MS, 'stage-guard'),
    ).toBe(false);
  });

  it('a legacy marker without a recorded stage keeps excluding while fresh under id-guard mode, then releases when stale', () => {
    // Audit/implement tiers historically excluded on the id set alone; an
    // unknown stage must not weaken that protection for a possibly-in-flight
    // marker — the age TTL is the only release.
    expect(
      markerStillExcludes(
        { stage: '', dispatchedAt: ago(60 * 1000) },
        'in_review',
        NOW,
        WINDOW_MS,
        'id-guard',
      ),
    ).toBe(true);
    expect(
      markerStillExcludes(
        { stage: '', dispatchedAt: ago(WINDOW_MS + 1) },
        'in_review',
        NOW,
        WINDOW_MS,
        'id-guard',
      ),
    ).toBe(false);
  });
});

// ── Enrichment marker round-trip (F6 WL-0MUBVL251006JAQ0 AC6.2) ─────────

describe('post-spawn enrichment preserves marker semantics (WL-0MUBVL251006JAQ0 / F6)', () => {
  it('AC6.2: an enrichment entry with the same marker fields does not change the dispatched marker', async () => {
    const cwd = makeTempCwd();
    const dispatchedAt = new Date().toISOString();
    const marker = { itemId: 'WL-ENR', kind: 'implement', dispatchedAt, cwd, title: 'Enr', stage: 'plan_complete',
      selectionPath: 'critical-first', selectionReason: 'no-live-pane' };
    const enrichment = { ...marker, paneId: 'w1:p1', enrichment: true };

    await appendDowntimeLogEntry(cwd, JSON.stringify(marker));
    const before = dispatchedItemMarkers(await readDowntimeLogEntries(cwd), 'implement');
    await appendDowntimeLogEntry(cwd, JSON.stringify(enrichment));
    const after = dispatchedItemMarkers(await readDowntimeLogEntries(cwd), 'implement');

    // Last-entry-wins: the enrichment is the last entry, but it copies the
    // marker's stage/dispatchedAt, so the marker state is UNCHANGED.
    expect(after.get('WL-ENR')).toEqual(before.get('WL-ENR'));
    expect(after.get('WL-ENR')?.stage).toBe('plan_complete');
    // And the marker still excludes while fresh at the same stage.
    expect(markerStillExcludes(after.get('WL-ENR')!, 'plan_complete', Date.now(), 24 * 60 * 60 * 1000, 'id-guard')).toBe(true);
  });
});

// ── Pane-close lifecycle entries (WL-0MU308WSF0002JWN) ────────────────
//
// The rolling log gains a `pane-close` entry type recording WHY a dispatched
// pane was closed (intake complete / plan complete / audit passed / audit
// failed / requires-attention). Pane-close entries must be ignored by every
// dispatched-marker reader so the existing change-guard semantics are
// unchanged (backward compatible).
describe('pane-close lifecycle entries (WL-0MU308WSF0002JWN)', () => {
  it('appends a pane-close entry with every AC1 field and round-trips it', async () => {
    const cwd = makeTempCwd();
    await appendPaneCloseLogEntry(cwd, {
      entryType: 'pane-close',
      timestamp: '2026-01-02T00:00:00.000Z',
      itemId: 'WL-1',
      itemTitle: 'Auto close me',
      paneId: 'w1:p1',
      kind: 'plan',
      outcome: 'closed-as-plan-complete',
      reason: 'item advanced to plan_complete',
      closed: true,
    });

    const entries = await readDowntimeLogEntries(cwd);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entryType: 'pane-close',
      timestamp: '2026-01-02T00:00:00.000Z',
      itemId: 'WL-1',
      itemTitle: 'Auto close me',
      paneId: 'w1:p1',
      kind: 'plan',
      outcome: 'closed-as-plan-complete',
      closed: true,
    });
  });

  it('round-trips an optional reasonSnapshot and tolerates absent/malformed snapshots (AC4.3)', async () => {
    const cwd = makeTempCwd();
    const snapshot = {
      kind: 'plan',
      agentProcessAlive: false,
      idleMs: 1234,
      itemStage: 'plan_complete',
      needsProducerReview: false,
      isInvokingPane: false,
      childProcessCount: 0,
      hasRecentFileModifications: false,
      hasActiveNetworkConnections: false,
      gracePeriodMs: 300_000,
      withinGracePeriod: false,
      idleThresholdMs: 600_000,
    };
    await appendPaneCloseLogEntry(cwd, {
      entryType: 'pane-close',
      timestamp: '2026-01-02T00:00:00.000Z',
      itemId: 'WL-1',
      itemTitle: 'with snapshot',
      paneId: 'w1:p1',
      kind: 'plan',
      outcome: 'closed-as-plan-complete',
      reasonCode: 'marker',
      reasonSnapshot: snapshot,
      closed: true,
    });
    await appendPaneCloseLogEntry(cwd, {
      entryType: 'pane-close',
      timestamp: '2026-01-02T00:00:01.000Z',
      itemId: 'WL-2',
      itemTitle: 'no snapshot',
      paneId: 'w1:p2',
      kind: 'plan',
      outcome: 'closed-as-plan-complete',
      closed: true,
    });
    // A malformed snapshot written directly (bypassing the typed API) must
    // never break the reader.
    await appendDowntimeLogEntry(
      cwd,
      JSON.stringify({
        entryType: 'pane-close',
        timestamp: '2026-01-02T00:00:02.000Z',
        itemId: 'WL-3',
        itemTitle: 'malformed snapshot',
        paneId: 'w1:p3',
        kind: 'plan',
        outcome: 'closed-as-plan-complete',
        reasonSnapshot: 'not-an-object',
        closed: true,
      }),
    );

    const entries = await readDowntimeLogEntries(cwd);
    expect(entries).toHaveLength(3);
    expect(entries[0].reasonSnapshot).toMatchObject({
      kind: 'plan',
      idleMs: 1234,
      itemStage: 'plan_complete',
      withinGracePeriod: false,
    });
    expect(entries[1].reasonSnapshot).toBeUndefined();
    expect(entries[2].reasonSnapshot).toBe('not-an-object');
  });

  it('never throws when the worklog dir is unwritable (fail-closed, AC7)', async () => {
    const cwd = '/nonexistent/path/' + Math.random().toString(36).slice(2);
    await expect(
      appendPaneCloseLogEntry(cwd, {
        entryType: 'pane-close',
        timestamp: '2026-01-02T00:00:00.000Z',
        itemId: 'WL-1',
        itemTitle: 'x',
        paneId: 'w1:p1',
        kind: 'plan',
        outcome: 'requires-attention',
        closed: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('a pane-close entry never contaminates the dispatched-marker readers', async () => {
    const cwd = makeTempCwd();
    // A standing implement discharge marker for WL-IMP + a pane-close entry
    // that reuses the SAME itemId/kind — the marker readers must see only the
    // standing marker (the pane-close entry carries entryType, not a marker).
    await appendDowntimeLogEntry(
      cwd,
      JSON.stringify({ itemId: 'WL-IMP', kind: 'implement', stage: 'plan_complete', dispatchedAt: '2026-01-01T00:00:00.000Z' }),
    );
    await appendPaneCloseLogEntry(cwd, {
      entryType: 'pane-close',
      timestamp: '2026-01-02T00:00:00.000Z',
      itemId: 'WL-IMP',
      itemTitle: 'Implement me',
      paneId: 'w1:p9',
      kind: 'implement',
      outcome: 'requires-attention',
      closed: false,
    });

    const entries = await readDowntimeLogEntries(cwd);
    expect([...implementDispatchedItemIds(entries)]).toEqual(['WL-IMP']);
    expect(dispatchedItemMarkers(entries, 'implement').get('WL-IMP')?.stage).toBe('plan_complete');
    // The enrichment-less pane-close entry must NOT be reconstructed as a
    // dispatched pane (only dispatch/enrichment entries carry a paneId).
    expect(entries.filter((e) => e.entryType === 'pane-close')).toHaveLength(1);
  });
});

// ── Recent dispatched items projection (WL-0MUL2IX6H001YHDO) ───────────
//
// `recentDispatchedItems(cwd)` projects the rolling dispatch log into one
// synthetic row per work item id (no result cap; the log itself is bounded by
// `DOWNTIME_LOG_MAX_ENTRIES`), ordered by that item's most recent log entry
// (newest first). It reads only the local fail-safe `readDowntimeLogEntries`
// reader, ignores pane-close lifecycle entries, and never throws — a
// missing/unreadable/empty/malformed log yields `[]`.
describe('recentDispatchedItems (log projection, WL-0MUL2IX6H001YHDO)', () => {
  it('returns [] for a missing log (fail-safe)', async () => {
    const cwd = makeTempCwd();
    expect(await recentDispatchedItems(cwd)).toEqual([]);
  });

  it('returns [] for an empty log file', async () => {
    const cwd = makeTempCwd();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), '\n\n', 'utf8');
    expect(await recentDispatchedItems(cwd)).toEqual([]);
  });

  it('returns [] when the log is unreadable (directory at the log path)', async () => {
    const cwd = makeTempCwd();
    mkdirSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), { recursive: true });
    expect(await recentDispatchedItems(cwd)).toEqual([]);
  });

  it('skips malformed JSONL lines without throwing and projects the valid ones', async () => {
    const cwd = makeTempCwd();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      join(cwd, '.worklog', DOWNTIME_LOG_FILE),
      [
        'not-json',
        JSON.stringify({
          itemId: 'WL-A',
          kind: 'plan',
          title: 'Plan A',
          dispatchedAt: '2026-01-01T00:00:00.000Z',
        }),
        '{ broken',
      ].join('\n') + '\n',
      'utf8',
    );
    const rows = await recentDispatchedItems(cwd);
    expect(rows).toHaveLength(1);
    expect(rows[0].itemId).toBe('WL-A');
  });

  it('projects a dispatch marker into a row with id, title, kind and timestamp', async () => {
    const cwd = makeTempCwd();
    await appendDowntimeLogEntry(
      cwd,
      JSON.stringify({
        itemId: 'WL-A',
        kind: 'plan',
        title: 'Plan the thing',
        dispatchedAt: '2026-01-01T00:00:00.000Z',
        stage: 'intake_complete',
      }),
    );
    expect(await recentDispatchedItems(cwd)).toEqual([
      {
        itemId: 'WL-A',
        title: 'Plan the thing',
        kind: 'plan',
        stage: 'intake_complete',
        latestTimestamp: '2026-01-01T00:00:00.000Z',
        latestOutcome: undefined,
      },
    ]);
  });

  it('deduplicates by work item id, using the most recent entry for metadata', async () => {
    const cwd = makeTempCwd();
    await appendDowntimeLogEntry(
      cwd,
      JSON.stringify({ itemId: 'WL-A', kind: 'intake', title: 'Old title', dispatchedAt: '2026-01-01T00:00:00.000Z' }),
    );
    await appendDowntimeLogEntry(
      cwd,
      JSON.stringify({ itemId: 'WL-A', kind: 'plan', title: 'New title', dispatchedAt: '2026-01-02T00:00:00.000Z' }),
    );
    const rows = await recentDispatchedItems(cwd);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: 'WL-A', title: 'New title', kind: 'plan', latestTimestamp: '2026-01-02T00:00:00.000Z' });
  });

  it('orders rows newest-first by their most recent entry', async () => {
    const cwd = makeTempCwd();
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-OLD', kind: 'plan', title: 'Old', dispatchedAt: '2026-01-01T00:00:00.000Z' }));
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-NEW', kind: 'plan', title: 'New', dispatchedAt: '2026-01-03T00:00:00.000Z' }));
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-MID', kind: 'plan', title: 'Mid', dispatchedAt: '2026-01-02T00:00:00.000Z' }));
    const rows = await recentDispatchedItems(cwd);
    expect(rows.map((r) => r.itemId)).toEqual(['WL-NEW', 'WL-MID', 'WL-OLD']);
  });

  it('ignores pane-close lifecycle entries (they are not dispatch markers)', async () => {
    const cwd = makeTempCwd();
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-A', kind: 'plan', title: 'A', dispatchedAt: '2026-01-01T00:00:00.000Z' }));
    await appendPaneCloseLogEntry(cwd, {
      entryType: 'pane-close',
      timestamp: '2026-01-02T00:00:00.000Z',
      itemId: 'WL-B',
      itemTitle: 'B',
      paneId: 'w1:p1',
      kind: 'plan',
      outcome: 'closed-as-plan-complete',
      closed: true,
    });
    const rows = await recentDispatchedItems(cwd);
    // Pane-close B is ignored — only the dispatch marker A appears.
    expect(rows.map((r) => r.itemId)).toEqual(['WL-A']);
  });

  it('records the latest pane-close outcome without adding a duplicate row', async () => {
    const cwd = makeTempCwd();
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-A', kind: 'plan', title: 'A', dispatchedAt: '2026-01-01T00:00:00.000Z' }));
    await appendPaneCloseLogEntry(cwd, {
      entryType: 'pane-close',
      timestamp: '2026-01-02T00:00:00.000Z',
      itemId: 'WL-A',
      itemTitle: 'A',
      paneId: 'w1:p1',
      kind: 'plan',
      outcome: 'closed-as-plan-complete',
      closed: true,
    });
    const rows = await recentDispatchedItems(cwd);
    expect(rows).toHaveLength(1);
    expect(rows[0].latestOutcome).toBe('closed-as-plan-complete');
    // The latest timestamp is the pane-close event (most recent entry).
    expect(rows[0].latestTimestamp).toBe('2026-01-02T00:00:00.000Z');
  });

  it('reorders by the item most recent entry when a later pane-close arrives', async () => {
    const cwd = makeTempCwd();
    // A dispatched earlier, B dispatched later; A then closes after B.
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-A', kind: 'plan', title: 'A', dispatchedAt: '2026-01-01T00:00:00.000Z' }));
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-B', kind: 'plan', title: 'B', dispatchedAt: '2026-01-02T00:00:00.000Z' }));
    await appendPaneCloseLogEntry(cwd, {
      entryType: 'pane-close',
      timestamp: '2026-01-03T00:00:00.000Z',
      itemId: 'WL-A',
      itemTitle: 'A',
      paneId: 'w1:p1',
      kind: 'plan',
      outcome: 'requires-attention',
      closed: true,
    });
    const rows = await recentDispatchedItems(cwd);
    expect(rows.map((r) => r.itemId)).toEqual(['WL-A', 'WL-B']);
    expect(rows[0].latestOutcome).toBe('requires-attention');
  });

  it('falls back to a placeholder title when the title is missing', async () => {
    const cwd = makeTempCwd();
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-NOTITLE', kind: 'implement', dispatchedAt: '2026-01-01T00:00:00.000Z' }));
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-EMPTY', kind: 'implement', title: '', dispatchedAt: '2026-01-02T00:00:00.000Z' }));
    const rows = await recentDispatchedItems(cwd);
    expect(rows.find((r) => r.itemId === 'WL-NOTITLE')?.title).toBe('[unknown]');
    expect(rows.find((r) => r.itemId === 'WL-EMPTY')?.title).toBe('[unknown]');
  });

  it('shows every dispatched item with no cap (newest first)', async () => {
    const cwd = makeTempCwd();
    for (let i = 0; i < 25; i++) {
      await appendDowntimeLogEntry(
        cwd,
        JSON.stringify({
          itemId: `WL-${String(i).padStart(2, '0')}`,
          kind: 'plan',
          title: `Item ${i}`,
          dispatchedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
      );
    }
    const rows = await recentDispatchedItems(cwd);
    // The 20-item cap is removed (WL-0MUMM9NED009TLL3) — all 25 distinct ids
    // retained in the log are projected, still newest-first.
    expect(rows).toHaveLength(25);
    expect(rows[0].itemId).toBe('WL-24');
    expect(rows[24].itemId).toBe('WL-00');
  });

  it('backfills a placeholder title from a pane-close itemTitle', async () => {
    const cwd = makeTempCwd();
    // Marker carries no title → placeholder; the pane-close entry supplies one.
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-NOTITLE', kind: 'audit', dispatchedAt: '2026-01-01T00:00:00.000Z' }));
    await appendPaneCloseLogEntry(cwd, {
      entryType: 'pane-close',
      timestamp: '2026-01-02T00:00:00.000Z',
      itemId: 'WL-NOTITLE',
      itemTitle: 'Recovered title',
      paneId: 'w1:p1',
      kind: 'audit',
      outcome: 'audit-passed',
      closed: true,
    });
    const rows = await recentDispatchedItems(cwd);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Recovered title');
    expect(rows[0].latestOutcome).toBe('audit-passed');
  });

  it('ignores entries without an itemId', async () => {
    const cwd = makeTempCwd();
    await appendDowntimeLogEntry(cwd, JSON.stringify({ cwd: '/repo', at: '2026-01-01T00:00:00.000Z', message: 'error' }));
    expect(await recentDispatchedItems(cwd)).toEqual([]);
  });

  it('round-trips a real enriched dispatch entry (paneId/enrichment) into a row', async () => {
    const cwd = makeTempCwd();
    await appendDowntimeLogEntry(
      cwd,
      JSON.stringify({
        itemId: 'WL-ENR',
        kind: 'implement',
        title: 'Enriched',
        dispatchedAt: '2026-01-01T00:00:00.000Z',
        paneId: 'w1:p1',
        enrichment: true,
      }),
    );
    const rows = await recentDispatchedItems(cwd);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: 'WL-ENR', title: 'Enriched', kind: 'implement' });
  });

  // ── Stage / audit-icon projection (WL-0MUGLL9SS002E1D2 audit fix) ──────
  // The dispatches view must render the SAME stage/audit icons as every other
  // view; the projection therefore exposes the item's effective stage (and any
  // audit verdict) so `buildDispatchWorkItem` can carry them through the shared
  // icon helpers instead of falling back to the ❓ unknown-stage glyph.

  it('projects the dispatched-at stage into the row', async () => {
    const cwd = makeTempCwd();
    await appendDowntimeLogEntry(
      cwd,
      JSON.stringify({ itemId: 'WL-A', kind: 'plan', title: 'A', stage: 'intake_complete', dispatchedAt: '2026-01-01T00:00:00.000Z' }),
    );
    const rows = await recentDispatchedItems(cwd);
    expect(rows[0].stage).toBe('intake_complete');
    expect(rows[0].auditResult).toBeUndefined();
  });

  it('overrides the dispatched-at stage with the stage reached by a pane-close outcome', async () => {
    const cwd = makeTempCwd();
    await appendDowntimeLogEntry(
      cwd,
      JSON.stringify({ itemId: 'WL-A', kind: 'plan', title: 'A', stage: 'intake_complete', dispatchedAt: '2026-01-01T00:00:00.000Z' }),
    );
    await appendPaneCloseLogEntry(cwd, {
      entryType: 'pane-close', timestamp: '2026-01-02T00:00:00.000Z', itemId: 'WL-A', itemTitle: 'A',
      paneId: 'w1:p1', kind: 'plan', outcome: 'closed-as-plan-complete', closed: true,
    });
    const rows = await recentDispatchedItems(cwd);
    expect(rows[0].stage).toBe('plan_complete');
  });

  it('lets the newest stage-advancing close win across re-dispatches', async () => {
    const cwd = makeTempCwd();
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-A', kind: 'intake', title: 'A', stage: 'idea', dispatchedAt: '2026-01-01T00:00:00.000Z' }));
    await appendPaneCloseLogEntry(cwd, {
      entryType: 'pane-close', timestamp: '2026-01-02T00:00:00.000Z', itemId: 'WL-A', itemTitle: 'A',
      paneId: 'w1:p1', kind: 'intake', outcome: 'closed-as-intake-complete', closed: true,
    });
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-A', kind: 'plan', title: 'A', stage: 'intake_complete', dispatchedAt: '2026-01-03T00:00:00.000Z' }));
    await appendPaneCloseLogEntry(cwd, {
      entryType: 'pane-close', timestamp: '2026-01-04T00:00:00.000Z', itemId: 'WL-A', itemTitle: 'A',
      paneId: 'w1:p2', kind: 'plan', outcome: 'closed-as-plan-complete', closed: true,
    });
    const rows = await recentDispatchedItems(cwd);
    expect(rows).toHaveLength(1);
    expect(rows[0].stage).toBe('plan_complete');
  });

  it('derives the audit verdict from audit pane-close outcomes', async () => {
    const cwd = makeTempCwd();
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-PASS', kind: 'audit', title: 'Pass', stage: 'in_review', dispatchedAt: '2026-01-01T00:00:00.000Z' }));
    await appendPaneCloseLogEntry(cwd, {
      entryType: 'pane-close', timestamp: '2026-01-02T00:00:00.000Z', itemId: 'WL-PASS', itemTitle: 'Pass',
      paneId: 'w1:p1', kind: 'audit', outcome: 'audit-passed', closed: true,
    });
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-FAIL', kind: 'audit', title: 'Fail', stage: 'in_review', dispatchedAt: '2026-01-01T00:00:00.000Z' }));
    await appendPaneCloseLogEntry(cwd, {
      entryType: 'pane-close', timestamp: '2026-01-02T00:00:00.000Z', itemId: 'WL-FAIL', itemTitle: 'Fail',
      paneId: 'w1:p2', kind: 'audit', outcome: 'audit-failed', closed: true,
    });
    const rows = await recentDispatchedItems(cwd);
    expect(rows.find((r) => r.itemId === 'WL-PASS')?.auditResult).toBe(true);
    expect(rows.find((r) => r.itemId === 'WL-FAIL')?.auditResult).toBe(false);
    expect(rows.find((r) => r.itemId === 'WL-PASS')?.stage).toBe('in_review');
  });

  it('keeps the dispatched-at stage for a requires-attention close (no stage implication)', async () => {
    const cwd = makeTempCwd();
    await appendDowntimeLogEntry(
      cwd,
      JSON.stringify({ itemId: 'WL-A', kind: 'implement', title: 'A', stage: 'plan_complete', dispatchedAt: '2026-01-01T00:00:00.000Z' }),
    );
    await appendPaneCloseLogEntry(cwd, {
      entryType: 'pane-close', timestamp: '2026-01-02T00:00:00.000Z', itemId: 'WL-A', itemTitle: 'A',
      paneId: 'w1:p1', kind: 'implement', outcome: 'requires-attention', closed: true,
    });
    const rows = await recentDispatchedItems(cwd);
    expect(rows[0].stage).toBe('plan_complete');
    expect(rows[0].auditResult).toBeUndefined();
  });

  it('treats an empty or non-string stage as absent without throwing', async () => {
    const cwd = makeTempCwd();
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-EMPTY', kind: 'plan', title: 'A', stage: '', dispatchedAt: '2026-01-01T00:00:00.000Z' }));
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-BAD', kind: 'plan', title: 'B', stage: 42, dispatchedAt: '2026-01-02T00:00:00.000Z' }));
    const rows = await recentDispatchedItems(cwd);
    expect(rows.find((r) => r.itemId === 'WL-EMPTY')?.stage).toBeUndefined();
    expect(rows.find((r) => r.itemId === 'WL-BAD')?.stage).toBeUndefined();
  });
});

// ── 4-hour time-block grouping (WL-0MUMM9NED009TLL3) ───────────────────
//
// The recent-dispatches view groups its semantically newest-first rows into
// 4-hour UTC blocks per day, ordered chronologically (oldest block first) with
// a trailing "Unknown time" block for rows with no parseable timestamp. These
// helpers are pure so the boundary/wrap/ordering rules are unit-testable
// without touching the filesystem or the renderer.
describe('groupRecentDispatchesByTimeBlock (4-hour UTC blocks, WL-0MUMM9NED009TLL3)', () => {
  function row(id: string, latestTimestamp?: string): RecentDispatchRow {
    return { itemId: id, title: id, latestTimestamp };
  }

  it('formats the heading label with a UTC date and HH:00–HH:00 boundaries', () => {
    expect(dispatchTimeBlockLabel('2026-09-29T13:45:00.000Z')).toBe('29 Sep 2026, 12:00–16:00');
    expect(dispatchTimeBlockLabel('2026-01-02T00:00:00.000Z')).toBe('02 Jan 2026, 00:00–04:00');
  });

  it('classifies boundary hours into the correct block', () => {
    expect(dispatchTimeBlockLabel('2026-09-29T03:59:59.999Z')).toBe('29 Sep 2026, 00:00–04:00');
    expect(dispatchTimeBlockLabel('2026-09-29T04:00:00.000Z')).toBe('29 Sep 2026, 04:00–08:00');
    expect(dispatchTimeBlockLabel('2026-09-29T07:59:59.000Z')).toBe('29 Sep 2026, 04:00–08:00');
    expect(dispatchTimeBlockLabel('2026-09-29T08:00:00.000Z')).toBe('29 Sep 2026, 08:00–12:00');
    expect(dispatchTimeBlockLabel('2026-09-29T23:59:59.000Z')).toBe('29 Sep 2026, 20:00–24:00');
  });

  it('labels a missing or unparseable timestamp as Unknown time', () => {
    expect(dispatchTimeBlockLabel(undefined)).toBe(UNKNOWN_TIME_BLOCK_LABEL);
    expect(dispatchTimeBlockLabel('not-a-date')).toBe(UNKNOWN_TIME_BLOCK_LABEL);
    expect(dispatchTimeBlockLabel('')).toBe(UNKNOWN_TIME_BLOCK_LABEL);
  });

  it('returns [] for an empty input', () => {
    expect(groupRecentDispatchesByTimeBlock([])).toEqual([]);
  });

  it('groups rows sharing a 4-hour window into one block', () => {
    const blocks = groupRecentDispatchesByTimeBlock([
      row('WL-D', '2026-09-29T03:00:00.000Z'),
      row('WL-C', '2026-09-29T00:30:00.000Z'),
      row('WL-B', '2026-09-29T05:00:00.000Z'),
      row('WL-A', '2026-09-29T04:15:00.000Z'),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].label).toBe('29 Sep 2026, 00:00–04:00');
    expect(blocks[0].rows.map((r) => r.itemId)).toEqual(['WL-D', 'WL-C']);
    expect(blocks[1].label).toBe('29 Sep 2026, 04:00–08:00');
    expect(blocks[1].rows.map((r) => r.itemId)).toEqual(['WL-B', 'WL-A']);
  });

  it('orders blocks chronologically oldest-first regardless of input order', () => {
    // Input is newest-first (as the projection returns it).
    const blocks = groupRecentDispatchesByTimeBlock([
      row('WL-NEW', '2026-09-29T18:00:00.000Z'),
      row('WL-MID', '2026-09-29T09:00:00.000Z'),
      row('WL-OLD', '2026-09-29T01:00:00.000Z'),
    ]);
    expect(blocks.map((b) => b.label)).toEqual([
      '29 Sep 2026, 00:00–04:00',
      '29 Sep 2026, 08:00–12:00',
      '29 Sep 2026, 16:00–20:00',
    ]);
    expect(blocks[0].startMs).toBeLessThan(blocks[1].startMs);
    expect(blocks[1].startMs).toBeLessThan(blocks[2].startMs);
  });

  it('preserves the per-block newest-first item order', () => {
    const blocks = groupRecentDispatchesByTimeBlock([
      row('WL-LATE', '2026-09-29T03:30:00.000Z'),
      row('WL-MID', '2026-09-29T02:00:00.000Z'),
      row('WL-EARLY', '2026-09-29T00:10:00.000Z'),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].rows.map((r) => r.itemId)).toEqual(['WL-LATE', 'WL-MID', 'WL-EARLY']);
  });

  it('keeps blocks on either side of midnight separate (cross-day wrap)', () => {
    const blocks = groupRecentDispatchesByTimeBlock([
      row('WL-NEXT-DAY', '2026-09-30T00:30:00.000Z'),
      row('WL-LATE', '2026-09-29T21:00:00.000Z'),
    ]);
    expect(blocks).toHaveLength(2);
    // Oldest first: the previous day's 20:00 block precedes the new day's 00:00.
    expect(blocks[0].label).toBe('29 Sep 2026, 20:00–24:00');
    expect(blocks[1].label).toBe('30 Sep 2026, 00:00–04:00');
  });

  it('does not merge the same hour on different days', () => {
    const blocks = groupRecentDispatchesByTimeBlock([
      row('WL-D2', '2026-09-30T08:30:00.000Z'),
      row('WL-D1', '2026-09-29T08:30:00.000Z'),
    ]);
    expect(blocks.map((b) => b.label)).toEqual([
      '29 Sep 2026, 08:00–12:00',
      '30 Sep 2026, 08:00–12:00',
    ]);
  });

  it('collects rows without a parseable timestamp into one trailing Unknown time block', () => {
    const blocks = groupRecentDispatchesByTimeBlock([
      row('WL-DATED', '2026-09-29T05:00:00.000Z'),
      row('WL-NO-TS'),
      row('WL-BAD', 'garbage'),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].label).toBe('29 Sep 2026, 04:00–08:00');
    const unknown = blocks[blocks.length - 1];
    expect(unknown.unknownTime).toBe(true);
    expect(unknown.label).toBe(UNKNOWN_TIME_BLOCK_LABEL);
    expect(unknown.startMs).toBe(Number.NEGATIVE_INFINITY);
    expect(unknown.rows.map((r) => r.itemId)).toEqual(['WL-NO-TS', 'WL-BAD']);
  });

  it('keeps the Unknown time block last even when only unknown rows exist', () => {
    const blocks = groupRecentDispatchesByTimeBlock([row('WL-A'), row('WL-B', 'nope')]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].label).toBe(UNKNOWN_TIME_BLOCK_LABEL);
  });

  it('round-trips a real projection: groups all rows without dropping any', async () => {
    const cwd = makeTempCwd();
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-A', kind: 'plan', title: 'A', dispatchedAt: '2026-09-29T01:00:00.000Z' }));
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-B', kind: 'plan', title: 'B', dispatchedAt: '2026-09-29T02:00:00.000Z' }));
    await appendDowntimeLogEntry(cwd, JSON.stringify({ itemId: 'WL-C', kind: 'plan', title: 'C', dispatchedAt: '2026-09-29T09:00:00.000Z' }));
    const rows = await recentDispatchedItems(cwd);
    const blocks = groupRecentDispatchesByTimeBlock(rows);
    expect(blocks).toHaveLength(2);
    const flat = blocks.flatMap((b) => b.rows.map((r) => r.itemId)).sort();
    expect(flat).toEqual(['WL-A', 'WL-B', 'WL-C']);
  });
});

// ── Non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5) ────────────

describe('isNonTerminalCooldownActive (WL-0MUKYERLZ006ELL5)', () => {
  const NOW = Date.parse('2026-09-28T08:00:00.000Z');
  const COOLDOWN_MS = 30 * 60 * 1000;

  /** Build a pane-close entry, defaulting to a recent non-terminal close. */
  function close(overrides: Partial<DowntimeLogEntry> = {}): DowntimeLogEntry {
    return {
      entryType: 'pane-close',
      itemId: 'WL-A',
      kind: 'intake',
      timestamp: new Date(NOW - 60_000).toISOString(),
      reasonCode: 'agent-ended-no-terminal',
      outcome: 'requires-attention',
      closed: true,
      ...overrides,
    };
  }

  function active(
    entries: DowntimeLogEntry[],
    itemStage = 'idea',
    kind = 'intake',
  ): boolean {
    return isNonTerminalCooldownActive(entries, 'WL-A', kind, itemStage, COOLDOWN_MS, NOW);
  }

  it('(a) skips an item after a recent non-terminal close', () => {
    expect(active([close({ stage: 'idea' })])).toBe(true);
  });

  it('(b) releases once the close is older than cooldownMs', () => {
    const stale = new Date(NOW - COOLDOWN_MS - 1).toISOString();
    expect(active([close({ timestamp: stale, stage: 'idea' })])).toBe(false);
  });

  it('releases at exactly cooldownMs (the cooldown has elapsed)', () => {
    const atEdge = new Date(NOW - COOLDOWN_MS).toISOString();
    expect(active([close({ timestamp: atEdge, stage: 'idea' })])).toBe(false);
  });

  it('(c) releases immediately when the item advanced past its dispatched-at stage', () => {
    // Dispatched at plan_complete, now in_review → genuinely progressed.
    expect(active([close({ stage: 'plan_complete' })], 'in_review')).toBe(false);
  });

  it('does not release when the item is still at the dispatched-at stage', () => {
    expect(active([close({ stage: 'plan_complete' })], 'plan_complete')).toBe(true);
  });

  it('(d) does not apply to a terminal close (reasonCode none)', () => {
    expect(
      active([close({ reasonCode: 'none', outcome: 'closed-as-intake-complete' })]),
    ).toBe(false);
  });

  it('does not apply to a reached-in-review close (terminal success)', () => {
    // `reached-in-review` is a successful terminal close (parent AC5): the
    // implement pane advanced the item, so no cooldown is applied.
    expect(
      active(
        [close({ kind: 'implement', reasonCode: 'reached-in-review', stage: 'plan_complete' })],
        'in_review',
        'implement',
      ),
    ).toBe(false);
  });

  it('(e) fails closed (skip) on a missing close timestamp', () => {
    expect(active([close({ timestamp: undefined, stage: 'idea' })])).toBe(true);
  });

  it('(e) fails closed (skip) on an unparseable close timestamp', () => {
    expect(active([close({ timestamp: 'not-a-date', stage: 'idea' })])).toBe(true);
  });

  it('returns false when there is no pane-close record for the item', () => {
    expect(active([])).toBe(false);
    expect(active([close({ itemId: 'WL-OTHER' })])).toBe(false);
  });

  it('scopes the cooldown to the dispatched kind', () => {
    // A non-terminal intake close must not hold implement re-dispatch.
    expect(active([close({ kind: 'intake' })], 'idea', 'implement')).toBe(false);
  });

  it('keeps kinds independent when the same item closes non-terminally in one kind', () => {
    const entries = [close({ kind: 'plan' }), close({ kind: 'intake' })];
    expect(isNonTerminalCooldownActive(entries, 'WL-A', 'intake', 'idea', COOLDOWN_MS, NOW)).toBe(true);
    expect(isNonTerminalCooldownActive(entries, 'WL-A', 'plan', 'idea', COOLDOWN_MS, NOW)).toBe(true);
    expect(isNonTerminalCooldownActive(entries, 'WL-A', 'implement', 'idea', COOLDOWN_MS, NOW)).toBe(false);
  });

  it('uses the most recent close: a later terminal close supersedes an earlier failure', () => {
    const entries = [
      close({ timestamp: new Date(NOW - 120_000).toISOString(), reasonCode: 'agent-ended-no-terminal' }),
      close({ timestamp: new Date(NOW - 30_000).toISOString(), reasonCode: 'none', outcome: 'closed-as-intake-complete' }),
    ];
    expect(active(entries)).toBe(false);
  });

  it('uses the most recent close: a later failure re-arms the cooldown', () => {
    const entries = [
      close({ timestamp: new Date(NOW - 30_000).toISOString(), reasonCode: 'none', outcome: 'closed-as-intake-complete' }),
      close({ timestamp: new Date(NOW - 10_000).toISOString(), reasonCode: 'agent-ended-no-terminal' }),
    ];
    expect(active(entries)).toBe(true);
  });

  it('applies to any non-terminal code (producer-review, risk-effort-incomplete)', () => {
    expect(active([close({ reasonCode: 'producer-review', stage: 'idea' })])).toBe(true);
    expect(active([close({ reasonCode: 'risk-effort-incomplete', stage: 'plan_complete' })])).toBe(true);
    expect(active([close({ reasonCode: 'audit-ended-no-result', stage: 'plan_complete' })])).toBe(true);
  });

  it('ignores non-pane-close log entries (dispatch markers)', () => {
    const markers: DowntimeLogEntry[] = [
      { itemId: 'WL-A', kind: 'intake', dispatchedAt: new Date(NOW - 60_000).toISOString(), stage: 'idea' },
    ];
    expect(active(markers)).toBe(false);
  });
});
