/**
 * Tests for the machine-scoped dispatch budget ledger and configuration
 * (WL-0MVXY0WQF0069YDJ, parent WL-0MVXWQFGV000D2AB).
 *
 * Two halves, matching the module's layering:
 *
 *  - pure decision helpers (config clamp/parse/env override, quota
 *    arithmetic, staleness and the ledger→counts reduction) — no fs;
 *  - fs-backed ledger and config behaviour against the F0 machine-budget
 *    fixture (`host-dispatch-budget.fixtures.ts`), so every test runs in an
 *    isolated machine coordination dir and never touches
 *    `~/.herdr/downtime`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { tryAcquireCoordLock } from './coordination.js';
import {
  DEFAULT_HOST_BUDGET_CONFIG,
  HOST_BUDGET_CONFIG_FILE,
  HOST_BUDGET_ENV_KEYS,
  HOST_BUDGET_MAX,
  HOST_BUDGET_STALE_WINDOW_MS,
  applyBudgetEnvOverrides,
  budgetConfigPath,
  budgetLedgerPath,
  clampHostBudget,
  computeOverQuota,
  isEntryStale,
  isOverQuota,
  liveCount,
  livePaneIdSet,
  parseBudgetConfig,
  readBudget,
  readBudgetConfig,
  reap,
  reduceLedgerCounts,
  release,
  reserve,
  resolveBudgetConfig,
  type HostBudgetEntry,
} from './host-dispatch-budget.js';
import {
  budgetLedgerPath as fixtureLedgerPath,
  makeBudgetEntry,
  makeInstance,
  makeLivePaneList,
  seedBudgetLedger,
  withMachineDir,
  writeBudgetLedger,
  writeRawBudgetLedger,
} from './host-dispatch-budget.fixtures.js';

/** Deterministic clock: 2026-11-03T12:00:00.000Z. */
const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const cleanEnv: Readonly<Record<string, string | undefined>> = {};

afterEach(() => {
  // Some tests (the AC7 resolver path) mutate HOME; restore defensively.
  if (process.env.HOME === '') delete process.env.HOME;
});

// ── Pure decision helpers ──────────────────────────────────────────────

describe('clampHostBudget', () => {
  it('accepts 0 (the kill switch) and in-range integers unchanged', () => {
    expect(clampHostBudget(0, 2)).toBe(0);
    expect(clampHostBudget(2, 2)).toBe(2);
    expect(clampHostBudget(HOST_BUDGET_MAX, 2)).toBe(HOST_BUDGET_MAX);
  });

  it('rounds and caps at HOST_BUDGET_MAX', () => {
    expect(clampHostBudget(2.4, 2)).toBe(2);
    expect(clampHostBudget(2.6, 2)).toBe(3);
    expect(clampHostBudget(HOST_BUDGET_MAX + 1000, 2)).toBe(HOST_BUDGET_MAX);
    expect(clampHostBudget(1e9, 1)).toBe(HOST_BUDGET_MAX);
  });

  it('keeps the fallback for invalid values (never silently disables a tier)', () => {
    expect(clampHostBudget(-1, 2)).toBe(2);
    expect(clampHostBudget(Number.NaN, 2)).toBe(2);
    expect(clampHostBudget(Number.POSITIVE_INFINITY, 2)).toBe(2);
    expect(clampHostBudget('3', 2)).toBe(2);
    expect(clampHostBudget(undefined, 1)).toBe(1);
    expect(clampHostBudget(null, 1)).toBe(1);
  });
});

