/**
 * In-process CLI harness: reuse-safety and harness-contract tests
 * (WL-0MVVXG0EQ0068WQB, child of WL-0MVHVZMCH0092JCY).
 *
 * The parent investigation wants to reduce the per-call cost of the in-process
 * harness (`tests/cli/cli-inproc.ts`). Its recorded risk is **fidelity**: if a
 * later change reuses a `Command`, a plugin context, a parsed config or a DB
 * handle across calls, commander option state or the global `--worklog-dir`
 * override (`setWorklogDirOverride` / `_worklogDirOverride` in
 * `src/worklog-paths.ts`) can leak between tests and turn a pass into an
 * order-dependent accident.
 *
 * This file is the safety net for that change. It characterises the contract
 * the harness must keep no matter how it is optimised:
 *
 *   1. WORKLOG-DIR ISOLATION — interleaved `--worklog-dir` calls (A → B → A)
 *      observe only their own store; no override or resolved data path leaks.
 *   2. GLOBAL-OPTION ISOLATION — `--json`, `--verbose`, `-F/--format` and
 *      `-w/--watch` state never survives into the next call, in either
 *      direction.
 *   3. READ/WRITE COHERENCE — a cached or shared DB handle must not serve
 *      stale data: each read observes the preceding mutation in-process.
 *   4. RESTORATION — every patched process global (`argv`, `stdout.write`,
 *      `stderr.write`, `exit`, `console.*`, `exitCode`) is restored after the
 *      call, and the returned `exitCode` mirrors a command that set
 *      `process.exitCode` or called `process.exit`.
 *   5. ORDER INDEPENDENCE — the same mixed read/write sequence run in reverse
 *      produces the same per-call output and the same final state.
 *   6. REUSE CONTRACT (RED-PINNED) — `getInprocHarnessStats()` shows the
 *      pre-change cost of one construction + one plugin context + one DB open
 *      **per call**, and pins the post-change expectation (one shared
 *      construction/context for a run of stateless read calls).
 *
 * ## Red-first status of the reuse contract
 *
 * The reuse assertion is RED-PINNED with `it.fails(...)` so the suite stays
 * green while no reuse exists. Pre-change evidence recorded on
 * WL-0MVVXG0EQ0068WQB (three consecutive, stateless `list --json` calls):
 *
 *     { calls: 3, commandsConstructed: 3, pluginContextsCreated: 3, databasesOpened: 3 }
 *
 * i.e. `commandsConstructed` is 3 where the contract allows 1 → the pinned
 * assertion fails with `expected 3 to be less than or equal to 1`.
 *
 * The child that reduces the harness cost (WL-0MVVXG4B200968BF) flips
 * `it.fails(` → `it(` when reuse lands on the harness-side branch. If that
 * child instead takes the recorded re-scope branch (profiling put the dominant
 * cost in the command action / production startup, see child 1
 * WL-0MVVXFXM6007QZ2L), it adjusts this expectation together with its recorded
 * finding rather than leaving a permanently pinned contract.
 *
 * Everything here runs **in-process only** (no subprocess spawns), so the file
 * costs a few dozen warm harness calls — well under a second.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  runInProcess,
  getInprocHarnessStats,
  resetInprocHarnessStats,
  type InprocHarnessStats,
} from './cli-inproc.js';
import { writeConfig, writeInitSemaphore, seedWorkItems } from './cli-helpers.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';

const CLI = 'node src/cli.ts';
const PREFIX = 'REU';

const OMITTED = Symbol('no --worklog-dir');

interface TempStore {
  /** Temp project directory (owns `.worklog/`). */
  dir: string;
  /** The `.worklog` directory, i.e. the value for `--worklog-dir`. */
  worklogDir: string;
}

const tempDirs: string[] = [];

/** Create (and register for cleanup) a fresh, initialised temp store. */
function makeStore(label: string): TempStore {
  const dir = createTempDir();
  writeConfig(dir, label, PREFIX);
  writeInitSemaphore(dir);
  tempDirs.push(dir);
  return { dir, worklogDir: path.join(dir, '.worklog') };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    cleanupTempDir(tempDirs.pop() as string);
  }
});

