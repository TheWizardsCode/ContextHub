/**
 * Unit tests for scheduled-prompts.ts — project-local scheduled-prompts
 * config for the downtime dispatcher (WL-0MSS1Q5ER007QDKX).
 *
 * Covers the AC8 matrix for the scheduled-prompts tier: config
 * parse/defaults, due-check arithmetic (null lastTriggeredAt, boundary,
 * not-yet-due), absent/malformed-config fail-closed, invalid-entry
 * skipping, config-order selection, and the atomic tmp+rename persist
 * (updateScheduledPromptLastTriggered).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdtempSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DAY_MS,
  SCHEDULED_PROMPTS_FILE,
  scheduledPromptsPath,
  parseScheduledPrompt,
  isValidScheduledPrompt,
  isDueScheduledPrompt,
  getDueScheduledPrompt,
  loadScheduledPrompts,
  saveScheduledPrompts,
  updateScheduledPromptLastTriggered,
  type ScheduledPrompt,
} from './scheduled-prompts.js';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scheduled-prompts-test-'));
  tempDirs.push(dir);
  return dir;
}

const refactorPrompt: ScheduledPrompt = {
  id: '/skill:refactor',
  prompt: '/skill:refactor',
  intervalDays: 3,
  lastTriggeredAt: null,
};

describe('scheduledPromptsPath', () => {
  it('resolves the config file inside <cwd>/.worklog', () => {
    expect(scheduledPromptsPath('/repo')).toBe(
      join('/repo', '.worklog', SCHEDULED_PROMPTS_FILE),
    );
  });
});

// ── Parsing (AC7: invalid entries are rejected fail-closed) ──────────

describe('parseScheduledPrompt', () => {
  it('accepts a well-formed entry', () => {
    expect(parseScheduledPrompt(refactorPrompt)).toEqual(refactorPrompt);
  });

  it('rejects a missing/empty id', () => {
    expect(parseScheduledPrompt({ ...refactorPrompt, id: '' })).toBeNull();
    expect(parseScheduledPrompt({ ...refactorPrompt, id: 42 })).toBeNull();
  });

  it('rejects a missing or empty prompt text', () => {
    expect(parseScheduledPrompt({ ...refactorPrompt, prompt: '' })).toBeNull();
    expect(parseScheduledPrompt({ ...refactorPrompt, prompt: '   ' })).toBeNull();
    expect(parseScheduledPrompt({ ...refactorPrompt, prompt: 7 })).toBeNull();
  });

  it('rejects missing/non-finite/zero/negative intervalDays', () => {
    expect(parseScheduledPrompt({ ...refactorPrompt, intervalDays: undefined })).toBeNull();
    expect(parseScheduledPrompt({ ...refactorPrompt, intervalDays: Number.NaN })).toBeNull();
    expect(parseScheduledPrompt({ ...refactorPrompt, intervalDays: 0 })).toBeNull();
    expect(parseScheduledPrompt({ ...refactorPrompt, intervalDays: -3 })).toBeNull();
    expect(parseScheduledPrompt({ ...refactorPrompt, intervalDays: '3' })).toBeNull();
  });

  it('accepts a missing lastTriggeredAt and normalizes it to null (treated as due, AC7)', () => {
    const { lastTriggeredAt: _omit, ...rest } = refactorPrompt;
    const parsed = parseScheduledPrompt(rest);
    expect(parsed).toEqual({ ...refactorPrompt, lastTriggeredAt: null });
  });

  it('rejects a non-string or unparseable lastTriggeredAt (fail-closed)', () => {
    expect(parseScheduledPrompt({ ...refactorPrompt, lastTriggeredAt: 123 })).toBeNull();
    expect(parseScheduledPrompt({ ...refactorPrompt, lastTriggeredAt: 'not-a-date' })).toBeNull();
  });

  it('rejects non-object entries', () => {
    expect(parseScheduledPrompt(null)).toBeNull();
    expect(parseScheduledPrompt('refactor')).toBeNull();
    expect(parseScheduledPrompt(42)).toBeNull();
  });
});

// ── Due-check arithmetic (AC3: due iff null or now - last >= intervalDays) ──

describe('isDueScheduledPrompt', () => {
  const now = Date.parse('2026-08-17T00:00:00.000Z');

  it('null lastTriggeredAt means never run → due', () => {
    expect(isDueScheduledPrompt({ ...refactorPrompt, lastTriggeredAt: null }, now)).toBe(true);
  });

  it('is exactly due when now - last == intervalDays (boundary, >=)', () => {
    const last = new Date(now - 3 * DAY_MS).toISOString();
    expect(isDueScheduledPrompt({ ...refactorPrompt, lastTriggeredAt: last }, now)).toBe(true);
  });

  it('is not yet due one ms before the boundary', () => {
    const last = new Date(now - 3 * DAY_MS + 1).toISOString();
    expect(isDueScheduledPrompt({ ...refactorPrompt, lastTriggeredAt: last }, now)).toBe(false);
  });

  it('is due once past the interval', () => {
    const last = new Date(now - 10 * DAY_MS).toISOString();
    expect(isDueScheduledPrompt({ ...refactorPrompt, lastTriggeredAt: last }, now)).toBe(true);
  });

  it('a lastTriggeredAt in the future (clock skew) is not due', () => {
    const last = new Date(now + DAY_MS).toISOString();
    expect(isDueScheduledPrompt({ ...refactorPrompt, lastTriggeredAt: last }, now)).toBe(false);
  });

  it('applies the entry-specific intervalDays', () => {
    const weekly = { ...refactorPrompt, id: 'weekly', intervalDays: 7 };
    const last = new Date(now - 3 * DAY_MS).toISOString();
    // 3 days elapsed; due for the 3-day entry, NOT for the weekly entry.
    expect(isDueScheduledPrompt({ ...refactorPrompt, lastTriggeredAt: last }, now)).toBe(true);
    expect(isDueScheduledPrompt({ ...weekly, lastTriggeredAt: last }, now)).toBe(false);
  });
});

// ── Selection (AC6/AC7: first due entry in config order) ─────────────

describe('getDueScheduledPrompt', () => {
  const now = Date.parse('2026-08-17T00:00:00.000Z');
  const due = { ...refactorPrompt, lastTriggeredAt: null };
  const notDue = {
    ...refactorPrompt,
    id: 'not-yet',
    lastTriggeredAt: new Date(now - DAY_MS).toISOString(), // due in 2 days
  };

  it('returns null when no entry is due', () => {
    expect(getDueScheduledPrompt([notDue], now)).toBeNull();
    expect(getDueScheduledPrompt([], now)).toBeNull();
  });

  it('returns the FIRST due entry in config order when several are due', () => {
    const first = { ...due, id: 'first' };
    const second = { ...due, id: 'second' };
    expect(getDueScheduledPrompt([first, second], now)?.id).toBe('first');
    // Unconfigured order is preserved — the input order is authoritative.
    expect(getDueScheduledPrompt([second, first], now)?.id).toBe('second');
  });

  it('skips non-due entries before the first due one', () => {
    expect(getDueScheduledPrompt([notDue, due], now)?.id).toBe('/skill:refactor');
  });
});

// ── Load (AC2: absent ⇒ empty set + notice; malformed ⇒ empty set + error) ──

describe('loadScheduledPrompts', () => {
  let cwd: string;
  const logs: string[] = [];
  const collectLog = (msg: string) => logs.push(msg);

  beforeEach(() => {
    cwd = makeTempDir();
    logs.length = 0;
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  it('treats an absent config as an empty set (fail-closed) with NO log output', () => {
    // Absence is the expected/provisioned state — the loader is silent here
    // (WL-0MTF5UAJ4000LLZ9); only malformed/unreadable configs log.
    const result = loadScheduledPrompts(cwd, collectLog);
    expect(result.entries).toEqual([]);
    expect(result.absent).toBe(true);
    expect(result.malformed).toBe(false);
    expect(logs).toEqual([]);
  });

  it('treats malformed JSON as an empty set (fail-closed) and logs an error', () => {
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(scheduledPromptsPath(cwd), '{not json', 'utf8');
    const result = loadScheduledPrompts(cwd, collectLog);
    expect(result.entries).toEqual([]);
    expect(result.absent).toBe(false);
    expect(result.malformed).toBe(true);
    expect(logs.join('\n')).toContain('fail-closed');
  });

  it('treats a config without an entries list as malformed (fail-closed)', () => {
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(scheduledPromptsPath(cwd), JSON.stringify({ version: 1 }), 'utf8');
    const result = loadScheduledPrompts(cwd, collectLog);
    expect(result.entries).toEqual([]);
    expect(result.malformed).toBe(true);
  });

  it('parses a valid config, skipping invalid entries with a warning (AC7)', () => {
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      scheduledPromptsPath(cwd),
      JSON.stringify({
        entries: [
          refactorPrompt,
          { id: 'broken', prompt: '', intervalDays: 0, lastTriggeredAt: null },
          { id: 'weekly', prompt: '/skill:refactor', intervalDays: 7, lastTriggeredAt: null },
        ],
      }),
      'utf8',
    );
    const result = loadScheduledPrompts(cwd, collectLog);
    expect(result.absent).toBe(false);
    expect(result.malformed).toBe(false);
    expect(result.entries.map((e) => e.id)).toEqual(['/skill:refactor', 'weekly']);
    expect(logs.join('\n')).toContain('invalid entry');
  });

  it('loads a config written by saveScheduledPrompts', async () => {
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    await saveScheduledPrompts(cwd, { entries: [refactorPrompt] });
    const result = loadScheduledPrompts(cwd, collectLog);
    expect(result.entries).toEqual([refactorPrompt]);
  });
});

// ── Atomic persist (AC4: tmp+rename; failures fail closed) ───────────

describe('saveScheduledPrompts', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTempDir();
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  it('creates the .worklog directory and writes the config JSON', async () => {
    await saveScheduledPrompts(cwd, { entries: [refactorPrompt] });
    const file = scheduledPromptsPath(cwd);
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { entries: ScheduledPrompt[] };
    expect(parsed.entries).toEqual([refactorPrompt]);
  });

  it('leaves no tmp file behind after a successful write (atomic tmp+rename)', async () => {
    await saveScheduledPrompts(cwd, { entries: [refactorPrompt] });
    const dirEntries = readdirSync(join(cwd, '.worklog'));
    expect(dirEntries).toEqual([SCHEDULED_PROMPTS_FILE]);
  });

  it('overwrites an existing file atomically (create-if-absent is the CLI contract, not the save contract)', async () => {
    await saveScheduledPrompts(cwd, { entries: [refactorPrompt] });
    await saveScheduledPrompts(cwd, {
      entries: [{ ...refactorPrompt, id: 'weekly', intervalDays: 7 }],
    });
    const parsed = JSON.parse(readFileSync(scheduledPromptsPath(cwd), 'utf8')) as { entries: ScheduledPrompt[] };
    expect(parsed.entries.map((e) => e.id)).toEqual(['weekly']);
  });
});

describe('updateScheduledPromptLastTriggered', () => {
  let cwd: string;
  const at = '2026-08-17T12:00:00.000Z';

  beforeEach(() => {
    cwd = makeTempDir();
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  it('persists lastTriggeredAt and preserves the other entries', async () => {
    const weekly = { ...refactorPrompt, id: 'weekly', intervalDays: 7 };
    await saveScheduledPrompts(cwd, { entries: [weekly, refactorPrompt] });
    const ok = await updateScheduledPromptLastTriggered(cwd, '/skill:refactor', at);
    expect(ok).toBe(true);

    const parsed = JSON.parse(readFileSync(scheduledPromptsPath(cwd), 'utf8')) as { entries: ScheduledPrompt[] };
    expect(parsed.entries.find((e) => e.id === '/skill:refactor')?.lastTriggeredAt).toBe(at);
    expect(parsed.entries.find((e) => e.id === 'weekly')?.lastTriggeredAt).toBeNull();
  });

  it('preserves unknown top-level fields (e.g. version) on rewrite', async () => {
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      scheduledPromptsPath(cwd),
      JSON.stringify({ version: 2, entries: [refactorPrompt] }),
      'utf8',
    );
    await updateScheduledPromptLastTriggered(cwd, '/skill:refactor', at);
    const parsed = JSON.parse(readFileSync(scheduledPromptsPath(cwd), 'utf8')) as Record<string, unknown>;
    expect(parsed.version).toBe(2);
  });

  it('returns false when the entry id is unknown (fail-closed)', async () => {
    await saveScheduledPrompts(cwd, { entries: [refactorPrompt] });
    expect(await updateScheduledPromptLastTriggered(cwd, 'nope', at)).toBe(false);
  });

  it('returns false when the config is absent or malformed (fail-closed, never throws)', async () => {
    expect(await updateScheduledPromptLastTriggered(cwd, '/skill:refactor', at)).toBe(false);
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(scheduledPromptsPath(cwd), '{broken', 'utf8');
    expect(await updateScheduledPromptLastTriggered(cwd, '/skill:refactor', at)).toBe(false);
  });

  it('returns false when the target entry is not an object (fail-closed)', async () => {
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      scheduledPromptsPath(cwd),
      JSON.stringify({ entries: ['refactor'] }),
      'utf8',
    );
    expect(await updateScheduledPromptLastTriggered(cwd, 'refactor', at)).toBe(false);
  });
});

// ── isValidScheduledPrompt is the parse predicate ─────────────────────

describe('isValidScheduledPrompt', () => {
  it('mirrors parseScheduledPrompt', () => {
    expect(isValidScheduledPrompt(refactorPrompt)).toBe(true);
    expect(isValidScheduledPrompt({ ...refactorPrompt, prompt: '' })).toBe(false);
    expect(isValidScheduledPrompt({ ...refactorPrompt, intervalDays: -1 })).toBe(false);
  });
});
// ── time field (WL-0MTMN7W63001FCQR) ───────────────────────────────────

import { isValidTimeHHMM, isAtOrAfterScheduledTime } from './scheduled-prompts.js';

describe('isValidTimeHHMM', () => {
  it('accepts valid HH:MM values', () => {
    expect(isValidTimeHHMM('00:00')).toBe(true);
    expect(isValidTimeHHMM('06:05')).toBe(true);
    expect(isValidTimeHHMM('23:59')).toBe(true);
    expect(isValidTimeHHMM('09:09')).toBe(true);
  });
  it('rejects invalid HH:MM values', () => {
    expect(isValidTimeHHMM('24:00')).toBe(false);
    expect(isValidTimeHHMM('6:05')).toBe(false);  // no leading zero
    expect(isValidTimeHHMM('06:5')).toBe(false);
    expect(isValidTimeHHMM('06:05:00')).toBe(false);
    expect(isValidTimeHHMM('')).toBe(false);
    expect(isValidTimeHHMM('ab:cd')).toBe(false);
    expect(isValidTimeHHMM(' 06:05')).toBe(false);
  });
});

describe('parseScheduledPrompt with time', () => {
  it('accepts a valid time field', () => {
    const parsed = parseScheduledPrompt({ ...refactorPrompt, time: '06:05' });
    expect(parsed).not.toBeNull();
    expect(parsed!.time).toBe('06:05');
  });
  it('omits time when absent (backward-compatible)', () => {
    const parsed = parseScheduledPrompt(refactorPrompt);
    expect(parsed).not.toBeNull();
    expect(parsed!.time).toBeUndefined();
  });
  it('rejects an entry with an invalid time (fail-closed)', () => {
    expect(parseScheduledPrompt({ ...refactorPrompt, time: '24:00' })).toBeNull();
    expect(parseScheduledPrompt({ ...refactorPrompt, time: '6:05' })).toBeNull();
    expect(parseScheduledPrompt({ ...refactorPrompt, time: '' })).toBeNull();
    expect(parseScheduledPrompt({ ...refactorPrompt, time: 605 })).toBeNull();
  });
  it('loadScheduledPrompts skips entries with invalid time', async () => {
    const cwd = makeTempDir();
    const { mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
    const { scheduledPromptsPath: spp } = await import('./scheduled-prompts.js');
    mk(join(cwd, '.worklog'), { recursive: true });
    const logs: string[] = [];
    wf(
      spp(cwd),
      JSON.stringify({ entries: [{ ...refactorPrompt, time: 'bad' }, refactorPrompt] }),
      'utf8',
    );
    const result = loadScheduledPrompts(cwd, (m) => logs.push(m));
    expect(result.entries.map((e) => e.id)).toEqual(['/skill:refactor']);
    expect(logs.join('\n')).toContain('invalid entry');
    const { rmSync: rm } = await import('node:fs');
    try { rm(cwd, { recursive: true }); } catch {}
  });
});

describe('isAtOrAfterScheduledTime', () => {
  it('returns true when time is absent (backward-compatible)', () => {
    const now = new Date(2026, 8, 4, 0, 0).getTime();
    expect(isAtOrAfterScheduledTime(refactorPrompt, now)).toBe(true);
  });
  it('returns false before the scheduled time, true at and after', () => {
    const e: ScheduledPrompt = { ...refactorPrompt, time: '06:05' };
    expect(isAtOrAfterScheduledTime(e, new Date(2026, 8, 4, 6, 4, 59, 999).getTime())).toBe(false);
    expect(isAtOrAfterScheduledTime(e, new Date(2026, 8, 4, 6, 5, 0).getTime())).toBe(true);
    expect(isAtOrAfterScheduledTime(e, new Date(2026, 8, 4, 12, 0).getTime())).toBe(true);
  });
  it('returns false for an invalid time (fail-closed)', () => {
    const e = { ...refactorPrompt, time: 'bad' } as ScheduledPrompt;
    expect(isAtOrAfterScheduledTime(e, Date.now())).toBe(false);
  });
});

describe('isDueScheduledPrompt with time (WL-0MTMN7W63001FCQR AC2/AC3)', () => {
  const dailyAt0605: ScheduledPrompt = {
    id: '/skill:standup', prompt: '/skill:standup', intervalDays: 1, lastTriggeredAt: null, time: '06:05',
  };

  it('null lastTriggeredAt: due only at/after time (not before)', () => {
    expect(isDueScheduledPrompt(dailyAt0605, new Date(2026, 8, 4, 5, 59).getTime())).toBe(false);
    expect(isDueScheduledPrompt(dailyAt0605, new Date(2026, 8, 4, 6, 5).getTime())).toBe(true);
    expect(isDueScheduledPrompt(dailyAt0605, new Date(2026, 8, 4, 7, 0).getTime())).toBe(true);
  });

  it('not due again the same calendar day after dispatch', () => {
    const dispatched: ScheduledPrompt = {
      ...dailyAt0605, lastTriggeredAt: new Date(2026, 8, 4, 7, 0).toISOString(),
    };
    expect(isDueScheduledPrompt(dispatched, new Date(2026, 8, 4, 8, 0).getTime())).toBe(false);
    expect(isDueScheduledPrompt(dispatched, new Date(2026, 8, 4, 23, 59).getTime())).toBe(false);
  });

  it('due the next calendar day at/after time even if dispatched late the prior day (no drift)', () => {
    const dispatchedLate: ScheduledPrompt = {
      ...dailyAt0605, lastTriggeredAt: new Date(2026, 8, 4, 8, 0).toISOString(),
    };
    // Same day before midnight: not due (interval gate: 0 days elapsed)
    expect(isDueScheduledPrompt(dispatchedLate, new Date(2026, 8, 4, 23, 59).getTime())).toBe(false);
    // Next day before time: not due (after-time gate)
    expect(isDueScheduledPrompt(dispatchedLate, new Date(2026, 8, 5, 6, 0).getTime())).toBe(false);
    // Next day at time: due even though only ~22h elapsed — calendar day gate, not 24h
    expect(isDueScheduledPrompt(dispatchedLate, new Date(2026, 8, 5, 6, 5).getTime())).toBe(true);
    expect(isDueScheduledPrompt(dispatchedLate, new Date(2026, 8, 5, 8, 0).getTime())).toBe(true);
  });

  it('intervalDays > 1 with time: every N calendar days after time', () => {
    const every3: ScheduledPrompt = {
      id: 'every3', prompt: '/skill:refactor', intervalDays: 3, lastTriggeredAt: new Date(2026, 8, 1, 8, 0).toISOString(), time: '06:05',
    };
    expect(isDueScheduledPrompt(every3, new Date(2026, 8, 3, 6, 5).getTime())).toBe(false); // 2 days
    expect(isDueScheduledPrompt(every3, new Date(2026, 8, 4, 6, 4).getTime())).toBe(false); // 3 days but before time
    expect(isDueScheduledPrompt(every3, new Date(2026, 8, 4, 6, 5).getTime())).toBe(true);  // 3 days + after time
  });

  it('without time: existing 24h interval semantics are unchanged (backward-compatible)', () => {
    const noTime: ScheduledPrompt = { ...refactorPrompt, lastTriggeredAt: new Date(2026, 8, 1, 12, 0).toISOString() };
    expect(isDueScheduledPrompt(noTime, new Date(2026, 8, 4, 12, 0).getTime() - 1)).toBe(false);
    expect(isDueScheduledPrompt(noTime, new Date(2026, 8, 4, 12, 0).getTime())).toBe(true);
  });

  it('getDueScheduledPrompt respects time: skips not-yet-time entries, returns first due in order', () => {
    const early: ScheduledPrompt = { ...dailyAt0605, id: 'early', lastTriggeredAt: null };
    const laterReady: ScheduledPrompt = { ...refactorPrompt, id: 'later' }; // no time, interval due
    // Before 06:05: early is not due, later is due → later wins
    expect(getDueScheduledPrompt([early, laterReady], new Date(2026, 8, 4, 5, 0).getTime())?.id).toBe('later');
    // At 07:00: both due → first in order wins
    expect(getDueScheduledPrompt([early, laterReady], new Date(2026, 8, 4, 7, 0).getTime())?.id).toBe('early');
  });

  it('invalid time entry is never due', () => {
    const bad = { ...refactorPrompt, time: 'bad' } as ScheduledPrompt;
    expect(isDueScheduledPrompt(bad, Date.now())).toBe(false);
    expect(isAtOrAfterScheduledTime(bad, Date.now())).toBe(false);
  });
});