describe('parseBudgetConfig', () => {
  it('yields today\'s defaults (2 implements, 1 audit) when the file is absent', () => {
    for (const raw of [undefined, null]) {
      const result = parseBudgetConfig(raw);
      expect(result.config).toEqual({ maxImplement: 2, maxAudit: 1 });
      expect(result.warnings).toEqual([]);
    }
    expect(DEFAULT_HOST_BUDGET_CONFIG).toEqual({ maxImplement: 2, maxAudit: 1 });
  });

  it('accepts a partial document and fills the absent tier from the defaults', () => {
    expect(parseBudgetConfig({ maxImplement: 3 })).toEqual({
      config: { maxImplement: 3, maxAudit: 1 },
      warnings: [],
    });
    expect(parseBudgetConfig({ maxAudit: 0 }).config).toEqual({ maxImplement: 2, maxAudit: 0 });
  });

  it('ignores unknown extra keys (additive format evolution)', () => {
    expect(parseBudgetConfig({ maxImplement: 1, futureWindow: '24h' })).toEqual({
      config: { maxImplement: 1, maxAudit: 1 },
      warnings: [],
    });
  });

  it('falls back to defaults with a warning for a non-object document', () => {
    for (const raw of [[], 'nope', 42, true]) {
      const result = parseBudgetConfig(raw);
      expect(result.config).toEqual({ maxImplement: 2, maxAudit: 1 });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('not a JSON object');
    }
  });

  it('keeps the default for an invalid tier value and warns (never half-applies garbage)', () => {
    const result = parseBudgetConfig({ maxImplement: '2', maxAudit: -1 });
    expect(result.config).toEqual({ maxImplement: 2, maxAudit: 1 });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('maxImplement');
    expect(result.warnings[1]).toContain('maxAudit');

    const nonFinite = parseBudgetConfig({ maxImplement: Number.NaN, maxAudit: 2 });
    expect(nonFinite.config).toEqual({ maxImplement: 2, maxAudit: 2 });
    expect(nonFinite.warnings).toHaveLength(1);
  });

  it('clamps an over-large configured cap to HOST_BUDGET_MAX', () => {
    expect(parseBudgetConfig({ maxImplement: 1e9, maxAudit: 7 }).config).toEqual({
      maxImplement: HOST_BUDGET_MAX,
      maxAudit: 7,
    });
  });
});

describe('applyBudgetEnvOverrides / resolveBudgetConfig', () => {
  const base = { maxImplement: 2, maxAudit: 1 };

  it('leaves the config alone when the variables are unset or empty', () => {
    for (const env of [{}, { HERDR_HOST_MAX_IMPLEMENT: '', HERDR_HOST_MAX_AUDIT: '   ' }, undefined]) {
      const result = applyBudgetEnvOverrides(base, env ?? cleanEnv);
      expect(result.config).toEqual(base);
      expect(result.warnings).toEqual([]);
    }
  });

  it('overrides with parsed, trimmed values, including 0 (disabled)', () => {
    const result = applyBudgetEnvOverrides(base, {
      [HOST_BUDGET_ENV_KEYS.implement]: ' 4 ',
      [HOST_BUDGET_ENV_KEYS.audit]: '0',
    });
    expect(result.config).toEqual({ maxImplement: 4, maxAudit: 0 });
    expect(result.warnings).toEqual([]);
  });

  it('clamps an over-large env value', () => {
    expect(
      applyBudgetEnvOverrides(base, { [HOST_BUDGET_ENV_KEYS.implement]: '999' }).config.maxImplement,
    ).toBe(HOST_BUDGET_MAX);
  });

  it('ignores an invalid env value with a warning naming the key', () => {
    const invalid = applyBudgetEnvOverrides(base, {
      [HOST_BUDGET_ENV_KEYS.implement]: 'two',
      [HOST_BUDGET_ENV_KEYS.audit]: '-1',
    });
    expect(invalid.config).toEqual(base);
    expect(invalid.warnings).toHaveLength(2);
    expect(invalid.warnings[0]).toContain(HOST_BUDGET_ENV_KEYS.implement);
    expect(invalid.warnings[1]).toContain(HOST_BUDGET_ENV_KEYS.audit);
  });

  it('composes file values and env overrides (env wins)', () => {
    const resolved = resolveBudgetConfig(
      { maxImplement: 5, maxAudit: 2 },
      { [HOST_BUDGET_ENV_KEYS.implement]: '1' },
    );
    expect(resolved.config).toEqual({ maxImplement: 1, maxAudit: 2 });
    expect(resolved.warnings).toEqual([]);
  });
});

describe('quota arithmetic', () => {
  it('reports the overshoot after the next dispatch, at and over cap', () => {
    expect(computeOverQuota(0, 2)).toBe(0);
    expect(computeOverQuota(1, 2)).toBe(0);
    expect(computeOverQuota(2, 2)).toBe(1); // at cap → over by 1
    expect(computeOverQuota(3, 2)).toBe(2);
    expect(computeOverQuota(4, 2)).toBe(3); // already 2 over → over by 3
  });

  it('treats a disabled tier (maximum 0) as always over quota', () => {
    expect(isOverQuota(0, 0)).toBe(true);
    expect(computeOverQuota(0, 0)).toBe(1);
    expect(computeOverQuota(3, 0)).toBe(4);
    expect(isOverQuota(0, 1)).toBe(false);
    expect(isOverQuota(1, 1)).toBe(true);
  });
});

