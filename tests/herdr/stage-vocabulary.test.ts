/**
 * tests/herdr/stage-vocabulary.test.ts — integration regression suite pinning
 * the Herdr stage vocabulary to the `wl` CLI stage rules (WL-0MUY1CQM6005HV9M).
 *
 * These tests assert the user-visible contract end to end:
 *  - Herdr's `STAGES` equals the stages declared by the CLI config
 *    (`.worklog/config.defaults.yaml`) — so the two can never drift again.
 *  - The stage filter / `/wl <stage>` aliases fail soft for values the CLI no
 *    longer accepts (`in_progress`, `completed`, `progress`, `bogus`).
 *  - `fetchItemsByStage` never issues a `wl list --stage <invalid>` call.
 *  - `done` and unknown stages render deterministically through the shared
 *    icon/colour maps.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STAGES,
  STAGE_MAP,
  StageFilter,
  WorkItemListState,
  dispatchChordCommand,
} from '../../packages/herdr/src/worklist.js';
import type { WorkItem } from '../../packages/herdr/src/worklist.js';
import {
  fetchItemsByStage,
  setExecFileAsync,
  resetExecFileAsync,
} from '../../packages/herdr/src/fetcher.js';
import { stageIcon, stageColor } from '@worklog/shared/icons';

/** The canonical CLI stage vocabulary (`.worklog/config.defaults.yaml`). */
const CLI_STAGES = ['idea', 'intake_complete', 'plan_complete', 'in_review', 'done'];

const TERM = { rows: 24, cols: 80 };

/**
 * Read the `stages:` list from the CLI config defaults. Parsed with a small
 * line scanner rather than a YAML dependency so the test only depends on the
 * config file it is pinning.
 */
function readCliStageValues(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const yaml = readFileSync(
    join(here, '..', '..', '.worklog', 'config.defaults.yaml'),
    'utf8',
  );
  const stagesBlock = yaml.split(/^stages:\s*$/m)[1] ?? '';
  const values: string[] = [];
  for (const line of stagesBlock.split('\n')) {
    if (/^\S/.test(line) && line.trim() !== '') break; // next top-level key
    const match = line.match(/^\s*-\s+value:\s*(\S+)\s*$/);
    if (match) values.push(match[1]);
  }
  return values;
}

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WL-TEST001',
    title: 'Test item',
    status: 'open',
    priority: 'medium',
    stage: 'plan_complete',
    description: '',
    ...overrides,
  };
}

describe('Herdr stage vocabulary lock-in (WL-0MUY1CQM6005HV9M)', () => {
  it('STAGES equals the CLI config stage vocabulary exactly', () => {
    expect([...STAGES]).toEqual(CLI_STAGES);
    expect(readCliStageValues()).toEqual(CLI_STAGES);
  });

  it('removes in_progress/completed from STAGES and never maps them in STAGE_MAP', () => {
    expect(STAGES).not.toContain('in_progress');
    expect(STAGES).not.toContain('completed');
    for (const removed of ['in_progress', 'completed', 'progress']) {
      expect(STAGE_MAP[removed]).toBeUndefined();
    }
    expect(Object.values(STAGE_MAP)).not.toContain('in_progress');
    expect(Object.values(STAGE_MAP)).not.toContain('completed');
  });

  it('resolves every CLI alias/canonical name', () => {
    expect(STAGE_MAP['intake']).toBe('intake_complete');
    expect(STAGE_MAP['plan']).toBe('plan_complete');
    expect(STAGE_MAP['review']).toBe('in_review');
    for (const stage of CLI_STAGES) expect(STAGE_MAP[stage]).toBe(stage);
  });

  it('StageFilter cycles only the CLI stages then clears to null', () => {
    const filter = new StageFilter();
    const seen: Array<string | null> = [];
    for (let i = 0; i < CLI_STAGES.length + 1; i++) {
      filter.cycle();
      seen.push(filter.current);
    }
    expect(seen).toEqual([...CLI_STAGES, null]);
  });

  it('/wl progress and /wl completed fail soft (no crash, no filter applied)', () => {
    for (const bogus of ['/wl progress', '/wl completed', '/wl bogus']) {
      const state = new WorkItemListState([item()], TERM);
      let result: boolean | undefined;
      expect(() => {
        result = dispatchChordCommand(bogus, state);
      }).not.toThrow();
      expect(result).toBe(false);
      expect(state.activeFilter).toBeNull();
    }
  });
});

describe('fetchItemsByStage fail-soft lock-in (WL-0MUY1CQM6005HV9M)', () => {
  beforeEach(() => resetExecFileAsync());

  it('never issues a CLI call for removed/unknown stages', async () => {
    const mock = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mock as any);

    for (const invalid of ['in_progress', 'completed', 'bogus']) {
      await expect(fetchItemsByStage(invalid)).resolves.toEqual([]);
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it('still issues a CLI call with the canonical stage for a valid stage', async () => {
    const mock = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mock as any);

    await fetchItemsByStage('plan_complete');
    expect(mock).toHaveBeenCalledTimes(1);
    const args = mock.mock.calls[0][1] as string[];
    expect(args).toContain('--stage');
    expect(args[args.indexOf('--stage') + 1]).toBe('plan_complete');
    expect(args).not.toContain('in_progress');
  });
});

describe('stage icon/colour lock-in (WL-0MUY1CQM6005HV9M)', () => {
  it('renders done with the completed checkmark and target colour', () => {
    expect(stageIcon('done')).toBe('\u{2714}\u{FE0F}'); // ✔️
    expect(stageColor('done')).toBe(33);
  });

  it('falls back deterministically for an unknown stage', () => {
    expect(stageIcon('bogus_stage')).toBe('\u{2753}'); // ❓
    expect(stageColor('bogus_stage')).toBe(241);
  });

  it('renders the removed in_progress/completed stages fail-soft', () => {
    for (const legacy of ['in_progress', 'completed']) {
      expect(() => stageIcon(legacy)).not.toThrow();
      expect(() => stageColor(legacy)).not.toThrow();
    }
  });
});
