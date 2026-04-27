import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import {
  buildOpenBrainSummary,
  submitToOpenBrain,
  appendToQueue,
  resolveObBinary,
  OPENBRAIN_QUEUE_FILE,
} from '../../src/openbrain.js';
import type { WorkItem } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'TEST-001',
    title: 'My Test Task',
    description: 'Do some important work',
    status: 'completed',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
    tags: [],
    assignee: 'alice',
    stage: 'done',
    issueType: 'feature',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    ...overrides,
  };
}

/**
 * Build a minimal fake child-process that behaves like the real spawn return value.
 */
function makeFakeChild(exitCode = 0) {
  const stdin = new EventEmitter() as any;
  stdin.write = vi.fn();
  stdin.end = vi.fn();

  const stderr = new EventEmitter() as any;
  const child = new EventEmitter() as any;
  child.stdin = stdin;
  child.stderr = stderr;
  child.unref = vi.fn();

  // Emit close on the next tick.
  setTimeout(() => child.emit('close', exitCode), 0);

  return child;
}

// ---------------------------------------------------------------------------
// buildOpenBrainSummary
// ---------------------------------------------------------------------------

describe('buildOpenBrainSummary', () => {
  it('includes work item id and title', () => {
    const item = makeWorkItem();
    const summary = buildOpenBrainSummary(item);
    expect(summary).toContain('TEST-001');
    expect(summary).toContain('My Test Task');
  });

  it('includes description when present', () => {
    const item = makeWorkItem({ description: 'A detailed objective' });
    const summary = buildOpenBrainSummary(item);
    expect(summary).toContain('A detailed objective');
  });

  it('omits description section when empty', () => {
    const item = makeWorkItem({ description: '' });
    const summary = buildOpenBrainSummary(item);
    expect(summary).not.toContain('## Objective');
  });

  it('includes audit text when present', () => {
    const item = makeWorkItem({
      audit: { time: '2024-01-02T00:00:00.000Z', author: 'alice', text: 'Ready to close: Yes\nDid the work' },
    });
    const summary = buildOpenBrainSummary(item);
    expect(summary).toContain('Did the work');
    expect(summary).toContain('## What was done');
  });

  it('omits audit section when audit is missing', () => {
    const item = makeWorkItem({ audit: undefined });
    const summary = buildOpenBrainSummary(item);
    expect(summary).not.toContain('## What was done');
  });

  it('includes assignee', () => {
    const item = makeWorkItem({ assignee: 'bob' });
    const summary = buildOpenBrainSummary(item);
    expect(summary).toContain('bob');
  });

  it('includes issue type', () => {
    const item = makeWorkItem({ issueType: 'bug' });
    const summary = buildOpenBrainSummary(item);
    expect(summary).toContain('bug');
  });
});

// ---------------------------------------------------------------------------
// resolveObBinary
// ---------------------------------------------------------------------------

describe('resolveObBinary', () => {
  const origEnv = process.env.WL_OB_BIN;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.WL_OB_BIN;
    } else {
      process.env.WL_OB_BIN = origEnv;
    }
  });

  it('returns "ob" by default', () => {
    delete process.env.WL_OB_BIN;
    expect(resolveObBinary()).toBe('ob');
  });

  it('uses WL_OB_BIN env variable', () => {
    process.env.WL_OB_BIN = '/usr/local/bin/ob';
    expect(resolveObBinary()).toBe('/usr/local/bin/ob');
  });

  it('uses explicit override over env var', () => {
    process.env.WL_OB_BIN = '/usr/local/bin/ob';
    expect(resolveObBinary('/custom/ob')).toBe('/custom/ob');
  });
});

// ---------------------------------------------------------------------------
// appendToQueue
// ---------------------------------------------------------------------------