describe('isEntryStale', () => {
  const entry = (heartbeatAt: string) => ({ heartbeatAt });

  it('is fresh inside the window and stale at/after it', () => {
    const fresh = new Date(NOW - HOUR).toISOString();
    const exactly = new Date(NOW - HOST_BUDGET_STALE_WINDOW_MS).toISOString();
    const older = new Date(NOW - HOST_BUDGET_STALE_WINDOW_MS - 1).toISOString();
    expect(isEntryStale(entry(fresh), NOW)).toBe(false);
    expect(isEntryStale(entry(exactly), NOW)).toBe(true);
    expect(isEntryStale(entry(older), NOW)).toBe(true);
    expect(isEntryStale(entry(fresh), NOW, HOUR)).toBe(true); // explicit window
  });

  it('treats an invalid heartbeat as stale and a future one as fresh', () => {
    expect(isEntryStale(entry('not-a-date'), NOW)).toBe(true);
    expect(isEntryStale(entry(''), NOW)).toBe(true);
    expect(isEntryStale(entry(new Date(NOW + HOUR).toISOString()), NOW)).toBe(false);
  });
});

describe('reduceLedgerCounts (pure ledger→counts reduction)', () => {
  const entry = (overrides: Partial<HostBudgetEntry>): HostBudgetEntry =>
    makeBudgetEntry(overrides) as HostBudgetEntry;

  it('counts fresh entries whose pane is live, per kind', () => {
    const entries = [
      entry({ kind: 'implement', itemId: 'WL-A', paneId: 'p1' }),
      entry({ kind: 'implement', itemId: 'WL-B', paneId: 'p2' }),
      entry({ kind: 'audit', itemId: 'WL-C', paneId: 'p3' }),
    ];
    const reduction = reduceLedgerCounts(
      entries,
      livePaneIdSet(
        makeLivePaneList([
          { paneId: 'p1', itemId: 'WL-A' },
          { paneId: 'p2', itemId: 'WL-B' },
          { paneId: 'p3', itemId: 'WL-C' },
        ]),
      ),
      NOW,
    );
    expect(reduction.counts).toEqual({ implement: 2, audit: 1 });
    expect(reduction.reaped).toEqual([]);
    expect(reduction.retained).toHaveLength(3);
  });

  it('reaps an entry whose heartbeat is stale and whose pane is gone', () => {
    const crashed = entry({
      kind: 'implement',
      itemId: 'WL-CRASH',
      paneId: 'p1',
      heartbeatAt: new Date(NOW - HOST_BUDGET_STALE_WINDOW_MS - 1).toISOString(),
    });
    const reduction = reduceLedgerCounts([crashed], livePaneIdSet([]), NOW);
    expect(reduction.counts).toEqual({ implement: 0, audit: 0 });
    expect(reduction.reaped.map((e) => e.itemId)).toEqual(['WL-CRASH']);
    expect(reduction.retained).toEqual([]);
  });

  it('retains but does not count a fresh entry that has no live pane yet (spawn window)', () => {
    const pending = entry({ itemId: 'WL-PENDING', paneId: 'p1' });
    const reduction = reduceLedgerCounts([pending], livePaneIdSet([]), NOW);
    expect(reduction.counts).toEqual({ implement: 0, audit: 0 });
    expect(reduction.reaped).toEqual([]);
    expect(reduction.retained).toHaveLength(1);
  });

  it('retains a stale entry while its pane is still alive (long-running dispatch)', () => {
    const longRunning = entry({
      itemId: 'WL-LONG',
      paneId: 'p1',
      heartbeatAt: new Date(NOW - 3 * HOUR).toISOString(),
    });
    const reduction = reduceLedgerCounts(
      [longRunning],
      livePaneIdSet(makeLivePaneList([{ paneId: 'p1', itemId: 'WL-LONG' }])),
      NOW,
    );
    expect(reduction.counts).toEqual({ implement: 0, audit: 0 });
    expect(reduction.reaped).toEqual([]);
    expect(reduction.retained).toHaveLength(1);
  });

  it('does not mutate its input', () => {
    const entries = [entry({ itemId: 'WL-A', paneId: 'p1' })];
    reduceLedgerCounts(entries, livePaneIdSet([]), NOW);
    expect(entries).toHaveLength(1);
  });
});