/** Build an argv for the in-process CLI, optionally scoped to a store. */
function argv(store: TempStore | typeof OMITTED, rest: string): string {
  const scope =
    store === OMITTED ? '' : `--worklog-dir "${store.worklogDir}" `;
  return `${CLI} ${scope}${rest}`;
}

/** Run a `--json` command and parse its stdout. */
async function runJson(store: TempStore | typeof OMITTED, rest: string): Promise<any> {
  const res = await runInProcess(argv(store, `--json ${rest}`));
  expect(res.exitCode, `${rest} exited ${res.exitCode}: ${res.stderr}`).toBe(0);
  return JSON.parse(res.stdout);
}

/** Create an item and return its id. */
async function createItem(store: TempStore, title: string): Promise<string> {
  const created = await runJson(store, `create -t "${title}"`);
  return created.workItem.id as string;
}

/** Ids listed by `list --json`, in the order reported. */
async function listIds(store: TempStore): Promise<string[]> {
  const listed = await runJson(store, 'list');
  return (listed.workItems as Array<{ id: string }>).map((item) => item.id);
}

function delta(before: InprocHarnessStats, after: InprocHarnessStats): InprocHarnessStats {
  return {
    calls: after.calls - before.calls,
    commandsConstructed: after.commandsConstructed - before.commandsConstructed,
    pluginContextsCreated: after.pluginContextsCreated - before.pluginContextsCreated,
    databasesOpened: after.databasesOpened - before.databasesOpened,
  };
}

/**
 * Replace wall-clock timestamps so two runs can be compared byte-for-byte.
 *
 * Timestamps are the only volatile part of a CLI payload (they are the wall
 * clock at write time), so normalising them keeps the comparison strict for
 * everything that actually identifies behaviour: ids, ordering, status, field
 * values and formatting.
 */
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
function normaliseTimestamps(text: string): string {
  return text.replace(ISO_TIMESTAMP, '<timestamp>');
}

describe('in-process harness: --worklog-dir isolation (WL-0MVVXG0EQ0068WQB)', () => {
  it('interleaved A → B → A calls each report only their own worklog', async () => {
    const storeA = makeStore('isolation A');
    const storeB = makeStore('isolation B');

    const idA = await createItem(storeA, 'item that belongs to store A');
    const idB = await createItem(storeB, 'item that belongs to store B');
    expect(idA).not.toBe(idB);

    const firstA = await listIds(storeA);
    const onlyB = await listIds(storeB);
    const secondA = await listIds(storeA);

    expect(firstA).toEqual([idA]);
    expect(onlyB).toEqual([idB]);
    expect(secondA).toEqual([idA]);
  });

  it('does not leak a resolved data path between stores', async () => {
    const storeA = makeStore('path A');
    const storeB = makeStore('path B');

    const idA = await createItem(storeA, 'alpha only item');
    const idB = await createItem(storeB, 'beta only item');

    // Raw stdout, not just the parsed ids: a leaked override would surface as
    // the other store's item appearing in the payload at all.
    const rawB = await runInProcess(argv(storeB, '--json list'));
    expect(rawB.stdout).toContain(idB);
    expect(rawB.stdout).not.toContain(idA);

    const rawA = await runInProcess(argv(storeA, '--json list'));
    expect(rawA.stdout).toContain(idA);
    expect(rawA.stdout).not.toContain(idB);

    // Two reads of an unmutated store are byte-identical: the second call
    // resolved the same store from scratch rather than reusing stale state.
    const repeatA = await runInProcess(argv(storeA, '--json list'));
    expect(repeatA.stdout).toBe(rawA.stdout);
  });
});

