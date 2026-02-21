import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { cleanupTempDir, createTempDir } from '../test-utils.js';
import { exportToJsonl } from '../../src/jsonl.js';
import type { WorkItem, Comment, WorkItemPriority, WorkItemStatus } from '../../src/types.js';
import { runInProcess } from './cli-inproc.js';

// Wrapper around child_process.exec that injects a test-local mock `git`
// binary found at `tests/cli/mock-bin` by prefixing PATH. This allows tests
// to run fast without invoking the real `git` executable while preserving
// the same `exec` behaviour (returns { stdout, stderr }).
const _exec = promisify(childProcess.exec);
export async function execAsync(command: string, options?: childProcess.ExecOptions & { timeout?: number }): Promise<{ stdout: string; stderr: string }> {
  const env = { ...process.env } as Record<string, string | undefined>;
  try {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const mockBin = path.join(projectRoot, 'tests', 'cli', 'mock-bin');
    if (fs.existsSync(mockBin)) {
      env.PATH = `${mockBin}:${env.PATH || ''}`;
    }
  } catch (e) {
    // ignore; fall back to process.env
  }

  const execOptions = { ...(options || {}), env } as childProcess.ExecOptions;
  // If the command invokes the local CLI via `tsx <cliPath>` run it in-process
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const cliPath = path.join(projectRoot, 'src', 'cli.ts');
  const isLocalCli = command.trim().startsWith('tsx') && command.includes(cliPath);
  const isInitCommand = /\binit\b/.test(command);
  if (isLocalCli) {
    // Avoid in-process for init to preserve interactive behavior in tests.
    if (isInitCommand) {
      const result = await _exec(command, execOptions as any);
      const stdout = typeof (result as any).stdout === 'string' ? (result as any).stdout : (result as any).stdout?.toString('utf-8') ?? '';
      const stderr = typeof (result as any).stderr === 'string' ? (result as any).stderr : (result as any).stderr?.toString('utf-8') ?? '';
      return { stdout, stderr };
    }
    const originalCwd = process.cwd();
    try {
      if (options?.cwd) process.chdir(options.cwd as string);
      const res = await runInProcess(command, options?.timeout ?? 25000);
      if (res.exitCode && res.exitCode !== 0) {
        const error: any = new Error(`Command failed: ${command}`);
        error.stdout = res.stdout ?? '';
        error.stderr = res.stderr ?? '';
        error.exitCode = res.exitCode;
        // Re-throw so callers can handle CLI errors; do NOT fall back to spawning
        throw error;
      }
      return { stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
    } finally {
      try { process.chdir(originalCwd); } catch (_) {}
    }
  }

  // reuse promisified exec for other commands
  // child_process.exec may return Buffer for stdout/stderr; normalize to string
  const result = await _exec(command, execOptions as any);
  const stdout = typeof (result as any).stdout === 'string' ? (result as any).stdout : (result as any).stdout?.toString('utf-8') ?? '';
  const stderr = typeof (result as any).stderr === 'string' ? (result as any).stderr : (result as any).stderr?.toString('utf-8') ?? '';
  return { stdout, stderr };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

export const cliPath = path.join(projectRoot, 'src', 'cli.ts');

export async function execWithInput(
  command: string,
  input: string,
  options?: childProcess.ExecOptions
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return await new Promise((resolve, reject) => {
    // Ensure the mocked PATH is passed to spawned children so tests that use
    // spawn (with shell) pick up the tests/cli/mock-bin git mock as well.
    const env = { ...(options?.env || process.env) } as Record<string, string | undefined>;
    try {
      const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
      const mockBin = path.join(projectRoot, 'tests', 'cli', 'mock-bin');
      if (fs.existsSync(mockBin)) {
        env.PATH = `${mockBin}${path.delimiter}${env.PATH || ''}`;
      }
    } catch (e) {
      // ignore
    }

    const child = childProcess.spawn(command, {
      shell: true,
      cwd: options?.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

export function enterTempDir(): { tempDir: string; originalCwd: string } {
  const tempDir = createTempDir();
  const originalCwd = process.cwd();
  process.chdir(tempDir);
  return { tempDir, originalCwd };
}

export function leaveTempDir(state: { tempDir: string; originalCwd: string }): void {
  process.chdir(state.originalCwd);
  cleanupTempDir(state.tempDir);
}

export function writeConfig(dir: string, projectName: string = 'Test Project', prefix: string = 'TEST'): void {
  fs.mkdirSync(path.join(dir, '.worklog'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.worklog', 'config.yaml'),
    [
      `projectName: ${projectName}`,
      `prefix: ${prefix}`,
      'statuses:',
      '  - value: open',
      '    label: Open',
      '  - value: in-progress',
      '    label: In Progress',
      '  - value: blocked',
      '    label: Blocked',
      '  - value: completed',
      '    label: Completed',
      '  - value: deleted',
      '    label: Deleted',
      'stages:',
      '  - value: ""',
      '    label: Undefined',
      '  - value: idea',
      '    label: Idea',
      '  - value: prd_complete',
      '    label: PRD Complete',
      '  - value: plan_complete',
      '    label: Plan Complete',
      '  - value: in_progress',
      '    label: In Progress',
      '  - value: in_review',
      '    label: In Review',
      '  - value: done',
      '    label: Done',
      'statusStageCompatibility:',
      '  open: ["", idea, prd_complete, plan_complete, in_progress]',
      '  in-progress: [in_progress]',
      '  blocked: ["", idea, prd_complete, plan_complete, in_progress]',
      '  completed: [in_review, done]',
      '  deleted: [""]'
    ].join('\n'),
    'utf-8'
  );
}

export function writeInitSemaphore(
  dir: string,
  version: string = '1.0.0',
  initializedAt: string = '2024-01-23T12:00:00.000Z'
): void {
  fs.mkdirSync(path.join(dir, '.worklog'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.worklog', 'initialized'),
    JSON.stringify({ version, initializedAt }),
    'utf-8'
  );
}

export function seedWorkItems(
  dir: string,
  items: Array<{
    id?: string;
    title: string;
    description?: string;
    status?: WorkItemStatus;
    priority?: WorkItemPriority;
    parentId?: string | null;
    tags?: string[];
    assignee?: string;
    stage?: string;
    needsProducerReview?: boolean;
  }>,
  comments: Comment[] = []
): WorkItem[] {
  const now = new Date().toISOString();
  const seeded = items.map((item, index) => ({
    id: item.id ?? `TEST-${index + 1}`,
    title: item.title,
    description: item.description ?? '',
    status: item.status ?? 'open',
    priority: item.priority ?? 'medium',
    sortIndex: 0,
    parentId: item.parentId ?? null,
    createdAt: now,
    updatedAt: now,
    tags: item.tags ?? [],
    assignee: item.assignee ?? '',
    stage: item.stage ?? '',
    issueType: '',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '' as const,
    effort: '' as const,
    needsProducerReview: item.needsProducerReview ?? false,
  }));

  const dataPath = path.join(dir, '.worklog', 'worklog-data.jsonl');
  exportToJsonl(seeded, comments, dataPath, []);
  return seeded;
}