// ── Ledger read ────────────────────────────────────────────────────────

describe('readBudget', () => {
  it('treats a missing ledger as an empty version-1 ledger (first run)', async () => {
    await withMachineDir(() => {
      const read = readBudget();
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.unknown).toBe(false);
      expect(read.ledger).toEqual({ version: 1, entries: [] });
    });
  });

  it('round-trips a valid ledger, including the paneId and override fields', async () => {
    await withMachineDir((dir) => {
      const entries = [
        makeBudgetEntry({
          kind: 'implement',
          itemId: 'WL-A',
          instanceId: 'instance-a',
          paneId: 'pane-a',
          root: '/repo/a',
          startedAt: new Date(NOW - HOUR).toISOString(),
          heartbeatAt: new Date(NOW).toISOString(),
        }),
        makeBudgetEntry({
          kind: 'audit',
          itemId: 'WL-B',
          instanceId: 'instance-b',
          override: { by: 'user' },
        }),
      ];
      writeBudgetLedger(dir, entries);
      expect(budgetLedgerPath(dir)).toBe(fixtureLedgerPath(dir));

      const read = readBudget();
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.ledger.version).toBe(1);
      expect(read.ledger.entries).toEqual(entries);
    });
  });

  it('reports an unknown result (never a silent zero) for corrupt bytes', async () => {
    const corruptDocuments = [
      '', // empty file
      '   ', // whitespace only
      '{ not json',
      '[]', // wrong top-level type
      '42',
      '{"version":2,"entries":[]}', // unknown schema version
      '{"version":1}', // missing entries
      '{"version":1,"entries":{}}', // entries not an array
      '{"version":1,"entries":[{}]}', // malformed entry
      // A valid entry whose kind is outside the v1 tiers would be miscounted.
      `{"version":1,"entries":[{"kind":"plan","itemId":"WL-A","instanceId":"i","root":"/r","startedAt":"${new Date(NOW).toISOString()}","heartbeatAt":"${new Date(NOW).toISOString()}"}]}`,
      // An invalid paneId shape.
      `{"version":1,"entries":[{"kind":"audit","itemId":"WL-A","instanceId":"i","root":"/r","paneId":7,"startedAt":"${new Date(NOW).toISOString()}","heartbeatAt":"${new Date(NOW).toISOString()}"}]}`,
    ];
    await withMachineDir((dir) => {
      for (const document of corruptDocuments) {
        writeRawBudgetLedger(dir, document);
        const read = readBudget();
        expect(read.ok, document).toBe(false);
        if (read.ok) continue;
        expect(read.unknown, document).toBe(true);
        expect(read.reason, document).toBe('corrupt');
      }
    });
  });

  it('reports an unknown result when the ledger path is unreadable', async () => {
    await withMachineDir((dir) => {
      // A directory at the ledger path makes readFileSync fail with EISDIR,
      // which is an I/O error rather than "no ledger".
      mkdirSync(budgetLedgerPath(dir), { recursive: true });
      const read = readBudget();
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.unknown).toBe(true);
      expect(read.reason).toBe('unreadable');
    });
  });

  it('reports "no ledger" (unknown: false) for an unresolvable coordination dir', async () => {
    const injected = readBudget({ dir: null });
    expect(injected).toEqual({ ok: false, unknown: false, reason: 'no-coordination-dir' });

    // The production resolver path: no env override and no home directory.
    const savedHome = process.env.HOME;
    const savedDir = process.env.HERDR_COORDINATION_DIR;
    delete process.env.HERDR_COORDINATION_DIR;
    process.env.HOME = '';
    try {
      expect(readBudget()).toEqual({
        ok: false,
        unknown: false,
        reason: 'no-coordination-dir',
      });
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedDir === undefined) delete process.env.HERDR_COORDINATION_DIR;
      else process.env.HERDR_COORDINATION_DIR = savedDir;
    }
  });
});

// ── Reserve / release ──────────────────────────────────────────────────

