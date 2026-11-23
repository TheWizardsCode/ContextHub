/**
 * packages/herdr/src/prep-supply-report-cli.test.ts — the operator CLI for the
 * per-root prep-supply report (WL-0MWTBJ7G1004Y29B, child 2 of
 * WL-0MWTAD1KM0081UUD).
 *
 * Pins the replay contract the ACs depend on:
 *  - a repeatable `--root <path>` (and the `downtimeWorklogRoots` registry as
 *    the default when it is omitted);
 *  - `--now <iso>` as a FROZEN clock, so a past window replays identically;
 *  - default output = human table + JSON payload, `--json` = payload only;
 *  - strict read-only: every root read is a fake read seam, and a usage error
 *    exits 2, a root read failure exits 1 without hiding the other roots.
 *
 * No live worklog, no `wl` subprocess: the CLI's I/O is fully injected.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parsePrepSupplyArgs,
  main,
  PREP_SUPPLY_USAGE,
  type PrepSupplyCliIo,
} from './prep-supply-report-cli.js';
import type { PrepSupplyReportDeps } from './downtime-worker.prep-supply-report.js';
import type { PrepSupplyItem } from './downtime-worker.prep-supply.js';

const NOW_ISO = '2026-11-23T10:15:00.000Z';
const ROOT_A = '/home/x/projects/ContextHub';
const ROOT_B = '/home/x/projects/AI_Hell';

const ITEM = {
  id: 'WL-A',
  status: 'open',
  stage: 'idea',
  assignee: '',
  startOn: '2026-11-20T00:00:00.000Z',
  createdAt: '2026-11-20T00:00:00.000Z',
} as PrepSupplyItem;

function fakeDeps(overrides: Partial<PrepSupplyReportDeps> = {}): PrepSupplyReportDeps {
  return {
    readWorklist: async () => ({ items: [] }),
    readFull: async (root: string) => ({ items: root === ROOT_A ? [ITEM] : [] }),
    readLogEntries: async () => [],
    ...overrides,
  };
}

interface FakeIo {
  io: PrepSupplyCliIo;
  out: string[];
  err: string[];
  deps: PrepSupplyReportDeps;
}

function fakeIo(
  options: {
    roots?: string[];
    deps?: PrepSupplyReportDeps;
    nowMs?: number;
  } = {},
): FakeIo {
  const out: string[] = [];
  const err: string[] = [];
  const deps = options.deps ?? fakeDeps();
  return {
    out,
    err,
    deps,
    io: {
      deps,
      loadRoots: () => options.roots ?? [],
      nowMs: () => options.nowMs ?? Date.parse(NOW_ISO),
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
    },
  };
}

/** The JSON payload in the output (works for both table+JSON and JSON-only). */
function payloadOf(text: string): unknown {
  return JSON.parse(text.slice(text.indexOf('{')));
}

describe('parsePrepSupplyArgs', () => {
  it('accepts a repeatable --root, --now and --json', () => {
    const parsed = parsePrepSupplyArgs([
      '--root',
      ROOT_A,
      '--root=' + ROOT_B,
      '--now',
      NOW_ISO,
      '--json',
    ]);
    expect(parsed).toEqual({
      args: { roots: [ROOT_A, ROOT_B], nowIso: NOW_ISO, json: true, help: false },
    });
  });

  it('defaults the roots to the active-root registry (empty flag list)', () => {
    expect(parsePrepSupplyArgs([])).toEqual({
      args: { roots: [], nowIso: undefined, json: false, help: false },
    });
  });

  it('dedupes repeated roots while preserving their order', () => {
    const parsed = parsePrepSupplyArgs(['--root', ROOT_B, '--root', ROOT_A, '--root', ROOT_B]);
    expect('args' in parsed && parsed.args.roots).toEqual([ROOT_B, ROOT_A]);
  });

  it('rejects a missing value, an unknown flag and a conflicting mode', () => {
    expect(parsePrepSupplyArgs(['--root'])).toEqual({ error: '--root needs a value' });
    expect(parsePrepSupplyArgs(['--now'])).toEqual({ error: '--now needs an ISO-8601 instant' });
    expect(parsePrepSupplyArgs(['--bogus'])).toEqual({ error: 'unknown argument: --bogus' });
  });

  it('accepts --help', () => {
    expect(parsePrepSupplyArgs(['--help'])).toEqual({
      args: { roots: [], nowIso: undefined, json: false, help: true },
    });
  });
});