describe('in-process harness: global option state does not leak', () => {
  it('--json does not leak into the next call, in either direction', async () => {
    const store = makeStore('json leak');
    const id = await createItem(store, 'json leak item');

    const jsonCall = await runJson(store, `show ${id}`);
    expect(jsonCall.workItem.id).toBe(id);

    const human = await runInProcess(argv(store, `show ${id}`));
    expect(human.exitCode).toBe(0);
    expect(() => JSON.parse(human.stdout)).toThrow();
    expect(human.stdout).toContain('json leak item');

    const human2 = await runInProcess(argv(store, `show ${id}`));
    const jsonCall2 = await runJson(store, `show ${id}`);
    expect(jsonCall2.workItem.id).toBe(id);
    expect(human2.stdout).toBe(human.stdout);
  });

  it('-F/--format does not leak into the next call', async () => {
    const store = makeStore('format leak');
    const id = await createItem(store, 'format leak item');

    const defaultFormat = await runInProcess(argv(store, `show ${id}`));
    const concise = await runInProcess(argv(store, `show ${id} -F concise`));
    const defaultAgain = await runInProcess(argv(store, `show ${id}`));

    // The explicit format is honoured on its own call …
    expect(concise.exitCode).toBe(0);
    expect(concise.stdout).toContain(id);
    expect(concise.stdout).not.toBe(defaultFormat.stdout);
    // … and is gone on the next one: identical to the pre-concise output.
    expect(defaultAgain.stdout).toBe(defaultFormat.stdout);
  });

  it('--verbose does not leak into the next call', async () => {
    const pluginDir = createTempDir();
    tempDirs.push(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, 'demo-plugin.js'),
      'export default function register() {}\n',
      'utf8',
    );

    const previousPluginDir = process.env.WORKLOG_PLUGIN_DIR;
    process.env.WORKLOG_PLUGIN_DIR = pluginDir;
    try {
      // `plugins --verbose` prints each plugin's resolved path; the plain call
      // must not inherit that flag.
      const verbose = await runInProcess(argv(OMITTED, '--verbose plugins'));
      expect(verbose.exitCode).toBe(0);
      expect(verbose.stdout).toContain('Path:');

      const plain = await runInProcess(argv(OMITTED, 'plugins'));
      expect(plain.exitCode).toBe(0);
      expect(plain.stdout).not.toContain('Path:');
      expect(plain.stdout).toContain('demo-plugin.js');

      const plainAgain = await runInProcess(argv(OMITTED, 'plugins'));
      expect(plainAgain.stdout).toBe(plain.stdout);

      const verboseAgain = await runInProcess(argv(OMITTED, '--verbose plugins'));
      expect(verboseAgain.stdout).toBe(verbose.stdout);
    } finally {
      if (previousPluginDir === undefined) delete process.env.WORKLOG_PLUGIN_DIR;
      else process.env.WORKLOG_PLUGIN_DIR = previousPluginDir;
    }
  });

  it('-w/--watch does not survive into the next call', async () => {
    const store = makeStore('watch leak');
    await createItem(store, 'watch leak item');

    const control = await runInProcess(argv(store, '--json list'));
    expect(control.exitCode).toBe(0);

    // A watch flag in one call must neither change that call's output nor be
    // remembered by the following one (in-process, the watcher itself lives in
    // `src/cli.ts` and is never entered — only the option can leak).
    const watchedLong = await runInProcess(argv(store, '--json list --watch=1'));
    expect(watchedLong.exitCode).toBe(0);
    expect(watchedLong.stdout).toBe(control.stdout);

    const afterLong = await runInProcess(argv(store, '--json list'));
    expect(afterLong.stdout).toBe(control.stdout);

    const watchedShort = await runInProcess(argv(store, '--json list -w 1'));
    expect(watchedShort.exitCode).toBe(0);
    expect(watchedShort.stdout).toBe(control.stdout);

    const afterShort = await runInProcess(argv(store, '--json list'));
    expect(afterShort.stdout).toBe(control.stdout);
  });
});