describe('reserve / release', () => {
  it('reserves one entry with the injected clock and a valid atomic file', async () => {
    await withMachineDir((dir) => {
      const result = reserve(
        { kind: 'implement', itemId: 'WL-A', instanceId: 'instance-a', root: '/repo/a' },
        { now: NOW },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const iso = new Date(NOW).toISOString();
      expect(result.entry).toEqual({
        kind: 'implement',
        itemId: 'WL-A',
        instanceId: 'instance-a',
        root: '/repo/a',
        startedAt: iso,
        heartbeatAt: iso,
      });

      const raw = readFileSync(budgetLedgerPath(dir), 'utf8');
      expect(JSON.parse(raw)).toEqual({ version: 1, entries: [result.entry] });
      // Atomic tmp+rename leaves no partial file behind.
      expect(readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([]);
    });
  });

  it('records a pane id and a user override when supplied', async () => {
    await withMachineDir(() => {
      const result = reserve(
        {
          kind: 'audit',
          itemId: 'WL-A',
          instanceId: 'instance-a',
          root: '/repo/a',
          paneId: 'pane-1',
          override: { by: 'user' },
        },
        { now: NOW },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.entry.paneId).toBe('pane-1');
      expect(result.entry.override).toEqual({ by: 'user' });
    });
  });

  it('upserts by itemId: refreshes the heartbeat, adopts a pane, preserves startedAt', async () => {
    await withMachineDir((dir) => {
      reserve(
        { kind: 'implement', itemId: 'WL-A', instanceId: 'instance-a', root: '/repo/a' },
        { now: NOW - HOUR },
      );
      const second = reserve(
        {
          kind: 'implement',
          itemId: 'WL-A',
          instanceId: 'instance-a',
          root: '/repo/a',
          paneId: 'pane-1',
          override: { by: 'user' },
        },
        { now: NOW },
      );
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.entry.startedAt).toBe(new Date(NOW - HOUR).toISOString());
      expect(second.entry.heartbeatAt).toBe(new Date(NOW).toISOString());
      expect(second.entry.paneId).toBe('pane-1');
      expect(second.entry.override).toEqual({ by: 'user' });

      const read = readBudget();
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.ledger.entries).toHaveLength(1);

      // A later re-reserve without an override keeps the recorded one.
      const third = reserve(
        { kind: 'implement', itemId: 'WL-A', instanceId: 'instance-a', root: '/repo/a', paneId: 'pane-1' },
        { now: NOW + HOUR },
      );
      expect(third.ok).toBe(true);
      if (!third.ok) return;
      expect(third.entry.override).toEqual({ by: 'user' });
      expect(JSON.parse(readFileSync(budgetLedgerPath(dir), 'utf8')).entries).toHaveLength(1);
    });
  });

  it('rejects invalid input and writes nothing', async () => {
    await withMachineDir(() => {
      expect(
        reserve({ kind: 'implement', itemId: '', instanceId: 'i', root: '/r' }).ok,
      ).toBe(false);
      const badKind = reserve({
        kind: 'plan' as unknown as 'implement',
        itemId: 'WL-A',
        instanceId: 'i',
        root: '/r',
      });
      expect(badKind).toEqual({ ok: false, unknown: false, reason: 'invalid-input' });
      expect(readBudget().ok).toBe(true);
    });
  });

  it('releases by itemId, is idempotent, and never creates a missing ledger', async () => {
    await withMachineDir((dir) => {
      expect(existsSync(budgetLedgerPath(dir))).toBe(false);
      expect(release('WL-A')).toEqual({ ok: true, removed: false });
      expect(existsSync(budgetLedgerPath(dir))).toBe(false);

      reserve(
        { kind: 'implement', itemId: 'WL-A', instanceId: 'i', root: '/r' },
        { now: NOW },
      );
      expect(release('WL-A')).toEqual({ ok: true, removed: true });
      expect(release('WL-A')).toEqual({ ok: true, removed: false });
      const read = readBudget();
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.ledger.entries).toEqual([]);
    });
  });

  it('refuses to rewrite a corrupt ledger and leaves its bytes untouched', async () => {
    await withMachineDir((dir) => {
      writeRawBudgetLedger(dir, '{ corrupt');
      const before = readFileSync(budgetLedgerPath(dir), 'utf8');

      const reserved = reserve({
        kind: 'implement',
        itemId: 'WL-A',
        instanceId: 'i',
        root: '/r',
      });
      expect(reserved).toEqual({ ok: false, unknown: true, reason: 'corrupt' });
      expect(release('WL-A')).toEqual({ ok: false, unknown: true, reason: 'corrupt' });
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(before);
    });
  });

  it('never loses an entry when two writers share the lock', async () => {
    await withMachineDir((dir) => {
      // Writer A takes the coordination lock and completes its read-modify-write
      // while still holding it (the fixture's raw writer stands in for A's
      // write, so no second production writer is needed).
      const releaseLock = tryAcquireCoordLock(dir);
      expect(releaseLock).not.toBeNull();
      const blocked = reserve(
        { kind: 'implement', itemId: 'WL-A', instanceId: 'instance-a', root: '/repo/a' },
        { now: NOW },
      );
      // B is refused, so B can never clobber A's entry.
      expect(blocked).toEqual({ ok: false, unknown: false, reason: 'lock-contention' });
      writeBudgetLedger(dir, [
        makeBudgetEntry({ itemId: 'WL-A', instanceId: 'instance-a', root: '/repo/a' }),
      ]);
      releaseLock?.();

      // B's retry after the lock is free adds its own entry; A's survives.
      expect(
        reserve(
          { kind: 'audit', itemId: 'WL-B', instanceId: 'instance-b', root: '/repo/b' },
          { now: NOW },
        ).ok,
      ).toBe(true);
      const read = readBudget();
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.ledger.entries.map((entry) => entry.itemId)).toEqual(['WL-A', 'WL-B']);
    });
  });

  it('lets two fake herdr instances share one ledger on the machine', async () => {
    await withMachineDir((dir) => {
      const a = makeInstance('instance-a', { workItemId: 'WL-AAA' });
      const b = makeInstance('instance-b', { workItemId: 'WL-BBB' });
      const panes = makeLivePaneList([a.workItemId, { paneId: 'pane-b', itemId: b.workItemId }]);

      expect(
        reserve(
          {
            kind: 'implement',
            itemId: a.workItemId,
            instanceId: a.instanceId,
            root: a.worklogRoot,
            paneId: panes[0].paneId,
          },
          { now: NOW },
        ).ok,
      ).toBe(true);
      // Instance B sees A's entry through the same machine file.
      expect(liveCount('implement', panes, { now: NOW }).ok).toBe(true);
      expect(liveCount('implement', panes, { now: NOW })).toMatchObject({ ok: true, count: 1 });

      expect(
        reserve(
          {
            kind: 'audit',
            itemId: b.workItemId,
            instanceId: b.instanceId,
            root: b.worklogRoot,
            paneId: panes[1].paneId,
          },
          { now: NOW },
        ).ok,
      ).toBe(true);

      const read = readBudget();
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.ledger.entries.map((entry) => entry.instanceId).sort()).toEqual([
        'instance-a',
        'instance-b',
      ]);
      expect(liveCount('implement', panes, { now: NOW })).toMatchObject({ count: 1 });
      expect(liveCount('audit', panes, { now: NOW })).toMatchObject({ count: 1 });
      expect(readdirSync(dir)).toContain('dispatch-budget.json');
    });
  });
});

