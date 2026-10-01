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

import { extractFixtureArg, extractJsonValue, main } from './pane-close-cli';

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