describe('in-process harness: read/write coherence', () => {
  it('observes every preceding mutation within one process', async () => {
    const store = makeStore('coherence');

    // create
    const id = await createItem(store, 'coherence item');
    const listedAfterCreate = await runJson(store, 'list');
    expect(listedAfterCreate.count).toBe(1);
    expect(listedAfterCreate.workItems[0].id).toBe(id);
    expect(listedAfterCreate.workItems[0].status).toBe('open');

    // update
    const updated = await runJson(store, `update ${id} --status blocked --no-re-sort --description "changed in-process"`);
    expect(updated.success).toBe(true);
    expect(updated.workItem.status).toBe('blocked');

    // show / list must see the update, not a stale snapshot
    const shown = await runJson(store, `show ${id}`);
    expect(shown.workItem.status).toBe('blocked');
    expect(shown.workItem.description).toBe('changed in-process');

    const listedAfterUpdate = await runJson(store, 'list');
    expect(listedAfterUpdate.workItems[0].status).toBe('blocked');
    expect(listedAfterUpdate.workItems[0].description).toBe('changed in-process');

    // A second mutation is observed too (the handle is not cached read-only).
    await runJson(store, `update ${id} --assignee alice --no-re-sort`);
    const shownAfterSecond = await runJson(store, `show ${id}`);
    expect(shownAfterSecond.workItem.assignee).toBe('alice');
    expect(shownAfterSecond.workItem.status).toBe('blocked');
  });
});

describe('in-process harness: restoration contract', () => {
  it('restores every patched process global after each call', async () => {
    const store = makeStore('restoration');
    const id = await createItem(store, 'restoration item');

    const originals = {
      argv: process.argv,
      stdoutWrite: process.stdout.write,
      stderrWrite: process.stderr.write,
      exit: process.exit,
      consoleLog: console.log,
      consoleError: console.error,
      consoleWarn: console.warn,
      consoleInfo: console.info,
      exitCode: process.exitCode,
    };

    // A distinctive sentinel proves the harness restored the *pre-call* value
    // rather than merely normalising it to 0.
    process.exitCode = 7;
    try {
      const calls = [
        argv(store, `--json show ${id}`), // JSON success
        argv(store, `show ${id}`), // human success
        argv(OMITTED, '--verbose plugins'), // verbose
        argv(store, `--json show ${PREFIX}-DOES-NOT-EXIST`), // process.exit(1)
        argv(OMITTED, '--help'), // process.exit(0)
        argv(store, `--json update ${id} --if-status completed --status blocked`), // CAS failure, exit 1
      ];

      for (const commandLine of calls) {
        // eslint-disable-next-line no-await-in-loop
        const res = await runInProcess(commandLine);
        expect(process.argv).toBe(originals.argv);
        expect(process.stdout.write).toBe(originals.stdoutWrite);
        expect(process.stderr.write).toBe(originals.stderrWrite);
        expect(process.exit).toBe(originals.exit);
        expect(console.log).toBe(originals.consoleLog);
        expect(console.error).toBe(originals.consoleError);
        expect(console.warn).toBe(originals.consoleWarn);
        expect(console.info).toBe(originals.consoleInfo);
        expect(process.exitCode).toBe(7);
        expect(typeof res.exitCode).toBe('number');
      }
    } finally {
      process.exitCode = originals.exitCode;
    }
  });

  it('reports the exit code of a command that called process.exit or set process.exitCode', async () => {
    const store = makeStore('exit codes');
    const id = await createItem(store, 'exit code item');
    const baselineExitCode = process.exitCode;

    // commander's help path calls process.exit(0)
    const help = await runInProcess(argv(OMITTED, '--help'));
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('Usage: worklog');

    // `show` on a missing id calls process.exit(1)
    const missing = await runInProcess(argv(store, `--json show ${PREFIX}-NOPE`));
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stderr).success).toBe(false);

    // `update` with a failing CAS guard sets process.exitCode = 1 and exits 1
    const stale = await runInProcess(
      argv(store, `--json update ${id} --if-status completed --status blocked`),
    );
    expect(stale.exitCode).toBe(1);
    expect(JSON.parse(stale.stdout).success).toBe(false);

    // …and the process is left on a clean slate for the next caller
    expect(process.exitCode).toBe(baselineExitCode);
  });
});