// ── Reap / liveCount ───────────────────────────────────────────────────

describe('reap and liveCount', () => {
  const panes = makeLivePaneList(['WL-LIVE', 'WL-AUDIT']);

  /** Seed: a live implement, a crashed implement (stale, no pane) and a live audit. */
  function seedMixedLedger(dir: string): void {
    writeBudgetLedger(dir, [
      makeBudgetEntry({
        kind: 'implement',
        itemId: 'WL-LIVE',
        paneId: 'pane-1',
        heartbeatAt: new Date(NOW - HOUR).toISOString(),
      }),
      makeBudgetEntry({
        kind: 'implement',
        itemId: 'WL-CRASHED',
        paneId: 'pane-gone',
        heartbeatAt: new Date(NOW - HOST_BUDGET_STALE_WINDOW_MS - 1).toISOString(),
      }),
      makeBudgetEntry({
        kind: 'audit',
        itemId: 'WL-AUDIT',
        paneId: 'pane-2',
        heartbeatAt: new Date(NOW).toISOString(),
      }),
    ]);
  }

  it('counts live panes per tier and reaps a crashed leader on read', async () => {
    await withMachineDir((dir) => {
      seedMixedLedger(dir);

      const implement = liveCount('implement', panes, { now: NOW });
      expect(implement).toEqual({
        ok: true,
        kind: 'implement',
        count: 1,
        counts: { implement: 1, audit: 1 },
      });
      // The stale, pane-less entry is gone from disk — dispatch can resume.
      const read = readBudget();
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.ledger.entries.map((entry) => entry.itemId).sort()).toEqual([
        'WL-AUDIT',
        'WL-LIVE',
      ]);
      expect(liveCount('implement', panes, { now: NOW })).toMatchObject({ count: 1 });
    });
  });

  it('reports the same counts through reap and removes only the reaped entry', async () => {
    await withMachineDir((dir) => {
      seedMixedLedger(dir);
      const result = reap(panes, { now: NOW });
      expect(result).toEqual({ ok: true, reaped: 1, counts: { implement: 1, audit: 1 } });
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toContain('WL-LIVE');
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).not.toContain('WL-CRASHED');

      // Idempotent: nothing left to reap, nothing rewritten.
      expect(reap(panes, { now: NOW })).toEqual({
        ok: true,
        reaped: 0,
        counts: { implement: 1, audit: 1 },
      });
    });
  });

  it('retains fresh pane-less and stale-but-live entries without counting them', async () => {
    await withMachineDir((dir) => {
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          itemId: 'WL-SPAWNING',
          paneId: 'pane-not-yet-live',
          heartbeatAt: new Date(NOW).toISOString(),
        }),
        makeBudgetEntry({
          itemId: 'WL-LIVE',
          paneId: 'pane-1',
          heartbeatAt: new Date(NOW - 3 * HOUR).toISOString(),
        }),
      ]);
      expect(liveCount('implement', panes, { now: NOW })).toMatchObject({ count: 0 });
      expect(reap(panes, { now: NOW })).toMatchObject({ ok: true, reaped: 0, counts: { implement: 0 } });
      const read = readBudget();
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.ledger.entries.map((entry) => entry.itemId)).toEqual([
        'WL-SPAWNING',
        'WL-LIVE',
      ]);
    });
  });

  it('still returns the correct count when the reap write cannot take the lock', async () => {
    await withMachineDir((dir) => {
      seedMixedLedger(dir);
      const releaseLock = tryAcquireCoordLock(dir);
      expect(releaseLock).not.toBeNull();
      try {
        // Count is correct from the non-locking read; the reap is deferred.
        expect(liveCount('implement', panes, { now: NOW })).toEqual({
          ok: true,
          kind: 'implement',
          count: 1,
          counts: { implement: 1, audit: 1 },
        });
        expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toContain('WL-CRASHED');
      } finally {
        releaseLock?.();
      }
      // Once the lock is free the next read reaps it.
      expect(liveCount('implement', panes, { now: NOW })).toMatchObject({ count: 1 });
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).not.toContain('WL-CRASHED');
    });
  });

  it('surfaces an unknown ledger and never rewrites it', async () => {
    await withMachineDir((dir) => {
      writeRawBudgetLedger(dir, '{ corrupt');
      const before = readFileSync(budgetLedgerPath(dir), 'utf8');
      expect(liveCount('implement', panes, { now: NOW })).toEqual({
        ok: false,
        unknown: true,
        reason: 'corrupt',
      });
      expect(reap(panes, { now: NOW })).toEqual({
        ok: false,
        unknown: true,
        reason: 'corrupt',
      });
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(before);
    });
  });

  it('degrades to "no ledger" for an unresolvable coordination dir', () => {
    for (const result of [
      liveCount('implement', [], { dir: null, now: NOW }),
      reap([], { dir: null, now: NOW }),
      reserve({ kind: 'implement', itemId: 'WL-A', instanceId: 'i', root: '/r' }, { dir: null }),
      release('WL-A', { dir: null }),
    ]) {
      expect(result).toEqual({ ok: false, unknown: false, reason: 'no-coordination-dir' });
    }
  });
});

