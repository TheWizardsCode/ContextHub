/**
 * packages/herdr/src/pane-close-cli.test.ts — Tests for the standalone
 * pane-close bridge CLI (WL-0MUJMXVPO0016DZM).
 *
 * The bridge is the cross-language seam consumed by the Python pane-triage
 * skill. These tests pin the two behaviours the skill depends on:
 *  - JSON output mode emits a single parseable document per pane,
 *  - fixture mode classifies offline (no herdr / wl subprocesses).
 */
import { describe, expect, it, vi } from 'vitest';

import { extractFixtureArg, extractJsonValue, extractRepairArg, main } from './pane-close-cli';
import {
  readBudgetLedger,
  withMachineDir,
  writeRawBudgetLedger,
} from './host-dispatch-budget.fixtures.js';

describe('extractFixtureArg', () => {
  it('separates --fixture from pass-through flags', () => {
    const { fixture, rest } = extractFixtureArg([
      '--fixture',
      '/tmp/fixture.json',
      '--json',
      '--dry-run',
    ]);
    expect(fixture).toBe('/tmp/fixture.json');
    expect(rest).toEqual(['--json', '--dry-run']);
  });

  it('returns undefined when no fixture flag is present', () => {
    const { fixture, rest } = extractFixtureArg(['--json']);
    expect(fixture).toBeUndefined();
    expect(rest).toEqual(['--json']);
  });
});

describe('extractJsonValue', () => {
  it('parses a JSON object prefixed by log lines', () => {
    expect(extractJsonValue('log line\n{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a bare array', () => {
    expect(extractJsonValue('[1,2]')).toEqual([1, 2]);
  });

  it('returns null when no JSON exists', () => {
    expect(extractJsonValue('nothing here')).toBeNull();
  });
});

describe('main — fixture mode', () => {
  it('classifies offline and emits JSON to stdout', async () => {
    const fixture = JSON.stringify({
      result: {
        panes: [
          {
            pane_id: 'w1:p1',
            label: 'Downtime triggered plan Foo - WL-0ABC123',
            agent: 'pi',
            agent_status: 'done',
            workspace_id: 'w1',
            agent_session: { value: '/tmp/nonexistent-session.jsonl' },
          },
        ],
      },
    });
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(line);
    });
    try {
      const code = await main(['--fixture', '/tmp/f.json', '--json'], {
        readFile: () => fixture,
        env: {},
        cwd: '/tmp',
      });
      expect(code).toBe(0);
    } finally {
      logSpy.mockRestore();
    }
    const output = JSON.parse(logged.join('\n'));
    expect(output.panes).toHaveLength(1);
    expect(output.panes[0]).toMatchObject({
      paneId: 'w1:p1',
      itemId: 'WL-0ABC123',
      workspaceId: 'w1',
      kind: 'plan',
    });
    // The invoking pane id from the environment is surfaced in the envelope.
    expect(output.invokingPaneId).toBe(null);
    expect(typeof output.timestamp).toBe('string');
  });

  it('surfaces HERDR_PANE_ID as the invoking pane in the JSON envelope', async () => {
    const fixture = JSON.stringify({
      panes: [
        {
          pane_id: 'w1:p1',
          label: 'Downtime triggered plan Foo - WL-0ABC123',
          agent: 'pi',
          agent_status: 'idle',
          workspace_id: 'w1',
          agent_session: { value: '/tmp/nonexistent.jsonl' },
        },
      ],
    });
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(line);
    });
    try {
      await main(['--fixture', '/tmp/f.json', '--json'], {
        readFile: () => fixture,
        env: { HERDR_PANE_ID: 'w1:pZ' },
        cwd: '/tmp',
      });
    } finally {
      logSpy.mockRestore();
    }
    const output = JSON.parse(logged.join('\n'));
    expect(output.invokingPaneId).toBe('w1:pZ');
  });

  it('applies the --workspace filter to fixture panes', async () => {
    const fixture = JSON.stringify({
      panes: [
        {
          pane_id: 'w1:p1',
          label: 'Downtime triggered plan A - WL-1',
          agent: 'pi',
          agent_status: 'idle',
          workspace_id: 'w1',
          agent_session: { value: '/tmp/nonexistent.jsonl' },
        },
        {
          pane_id: 'w2:p2',
          label: 'Downtime triggered plan B - WL-2',
          agent: 'pi',
          agent_status: 'idle',
          workspace_id: 'w2',
          agent_session: { value: '/tmp/nonexistent.jsonl' },
        },
      ],
    });
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(line);
    });
    try {
      await main(['--fixture', '/tmp/f.json', '--json', '--workspace', 'w1'], {
        readFile: () => fixture,
        env: {},
        cwd: '/tmp',
      });
    } finally {
      logSpy.mockRestore();
    }
    const output = JSON.parse(logged.join('\n'));
    expect(output.panes).toHaveLength(1);
    expect(output.panes[0].paneId).toBe('w1:p1');
  });
});

