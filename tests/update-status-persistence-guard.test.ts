/**
 * Defence in depth: an explicit `wl update <id> --status <s>` must never
 * report `success: true` when the store holds a different value.
 *
 * Parent: WL-0MVTUKSJZ003WK82 — `wl update --status blocked` silently reverts
 * to `open` and still reports success. Fix task: WL-0MVTVYXZD002NDMP (the
 * explicit write now wins over the derived reconcile). This suite pins
 * AC3 of the parent — "persists or **fails loudly**" — for the residual
 * case a later write (a competing process, a future reconcile) still wins:
 * the CLI re-reads the persisted record after the write and exits non-zero
 * with the distinct `status-not-persisted` error naming both values.
 *
 * ## The seam
 *
 * The guard is exercised through the real command registration with a
 * **stubbed database seam**: the test wraps the `WorklogDatabase` instance
 * handed to the command so that a competing write lands immediately after
 * the requested write and wins. The store really does end up holding the
 * divergent value — nothing is faked in the read path — so the assertion
 * proves the guard observes the persisted record rather than the update's
 * return value.
 *
 * Work item: WL-0MVTVZ9RU003D4WW
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { createPluginContext } from '../src/cli-utils.js';
import updateCommand from '../src/commands/update.js';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
} from './cli/cli-helpers.js';

interface InProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Hooks that let a test control the seams the update command sees. */
interface SeamHooks {
  /** Wrap the database instance before the command uses it. */
  wrapDatabase?: (db: any) => void;
  /** Override the loaded config (e.g. to disable status/stage validation). */
  getConfig?: () => any;
}

/**
 * Run `wl update` in-process against the current temp worklog, with
 * `process.exit` trapped so the failure exit code is observable and the
 * declared seams applied. Mirrors tests/cli/cli-inproc.ts for one command.
 */
async function runUpdateInProcess(args: string[], seams: SeamHooks = {}): Promise<InProcessResult> {
  const out: string[] = [];
  const err: string[] = [];
  const origExit = process.exit;
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  const origConsoleLog = console.log;
  const origConsoleError = console.error;
  const origExitCode = process.exitCode;

  const program = new Command();
  program
    .name('worklog')
    .option('--json', 'Output in JSON format')
    .option('-F, --format <format>', 'Human display format');

  const ctx = createPluginContext(program);
  const origGetDatabase = ctx.utils.getDatabase.bind(ctx.utils);
  ctx.utils.getDatabase = (prefix?: string) => {
    const db = origGetDatabase(prefix);
    seams.wrapDatabase?.(db);
    return db;
  };
  if (seams.getConfig) {
    ctx.utils.getConfig = seams.getConfig;
  }
  updateCommand(ctx);

  let trappedExitCode: number | null = null;
  process.stdout.write = ((chunk: any) => {
    out.push(String(chunk));
    return true;
  }) as any;
  process.stderr.write = ((chunk: any) => {
    err.push(String(chunk));
    return true;
  }) as any;
  console.log = ((...logArgs: any[]) => {
    out.push(`${logArgs.map(String).join(' ')}\n`);
  }) as any;
  console.error = ((...logArgs: any[]) => {
    err.push(`${logArgs.map(String).join(' ')}\n`);
  }) as any;
  process.exit = ((code?: number) => {
    trappedExitCode = code ?? 0;
    throw new Error(`__INPROC_EXIT__:${code ?? 0}`);
  }) as any;

  process.exitCode = 0;
  try {
    await program.parseAsync(['node', 'worklog', ...args], { from: 'node' });
  } catch (e: any) {
    if (!String(e?.message ?? '').startsWith('__INPROC_EXIT__')) throw e;
  } finally {
    const exitCode = trappedExitCode ?? (typeof process.exitCode === 'number' ? process.exitCode : 0);
    process.exit = origExit;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origConsoleLog;
    console.error = origConsoleError;
    process.exitCode = origExitCode;
    trappedExitCode = exitCode;
  }
  return { stdout: out.join(''), stderr: err.join(''), exitCode: trappedExitCode ?? 0 };
}

describe('wl update --status persistence guard (WL-0MVTVZ9RU003D4WW)', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  /** Create an item through the real CLI and return its id. */
  async function createItem(title: string): Promise<string> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "${title}"`);
    return JSON.parse(stdout).workItem.id as string;
  }

  /** Read the persisted status through a separate CLI process. */
  async function persistedStatus(id: string): Promise<string> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    return JSON.parse(stdout).workItem.status as string;
  }

  it('fails loudly with `status-not-persisted` when a competing write wins', async () => {
    const item = await createItem('Divergence item');

    const result = await runUpdateInProcess(
      ['--json', 'update', item, '--status', 'blocked'],
      {
        // A competing write lands immediately after ours and wins — the shape
        // of the original defect. The store genuinely holds `open` afterwards,
        // so the guard must detect the divergence by re-reading it.
        wrapDatabase: (db: any) => {
          const realUpdate = db.update.bind(db);
          let reverted = false;
          db.update = (id: string, input: any, options?: any) => {
            const updated = realUpdate(id, input, options);
            if (!reverted && id === item && input?.status === 'blocked') {
              reverted = true;
              realUpdate(id, { status: 'open' }, { reconcileSelf: false });
            }
            return updated;
          };
        },
      },
    );

    // Non-zero exit — a divergent write is never a success.
    expect(result.exitCode).not.toBe(0);

    const payload = JSON.parse(result.stdout);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe('status-not-persisted');
    expect(payload.workItem).toBeUndefined();
    // Both values are named: what was requested and what the store holds.
    expect(payload.requestedStatus).toBe('blocked');
    expect(payload.persistedStatus).toBe('open');
    expect(payload.message).toContain('blocked');
    expect(payload.message).toContain('open');

    // The divergence was real, not injected into the read path.
    expect(await persistedStatus(item)).toBe('open');
  });

  it('reports success when the requested status is the persisted status', async () => {
    const item = await createItem('Consistent item');

    const result = await runUpdateInProcess(['--json', 'update', item, '--status', 'blocked']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.success).toBe(true);
    expect(payload.workItem.status).toBe('blocked');
    expect(await persistedStatus(item)).toBe('blocked');
  });

  it('fails loudly when an explicit --status never reaches the store at all', async () => {
    const item = await createItem('Unvalidated item');

    // Without status/stage validation the command cannot build the status
    // field, so it takes its "no fields changed" path. An explicit --status
    // request must not be reported as success there either.
    const result = await runUpdateInProcess(
      ['--json', 'update', item, '--status', 'blocked'],
      {
        getConfig: () => ({
          projectName: 'Test Project',
          prefix: 'TEST',
          statuses: [],
          stages: [],
          statusStageCompatibility: undefined,
        }),
      },
    );

    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe('status-not-persisted');
    expect(payload.requestedStatus).toBe('blocked');
    expect(payload.persistedStatus).toBe('open');
    expect(await persistedStatus(item)).toBe('open');
  });
});