describe('appendToQueue', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-ob-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a JSONL queue file and appends entries', () => {
    const entry = {
      workItemId: 'TEST-001',
      title: 'My Task',
      summary: '# My Task',
      enqueuedAt: new Date().toISOString(),
    };
    appendToQueue(entry, tmpDir);

    const queuePath = path.join(tmpDir, OPENBRAIN_QUEUE_FILE);
    expect(fs.existsSync(queuePath)).toBe(true);
    const line = fs.readFileSync(queuePath, 'utf-8').trim();
    const parsed = JSON.parse(line);
    expect(parsed.workItemId).toBe('TEST-001');
    expect(parsed.summary).toBe('# My Task');
  });

  it('appends multiple entries as separate lines', () => {
    const base = { title: 'x', summary: 'y', enqueuedAt: new Date().toISOString() };
    appendToQueue({ ...base, workItemId: 'A' }, tmpDir);
    appendToQueue({ ...base, workItemId: 'B' }, tmpDir);

    const queuePath = path.join(tmpDir, OPENBRAIN_QUEUE_FILE);
    const lines = fs.readFileSync(queuePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).workItemId).toBe('A');
    expect(JSON.parse(lines[1]).workItemId).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// submitToOpenBrain
// ---------------------------------------------------------------------------

describe('submitToOpenBrain', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-ob-submit-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('spawns ob add and writes summary to stdin', async () => {
    const item = makeWorkItem();
    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

    const fakeSpawn = (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
      return makeFakeChild(0);
    };

    await submitToOpenBrain(item, {
      obBin: '/fake/ob',
      spawnImpl: fakeSpawn as any,
      queueDir: tmpDir,
      waitForCompletion: true,
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe('/fake/ob');
    expect(spawnCalls[0].args).toContain('add');
    expect(spawnCalls[0].args).toContain('--stdin');
    expect(spawnCalls[0].args).toContain(item.title);
  });

  it('uses fully detached non-blocking spawn mode by default', async () => {
    const item = makeWorkItem();
    const spawnCalls: Array<{ cmd: string; args: string[]; opts: any; child: any }> = [];

    const fakeSpawn = (cmd: string, args: string[], opts: any) => {
      const child = makeFakeChild(0);
      spawnCalls.push({ cmd, args, opts, child });
      return child;
    };

    await submitToOpenBrain(item, {
      obBin: '/fake/ob',
      spawnImpl: fakeSpawn as any,
      queueDir: tmpDir,
      // default waitForCompletion=false
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].opts.detached).toBe(true);
    expect(spawnCalls[0].opts.stdio).toEqual(['pipe', 'ignore', 'ignore']);
    expect(spawnCalls[0].child.unref).toHaveBeenCalledTimes(1);
  });

  it('does not write to the queue when ob add succeeds', async () => {
    const item = makeWorkItem();

    await submitToOpenBrain(item, {
      obBin: '/fake/ob',
      spawnImpl: (() => makeFakeChild(0)) as any,
      queueDir: tmpDir,
      waitForCompletion: true,
    });

    const queuePath = path.join(tmpDir, OPENBRAIN_QUEUE_FILE);
    expect(fs.existsSync(queuePath)).toBe(false);
  });

  it('appends to queue when ob add exits with non-zero code', async () => {
    const item = makeWorkItem();

    await submitToOpenBrain(item, {
      obBin: '/fake/ob',
      spawnImpl: (() => makeFakeChild(1)) as any,
      queueDir: tmpDir,
      waitForCompletion: true,
    });

    const queuePath = path.join(tmpDir, OPENBRAIN_QUEUE_FILE);
    expect(fs.existsSync(queuePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(queuePath, 'utf-8').trim());
    expect(parsed.workItemId).toBe(item.id);
  });

  it('appends to queue when spawn throws (ob not found)', async () => {
    const item = makeWorkItem();

    const fakeSpawn = () => {
      throw new Error('spawn ob ENOENT');
    };

    await submitToOpenBrain(item, {
      obBin: '/nonexistent/ob',
      spawnImpl: fakeSpawn as any,
      queueDir: tmpDir,
      waitForCompletion: true,
    });

    const queuePath = path.join(tmpDir, OPENBRAIN_QUEUE_FILE);
    expect(fs.existsSync(queuePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(queuePath, 'utf-8').trim());
    expect(parsed.workItemId).toBe(item.id);
    expect(parsed.reason).toContain('ENOENT');
  });

  it('appends to queue on child process error event', async () => {
    const item = makeWorkItem();

    const fakeSpawn = () => {
      const child = new EventEmitter() as any;
      const stdin = new EventEmitter() as any;
      stdin.write = vi.fn();
      stdin.end = vi.fn();
      child.stdin = stdin;
      child.stderr = new EventEmitter();
      child.unref = vi.fn();
      // Emit error on next tick instead of close
      setTimeout(() => child.emit('error', new Error('connection refused')), 0);
      return child;
    };

    await submitToOpenBrain(item, {
      obBin: '/fake/ob',
      spawnImpl: fakeSpawn as any,
      queueDir: tmpDir,
      waitForCompletion: true,
    });

    const queuePath = path.join(tmpDir, OPENBRAIN_QUEUE_FILE);
    expect(fs.existsSync(queuePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(queuePath, 'utf-8').trim());
    expect(parsed.reason).toContain('connection refused');
  });
});