// ── Operator ledger repair mode (WL-0MWFJD8ZO000J1R8) ─────────────────

describe('extractRepairArg', () => {
  it('strips --repair-budget-ledger out of argv', () => {
    expect(extractRepairArg(['--repair-budget-ledger', '--json'])).toEqual({
      repair: true,
      rest: ['--json'],
    });
    expect(extractRepairArg(['--json'])).toEqual({ repair: false, rest: ['--json'] });
  });
});

describe('main — --repair-budget-ledger (explicit operator repair)', () => {
  /** Run the CLI against an isolated machine dir and captured stdout/stderr. */
  async function runRepair(
    fixture: unknown,
    env: NodeJS.ProcessEnv,
  ): Promise<{ code: number; payload: unknown; stderr: string }> {
    const logged: string[] = [];
    const errored: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(String(line));
    });
    const errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        errored.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
    try {
      const code = await main(['--repair-budget-ledger', '--fixture', '/tmp/panes.json'], {
        readFile: () => JSON.stringify(fixture),
        env,
        cwd: '/tmp',
      });
      return { code, payload: JSON.parse(logged.join('\n')), stderr: errored.join('') };
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  }

  it('reconstructs decorated and manual panes and prints the repaired set', async () => {
    await withMachineDir(async (dir) => {
      writeRawBudgetLedger(dir, '{ corrupt');
      const result = await runRepair(
        {
          result: {
            panes: [
              {
                pane_id: 'w1:p1',
                label: '⚠️ Downtime triggered implement Do it - WL-1',
                agent: 'pi',
                agent_status: 'working',
              },
              {
                pane_id: 'w1:p2',
                label: 'Manually triggered audit Audit it - WL-2',
                agent: 'pi',
                agent_status: 'working',
              },
              { pane_id: 'w1:p3', label: 'rgardler@host: ~/projects/x', agent_status: 'idle' },
            ],
          },
        },
        { HERDR_COORDINATION_DIR: dir } as NodeJS.ProcessEnv,
      );

      expect(result.code).toBe(0);
      expect(result.payload).toMatchObject({ repaired: true, count: 2 });
      const repaired = readBudgetLedger(dir);
      expect(repaired?.entries.map((entry) => `${entry.kind}:${entry.itemId}`).sort()).toEqual([
        'audit:WL-2',
        'implement:WL-1',
      ]);
    });
  });

  it('refuses (exit 1) and leaves the ledger untouched when a pane cannot be accounted for', async () => {
    await withMachineDir(async (dir) => {
      const corrupt = '{ corrupt';
      writeRawBudgetLedger(dir, corrupt);
      const result = await runRepair(
        {
          result: {
            panes: [
              {
                pane_id: 'w1:p1',
                label: 'Downtime triggered implement Do it - WL-1',
                agent: 'pi',
                agent_status: 'working',
              },
              {
                pane_id: 'w1:p2',
                label: '🚫 Downtime triggered implement no item id',
                agent: 'pi',
                agent_status: 'working',
              },
            ],
          },
        },
        { HERDR_COORDINATION_DIR: dir } as NodeJS.ProcessEnv,
      );

      expect(result.code).toBe(1);
      expect(result.payload).toMatchObject({
        repaired: false,
        reason: 'incomplete',
        unaccounted: [expect.objectContaining({ paneId: 'w1:p2' })],
      });
      expect(result.stderr).toContain('Refusing to repair');
    });
  });
});