describe('in-process harness: order independence', () => {
  /**
   * Mixed read/write sequence. Each operation's output depends only on its own
   * target, and the writes are commutative (distinct items, `--no-re-sort`), so
   * running the sequence in reverse must produce the same output per call and
   * the same final state.
   */
  const OPERATIONS: Record<string, string> = {
    'show R1': `show ${PREFIX}-R1 --json`,
    'update W1 (assignee)': `update ${PREFIX}-W1 --assignee alice --no-re-sort --json`,
    'show R2': `show ${PREFIX}-R2 --json`,
    'update W2 (tags)': `update ${PREFIX}-W2 --tags order-independence --no-re-sort --json`,
  };

  function seedOrderStore(label: string): TempStore {
    const store = makeStore(label);
    seedWorkItems(store.dir, [
      { id: `${PREFIX}-R1`, title: 'read one' },
      { id: `${PREFIX}-R2`, title: 'read two' },
      { id: `${PREFIX}-W1`, title: 'write one' },
      { id: `${PREFIX}-W2`, title: 'write two' },
    ]);
    return store;
  }

  async function runSequence(
    store: TempStore,
    sequence: string[],
  ): Promise<{ outputs: Map<string, string>; finalList: string }> {
    const outputs = new Map<string, string>();
    for (const name of sequence) {
      // eslint-disable-next-line no-await-in-loop
      const res = await runInProcess(argv(store, OPERATIONS[name]));
      expect(res.exitCode, `${name} exited ${res.exitCode}: ${res.stderr}`).toBe(0);
      outputs.set(name, normaliseTimestamps(res.stdout));
    }
    const finalList = await runInProcess(argv(store, '--json list'));
    expect(finalList.exitCode).toBe(0);
    return { outputs, finalList: normaliseTimestamps(finalList.stdout) };
  }

  it('produces the same output per call and the same final state when reversed', async () => {
    const forward = Object.keys(OPERATIONS);
    const reverse = [...forward].reverse();

    const forwardRun = await runSequence(seedOrderStore('order forward'), forward);
    const reverseRun = await runSequence(seedOrderStore('order reverse'), reverse);

    for (const name of forward) {
      expect(reverseRun.outputs.get(name), `output of "${name}" depends on call order`).toBe(
        forwardRun.outputs.get(name),
      );
    }
    expect(reverseRun.finalList).toBe(forwardRun.finalList);
  });
});

describe('in-process harness: reuse contract (WL-0MVVXG4B200968BF)', () => {
  it('characterises one construction, one plugin context and one DB open per cold call', async () => {
    const store = makeStore('cold call');
    await createItem(store, 'cold call item');

    resetInprocHarnessStats();
    const before = getInprocHarnessStats();
    const res = await runInProcess(argv(store, '--json list'));
    expect(res.exitCode).toBe(0);
    const stats = delta(before, getInprocHarnessStats());

    // This is the pre-change cost the parent investigation measured: every
    // call builds its own Commander program, plugin context and DB handle.
    expect(stats.calls).toBe(1);
    expect(stats.commandsConstructed).toBe(1);
    expect(stats.pluginContextsCreated).toBe(1);
    expect(stats.databasesOpened).toBe(1);
  });

  it.fails(
    'reuses one construction and one plugin context across stateless read calls (RED-PINNED until WL-0MVVXG4B200968BF)',
    async () => {
      const store = makeStore('reuse contract');
      await createItem(store, 'reuse contract item');

      const READ_CALLS = 3;
      resetInprocHarnessStats();
      const before = getInprocHarnessStats();
      for (let i = 0; i < READ_CALLS; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const res = await runInProcess(argv(store, '--json list'));
        expect(res.exitCode).toBe(0);
      }
      const stats = delta(before, getInprocHarnessStats());
      expect(stats.calls).toBe(READ_CALLS);

      // Post-change expectation: the stateless read path shares one Commander
      // construction and one plugin context across the run of calls.
      expect(stats.commandsConstructed).toBeLessThanOrEqual(1);
      expect(stats.pluginContextsCreated).toBeLessThanOrEqual(1);
      // DB open is production startup (child 1 measured ~42-47 % of a fresh
      // store call and classified it as production work, not harness work), so
      // it is budgeted at most once per call — this only catches a regression
      // that opens the store more than once for a single read.
      expect(stats.databasesOpened).toBeLessThanOrEqual(READ_CALLS);
    },
  );
});
