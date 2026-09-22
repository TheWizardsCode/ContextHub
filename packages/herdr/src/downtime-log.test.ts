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
  auditDispatchedItemIds,
  implementDispatchedItemIds,
  riskEffortDispatchedItemIds,
  planDispatchedItemStages,
  intakeDispatchedItemStages,
  dispatchedItemStages,
  dispatchedItemMarkers,
  markerStillExcludes,
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
