/**
 * CLI tests for the default not-yet-started filter across every search surface
 * (WL-0MWMGET8N009KG33, parent WL-0MWM0FDZK007BAD0).
 *
 * The ACs under test:
 *
 * - `list`, `search`, `next`, `in_progress`, `recent` and `worklist` exclude
 *   items whose `startOn` is in the future **by default**, in both text and
 *   JSON;
 * - `--include-not-started` / `--starts-before <ISO>` opt in, and opted-in
 *   rows are marked (`[not started until <UTC Z>]` in text, `notStarted: true`
 *   alongside the effective `startOn` in JSON);
 * - `in_progress` rows are never filtered, even with a future `startOn`;
 * - `wl show <id>` stays unfiltered.
 *
 * Instants are absolute (year 2000 for "started", 2100/2200 for "scheduled")
 * rather than derived from the wall clock, so the assertions are reproducible.
 * The clock-injectable half of the contract is covered with a frozen clock in
 * `tests/unit/not-started-filter.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  seedWorkItems,
  writeConfig,
  writeInitSemaphore,
} from './cli-helpers.js';

const STARTED_ON = '2000-01-01T00:00:00.000Z';
const FUTURE_ON = '2100-01-01T00:00:00.000Z';
const SOON_ON = '2050-01-01T00:00:00.000Z';
const LATE_ON = '2200-01-01T00:00:00.000Z';
const IN_PROGRESS_ON = '2100-06-01T00:00:00.000Z';

describe('not-yet-started default filtering across CLI search surfaces', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-STARTED', title: 'Started task', status: 'open', priority: 'medium', startOn: STARTED_ON },
      { id: 'TEST-FUTURE', title: 'Future critical task', status: 'open', priority: 'critical', startOn: FUTURE_ON },
      { id: 'TEST-SOON', title: 'Soon scheduled task', status: 'open', priority: 'low', startOn: SOON_ON },
      { id: 'TEST-LATE', title: 'Late scheduled task', status: 'open', priority: 'low', startOn: LATE_ON },
      {
        id: 'TEST-INPROGRESS',
        title: 'Scheduled in-progress task',
        status: 'in-progress',
        priority: 'high',
        startOn: IN_PROGRESS_ON,
      },
    ]);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  async function json(args: string): Promise<any> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json ${args}`);
    return JSON.parse(stdout);
  }

  async function text(args: string): Promise<string> {
    const { stdout } = await execAsync(`tsx ${cliPath} ${args}`);
    return stdout;
  }

  function ids(payload: { workItems: Array<{ id: string }> }): string[] {
    return payload.workItems.map(item => item.id);
  }

  const marker = (iso: string): string => `[not started until ${iso}]`;

  // ── list ───────────────────────────────────────────────────────────
  describe('wl list', () => {
    it('excludes not-yet-started items by default (JSON)', async () => {
      const out = await json('list');
      expect(ids(out)).toContain('TEST-STARTED');
      expect(ids(out)).not.toContain('TEST-FUTURE');
      expect(ids(out)).not.toContain('TEST-SOON');
      expect(ids(out)).not.toContain('TEST-LATE');
      // in-progress is never filtered.
      expect(ids(out)).toContain('TEST-INPROGRESS');
    });

    it('excludes not-yet-started items by default (text)', async () => {
      const out = await text('list');
      expect(out).toContain('Started task');
      expect(out).not.toContain('Future critical task');
      expect(out).not.toContain('Soon scheduled task');
    });

    it('shows and marks them with --include-not-started (JSON)', async () => {
      const out = await json('list --include-not-started');
      const future = out.workItems.find((item: any) => item.id === 'TEST-FUTURE');
      expect(future).toBeDefined();
      expect(future.notStarted).toBe(true);
      expect(future.startOn).toBe(FUTURE_ON);
      // Started rows carry no marker field at all.
      const started = out.workItems.find((item: any) => item.id === 'TEST-STARTED');
      expect(started.notStarted).toBeUndefined();
    });

    it('renders the trailing text marker with --include-not-started', async () => {
      const out = await text('list --include-not-started');
      expect(out).toContain(marker(FUTURE_ON));
      expect(out).not.toContain(marker(STARTED_ON));
    });

    it('bounds the opt-in window with --starts-before', async () => {
      const out = await json('list --starts-before 2150-01-01T00:00:00Z');
      expect(ids(out)).toContain('TEST-SOON');
      expect(ids(out)).toContain('TEST-FUTURE');
      expect(ids(out)).not.toContain('TEST-LATE');
    });

    it('composes --include-not-started with --starts-before', async () => {
      const out = await json('list --include-not-started --starts-before 2150-01-01T00:00:00Z');
      expect(ids(out)).toContain('TEST-SOON');
      expect(ids(out)).not.toContain('TEST-LATE');
    });

    it('rejects an invalid --starts-before with an actionable message', async () => {
      const failure = await execAsync(`tsx ${cliPath} --json list --starts-before 2100-01-01`).then(
        () => null,
        (err: any) => err,
      );
      expect(failure, 'a bare date must exit non-zero').not.toBeNull();
      const payload = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
      expect(payload).toContain('--starts-before');
      expect(payload).toContain('2100-01-01');
    });
  });

  // ── search ─────────────────────────────────────────────────────────
  describe('wl search', () => {
    /**
     * Search filters run on the FTS index, which the JSONL seed does not
     * populate: author the two rows through `wl create` so the index is fresh.
     */
    async function create(title: string, startOn: string): Promise<any> {
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json create -t "${title}" --start-on ${startOn} --no-re-sort`,
      );
      return JSON.parse(stdout).workItem;
    }

    it('excludes not-yet-started matches by default (JSON)', async () => {
      const started = await create('zebraword started item', '2000-01-01T00:00:00Z');
      const future = await create('zebraword future item', '2100-01-01T00:00:00Z');

      const out = await json('search zebraword');
      const found = out.workItems.map((item: any) => item.id);
      expect(found).toContain(started.id);
      expect(found).not.toContain(future.id);
    });

    it('shows and marks them with --include-not-started (JSON)', async () => {
      const future = await create('zebraword future item', '2100-01-01T00:00:00Z');

      const out = await json('search zebraword --include-not-started');
      const marked = out.workItems.find((item: any) => item.id === future.id);
      expect(marked).toBeDefined();
      expect(marked.notStarted).toBe(true);
      expect(marked.startOn).toBe(FUTURE_ON);
    });

    it('renders the trailing text marker with --include-not-started', async () => {
      await create('zebraword future item', '2100-01-01T00:00:00Z');

      const out = await text('search zebraword --include-not-started');
      expect(out).toContain(marker(FUTURE_ON));
    });

    it('rejects an invalid --starts-before with an actionable message', async () => {
      const failure = await execAsync(
        `tsx ${cliPath} --json search zebraword --starts-before 2100-01-01`,
      ).then(
        () => null,
        (err: any) => err,
      );
      expect(failure, 'a bare date must exit non-zero').not.toBeNull();
      expect(`${failure.stdout ?? ''}${failure.stderr ?? ''}`).toContain('--starts-before');
    });
  });

  // ── next ───────────────────────────────────────────────────────────
  describe('wl next', () => {
    it('selects the next eligible started item instead of a future critical one', async () => {
      const out = await json('next --no-re-sort');
      expect(out.workItem?.id).toBe('TEST-STARTED');
    });

    it('selects and marks a future item with --include-not-started', async () => {
      const out = await json('next --no-re-sort --include-not-started');
      expect(out.workItem?.id).toBe('TEST-FUTURE');
      expect(out.workItem?.notStarted).toBe(true);
    });

    it('renders the trailing text marker with --include-not-started', async () => {
      const out = await text('next --no-re-sort --include-not-started');
      expect(out).toContain(marker(FUTURE_ON));
    });
  });

  // ── in-progress ────────────────────────────────────────────────────
  describe('wl in_progress', () => {
    it('never filters an in-progress item with a future startOn', async () => {
      const out = await json('in_progress');
      expect(ids(out)).toContain('TEST-INPROGRESS');
      const item = out.workItems.find((entry: any) => entry.id === 'TEST-INPROGRESS');
      expect(item.notStarted).toBe(true);
      expect(item.startOn).toBe(IN_PROGRESS_ON);
    });

    it('renders the trailing text marker', async () => {
      const out = await text('in_progress');
      expect(out).toContain('Scheduled in-progress task');
      expect(out).toContain(marker(IN_PROGRESS_ON));
    });
  });

  // ── recent ─────────────────────────────────────────────────────────
  describe('wl recent', () => {
    it('excludes not-yet-started items by default (JSON)', async () => {
      const out = await json('recent -n 10');
      const found = ids(out);
      expect(found).toContain('TEST-STARTED');
      expect(found).not.toContain('TEST-FUTURE');
      expect(found).not.toContain('TEST-SOON');
    });

    it('shows and marks them with --include-not-started', async () => {
      const out = await json('recent -n 10 --include-not-started');
      const future = out.workItems.find((item: any) => item.id === 'TEST-FUTURE');
      expect(future).toBeDefined();
      expect(future.notStarted).toBe(true);
    });

    it('renders the trailing text marker with --include-not-started', async () => {
      const out = await text('recent -n 10 --include-not-started');
      expect(out).toContain(marker(FUTURE_ON));
    });
  });

  // ── worklist ───────────────────────────────────────────────────────
  describe('wl worklist', () => {
    it('applies the default filter to every subset', async () => {
      const out = await json('worklist');
      const critical = out.subsets.critical.map((item: any) => item.id);
      expect(critical).not.toContain('TEST-FUTURE');
      // The in-progress subset is exempt from filtering but still marked.
      const inProgress = out.subsets.inProgressRoots.find((item: any) => item.id === 'TEST-INPROGRESS');
      expect(inProgress?.notStarted).toBe(true);
      // The browse feed inherits the shared selection filter.
      const browse = out.subsets.browse.map((entry: any) => entry.workItem?.id);
      expect(browse).not.toContain('TEST-FUTURE');
      expect(browse).toContain('TEST-STARTED');
    });

    it('opts in across every subset with --include-not-started', async () => {
      const out = await json('worklist --include-not-started');
      const critical = out.subsets.critical.find((item: any) => item.id === 'TEST-FUTURE');
      expect(critical?.notStarted).toBe(true);
      const browse = out.subsets.browse.map((entry: any) => entry.workItem?.id);
      expect(browse).toContain('TEST-FUTURE');
    });
  });

  // ── show ───────────────────────────────────────────────────────────
  it('keeps wl show unfiltered for a not-yet-started item', async () => {
    const out = await json('show TEST-FUTURE');
    expect(out.workItem.id).toBe('TEST-FUTURE');
    expect(out.workItem.startOn).toBe(FUTURE_ON);
  });
});