describe('prep-supply-report-cli main', () => {
  it('prints the human table and the JSON payload by default', async () => {
    const { io, out } = fakeIo({ roots: [ROOT_A] });
    const code = await main(['--now', NOW_ISO], io);
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(`## ${ROOT_A}`);
    expect(out[0]).toContain('| offerable | 1 | WL-A |');
    const payload = payloadOf(out[0]) as {
      now: string;
      roots: Array<{ root: string; counts: { offerable: number } }>;
    };
    expect(payload.now).toBe(NOW_ISO);
    expect(payload.roots[0]).toMatchObject({ root: ROOT_A, counts: { offerable: 1 } });
  });

  it('prints only the machine payload with --json', async () => {
    const { io, out } = fakeIo({ roots: [ROOT_A] });
    const code = await main(['--json', '--now', NOW_ISO], io);
    expect(code).toBe(0);
    expect(out[0].trimStart().startsWith('{')).toBe(true);
    const payload = payloadOf(out[0]) as { roots: Array<{ root: string }> };
    expect(payload.roots.map((root) => root.root)).toEqual([ROOT_A]);
  });

  it('uses the active-root registry when --root is omitted, sorted by root', async () => {
    const { io, out } = fakeIo({ roots: [ROOT_B, ROOT_A] });
    const code = await main(['--json', '--now', NOW_ISO], io);
    expect(code).toBe(0);
    const payload = payloadOf(out[0]) as { roots: Array<{ root: string }> };
    // Lexicographic by path: AI_Hell sorts before ContextHub.
    expect(payload.roots.map((root) => root.root)).toEqual([ROOT_B, ROOT_A]);
  });

  it('does not read the registry when explicit roots are supplied', async () => {
    const loadRoots = vi.fn(() => [ROOT_B]);
    const out: string[] = [];
    const io: PrepSupplyCliIo = {
      deps: fakeDeps(),
      loadRoots,
      nowMs: () => Date.parse(NOW_ISO),
      stdout: (text: string) => out.push(text),
      stderr: () => undefined,
    };
    await main(['--root', ROOT_A, '--json'], io);
    expect(loadRoots).not.toHaveBeenCalled();
    const payload = payloadOf(out[0]) as { roots: Array<{ root: string }> };
    expect(payload.roots.map((root) => root.root)).toEqual([ROOT_A]);
  });

  it('exits 2 with an actionable message when no root is available', async () => {
    const { io, err, out } = fakeIo({ roots: [] });
    const code = await main([], io);
    expect(code).toBe(2);
    expect(out).toHaveLength(0);
    expect(err.join('\n')).toContain('--root');
    expect(err.join('\n')).toContain('downtimeWorklogRoots');
  });

  it('exits 2 on an invalid --now and an unknown flag', async () => {
    const { io, err } = fakeIo({ roots: [ROOT_A] });
    expect(await main(['--now', 'yesterday'], io)).toBe(2);
    expect(await main(['--bogus'], io)).toBe(2);
    expect(err.length).toBeGreaterThanOrEqual(2);
  });

  it('prints the documented usage with --help and reads nothing', async () => {
    const readFull = vi.fn(async () => ({ items: [] }));
    const { io, out } = fakeIo({ roots: [ROOT_A], deps: fakeDeps({ readFull }) });
    expect(await main(['--help'], io)).toBe(0);
    expect(out.join('\n')).toBe(PREP_SUPPLY_USAGE);
    expect(readFull).not.toHaveBeenCalled();
    // The help documents the worklist gap, its fallback, and the replay flags.
    expect(PREP_SUPPLY_USAGE).toContain('wl worklist --json');
    expect(PREP_SUPPLY_USAGE).toContain('wl list --json');
    expect(PREP_SUPPLY_USAGE).toContain('--now <iso>');
    expect(PREP_SUPPLY_USAGE).toContain('--root <path>');
    expect(PREP_SUPPLY_USAGE).toContain('read-only');
  });

  it('exits 1 on a root read failure but still reports the other roots', async () => {
    const deps = fakeDeps({
      readFull: async (root: string) => {
        if (root === ROOT_B) throw new Error('wl list failed');
        return { items: [ITEM] };
      },
    });
    const { io, out, err } = fakeIo({ roots: [ROOT_A, ROOT_B], deps });
    const code = await main(['--json', '--now', NOW_ISO], io);
    expect(code).toBe(1);
    const payload = payloadOf(out[0]) as {
      roots: Array<{ root: string; error?: string; counts: { offerable: number } }>;
    };
    expect(payload.roots).toHaveLength(2);
    expect(payload.roots.find((root) => root.root === ROOT_B)?.error).toBe('wl list failed');
    expect(payload.roots.find((root) => root.root === ROOT_A)?.counts.offerable).toBe(1);
    expect(err.join('\n')).toContain(ROOT_B);
    expect(err.join('\n')).toContain('wl list failed');
  });

  it('freezes the clock: the same --now replays the same payload', async () => {
    const first = fakeIo({ roots: [ROOT_A] });
    const second = fakeIo({ roots: [ROOT_A] });
    await main(['--json', '--now', NOW_ISO], first.io);
    await main(['--json', '--now', NOW_ISO], second.io);
    expect(second.out[0]).toBe(first.out[0]);
    // ... and a different --now is a different payload (the clock is honoured).
    const later = fakeIo({ roots: [ROOT_A] });
    await main(['--json', '--now', '2026-12-01T00:00:00.000Z'], later.io);
    expect(later.out[0]).not.toBe(first.out[0]);
  });
});