// ── Machine configuration ──────────────────────────────────────────────

describe('readBudgetConfig', () => {
  it('uses the defaults when budget.json is absent', async () => {
    await withMachineDir(() => {
      expect(readBudgetConfig({ env: cleanEnv })).toEqual({
        config: { maxImplement: 2, maxAudit: 1 },
        warnings: [],
      });
    });
  });

  it('reads the machine file (including 0 and clamping)', async () => {
    await withMachineDir((dir) => {
      expect(budgetConfigPath(dir)).toBe(join(dir, HOST_BUDGET_CONFIG_FILE));
      writeFileSync(join(dir, HOST_BUDGET_CONFIG_FILE), JSON.stringify({ maxImplement: 3, maxAudit: 0 }));
      expect(readBudgetConfig({ env: cleanEnv })).toEqual({
        config: { maxImplement: 3, maxAudit: 0 },
        warnings: [],
      });

      writeFileSync(join(dir, HOST_BUDGET_CONFIG_FILE), JSON.stringify({ maxImplement: 1e9, maxAudit: 4 }));
      expect(readBudgetConfig({ env: cleanEnv }).config).toEqual({
        maxImplement: HOST_BUDGET_MAX,
        maxAudit: 4,
      });
    });
  });

  it('lets the env override win over the file', async () => {
    await withMachineDir((dir) => {
      writeFileSync(join(dir, HOST_BUDGET_CONFIG_FILE), JSON.stringify({ maxImplement: 3, maxAudit: 2 }));
      const result = readBudgetConfig({
        env: { [HOST_BUDGET_ENV_KEYS.implement]: '4', [HOST_BUDGET_ENV_KEYS.audit]: '0' },
      });
      expect(result.config).toEqual({ maxImplement: 4, maxAudit: 0 });
      expect(result.warnings).toEqual([]);
    });
  });

  it('falls back to defaults with a warning for malformed content', async () => {
    await withMachineDir((dir) => {
      const file = join(dir, HOST_BUDGET_CONFIG_FILE);

      writeFileSync(file, '{ not json');
      const invalidJson = readBudgetConfig({ env: cleanEnv });
      expect(invalidJson.config).toEqual({ maxImplement: 2, maxAudit: 1 });
      expect(invalidJson.warnings).toHaveLength(1);
      expect(invalidJson.warnings[0]).toContain('not valid JSON');

      writeFileSync(file, JSON.stringify(['nope']));
      const wrongShape = readBudgetConfig({ env: cleanEnv });
      expect(wrongShape.config).toEqual({ maxImplement: 2, maxAudit: 1 });
      expect(wrongShape.warnings[0]).toContain('not a JSON object');

      writeFileSync(file, JSON.stringify({ maxImplement: 'two' }));
      const invalidTier = readBudgetConfig({ env: cleanEnv });
      expect(invalidTier.config).toEqual({ maxImplement: 2, maxAudit: 1 });
      expect(invalidTier.warnings).toHaveLength(1);
      expect(invalidTier.warnings[0]).toContain('maxImplement');
    });
  });

  it('falls back to defaults with a warning when budget.json is unreadable', async () => {
    await withMachineDir((dir) => {
      mkdirSync(join(dir, HOST_BUDGET_CONFIG_FILE), { recursive: true });
      const result = readBudgetConfig({ env: cleanEnv });
      expect(result.config).toEqual({ maxImplement: 2, maxAudit: 1 });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('unreadable');
    });
  });

  it('degrades as today for an unresolvable dir: defaults + env, warning only', () => {
    const result = readBudgetConfig({
      dir: null,
      env: { [HOST_BUDGET_ENV_KEYS.implement]: '1' },
    });
    expect(result.config).toEqual({ maxImplement: 1, maxAudit: 1 });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('coordination dir unresolvable');
  });

  it('keeps a seeded fixture ledger and a seeded config independent', async () => {
    await withMachineDir((dir) => {
      // The F0 fixture's raw seeder writes ledger bytes the production reader
      // must accept; the config file is unrelated machine state.
      seedBudgetLedger(dir, [makeBudgetEntry({ itemId: 'WL-A', paneId: 'pane-1' })]);
      writeFileSync(join(dir, HOST_BUDGET_CONFIG_FILE), JSON.stringify({ maxImplement: 0 }));
      expect(readBudget().ok).toBe(true);
      expect(readBudgetConfig({ env: cleanEnv }).config).toEqual({ maxImplement: 0, maxAudit: 1 });
    });
  });
});
