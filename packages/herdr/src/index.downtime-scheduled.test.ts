/**
 * packages/herdr/src/index.downtime-scheduled.test.ts — scheduled-prompt
 * reading/triggering and round-robin rotation wiring tests (work item
 * WL-0MVOA238A0078J2H).
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDowntimeDeps } from './index.js';
import { DISPATCHER_ASSIGNEE } from './index.claim.js';
import { reserve } from './host-dispatch-budget.js';
import type { ScheduledPrompt } from './downtime-worker.js';
import { SCHEDULED_PROMPTS_FILE, scheduledPromptsPath } from './scheduled-prompts.js';
import { resetExecFileAsync, resetWorklogDir, setExecFileAsync, setWorklogDir } from './fetcher.js';
import { setupHostCpuPin, makeTempDir, resetTempDirs } from './index.fixtures.js';

setupHostCpuPin();

// ---------------------------------------------------------------------------
// createDowntimeDeps scheduled-prompts wiring (WL-0MSS1Q5ER007QDKX)
//
// The scheduled-prompts tier reads the project-local config at
// <cwd>/.worklog/scheduled-prompts.json through getDueScheduledPrompt and
// persists lastTriggeredAt through recordScheduledPromptTrigger (atomic
// tmp+rename). Both are fail-closed: absent/malformed config ⇒ no dispatch.
// ---------------------------------------------------------------------------

describe('createDowntimeDeps getDueScheduledPrompt', () => {
  afterEach(() => {
    resetExecFileAsync();
    resetWorklogDir();
    resetTempDirs();
  });

  const refactor: ScheduledPrompt = {
    id: '/skill:refactor',
    prompt: '/skill:refactor',
    intervalDays: 3,
    lastTriggeredAt: null,
    // Absent in the file ⇒ parseScheduledPrompt normalizes it to the
    // scheduled-prompt default (`high`, WL-0MVIDWJ090090J3Q AC3).
    priority: 'high',
  };

  it('reads the config and returns the first due entry (null lastTriggeredAt = due)', async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      scheduledPromptsPath(cwd),
      JSON.stringify({ entries: [refactor] }),
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const due = await deps.getDueScheduledPrompt(cwd);

    expect(due).toEqual(refactor);
  });

  it('returns null when the only entries are not yet due', async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      scheduledPromptsPath(cwd),
      JSON.stringify({
        entries: [
          {
            ...refactor,
            lastTriggeredAt: new Date(Date.now() - 86_400_000).toISOString(), // 1 day ago, due in 2
          },
        ],
      }),
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    expect(await deps.getDueScheduledPrompt(cwd)).toBeNull();
  });

  it('returns null for an absent config (fail-closed, logged)' , async () => {
    const cwd = makeTempDir();
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    expect(await deps.getDueScheduledPrompt(cwd)).toBeNull();
  });

  it('returns null for a malformed config (fail-closed, logged)', async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(scheduledPromptsPath(cwd), '{broken json', 'utf8');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    expect(await deps.getDueScheduledPrompt(cwd)).toBeNull();
  });

  it('skips invalid entries (fail-closed) and still returns the first valid due one', async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      scheduledPromptsPath(cwd),
      JSON.stringify({
        entries: [
          { id: 'broken', prompt: '', intervalDays: 0, lastTriggeredAt: null },
          refactor,
        ],
      }),
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    expect(await deps.getDueScheduledPrompt(cwd)).toEqual(refactor);
  });
});

describe('createDowntimeDeps recordScheduledPromptTrigger', () => {
  afterEach(() => {
    resetTempDirs();
  });

  const refactor: ScheduledPrompt = {
    id: '/skill:refactor',
    prompt: '/skill:refactor',
    intervalDays: 3,
    lastTriggeredAt: null,
  };
  const at = '2026-08-17T12:00:00.000Z';

  it('persists lastTriggeredAt atomically and preserves the other entries', async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(
      scheduledPromptsPath(cwd),
      JSON.stringify({ entries: [refactor, { ...refactor, id: 'weekly', intervalDays: 7 }] }),
      'utf8',
    );

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await expect(deps.recordScheduledPromptTrigger(cwd, '/skill:refactor', at)).resolves.toBe(true);

    const parsed = JSON.parse(readFileSync(scheduledPromptsPath(cwd), 'utf8')) as {
      entries: ScheduledPrompt[];
    };
    expect(parsed.entries.find((e) => e.id === '/skill:refactor')?.lastTriggeredAt).toBe(at);
    expect(parsed.entries.find((e) => e.id === 'weekly')?.lastTriggeredAt).toBeNull();
    // No tmp file left behind (atomic tmp+rename).
    expect(readdirSync(join(cwd, '.worklog'))).toEqual([SCHEDULED_PROMPTS_FILE]);
  });

  it('resolves false when the config is absent or malformed (fail-closed, never throws)', async () => {
    const cwd = makeTempDir();
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await expect(deps.recordScheduledPromptTrigger(cwd, '/skill:refactor', at)).resolves.toBe(false);

    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(scheduledPromptsPath(cwd), '{broken', 'utf8');
    await expect(deps.recordScheduledPromptTrigger(cwd, '/skill:refactor', at)).resolves.toBe(false);
  });

  it('resolves false for an unknown entry id (fail-closed)', async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    writeFileSync(scheduledPromptsPath(cwd), JSON.stringify({ entries: [refactor] }), 'utf8');

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    await expect(deps.recordScheduledPromptTrigger(cwd, 'nope', at)).resolves.toBe(false);
  });
});

describe('createDowntimeDeps rotation wiring (WL-0MSSRED76008LGB6)', () => {
  afterEach(() => {
    resetExecFileAsync();
    resetWorklogDir();
  });

  it('getNextItem rotates within a tied-priority group via the shared cursor file', async () => {
    const cwd = makeTempDir();
    const worklogDir = join(cwd, '.worklog');
    mkdirSync(worklogDir, { recursive: true });
    // Two same-priority candidates; a pre-advanced cursor file selects the second first.
    writeFileSync(
      join(worklogDir, 'downtime-round-robin.json'),
      JSON.stringify({ high: { cursor: 1, version: 2 } }),
    );
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        workItems: [
          { workItem: { id: 'WL-A', title: 'A', status: 'open', priority: 'high', sortIndex: 10 } },
          { workItem: { id: 'WL-B', title: 'B', status: 'open', priority: 'high', sortIndex: 20 } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    // Cursor 1 % 2 = 1 → selects WL-B first
    const result = await deps.getNextItem('intake_complete', cwd);
    expect(result).toEqual({
      ok: true,
      candidate: { id: 'WL-B', title: 'B', stage: 'intake_complete', status: 'open', sortIndex: 20, priority: 'high' },
    });
  });

  it('getNextItem persists the cursor advance so a second call rotates to the next tied item', async () => {
    const cwd = makeTempDir();
    const worklogDir = join(cwd, '.worklog');
    mkdirSync(worklogDir, { recursive: true });
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        workItems: [
          { workItem: { id: 'WL-A', title: 'A', status: 'open', priority: 'high', sortIndex: 10 } },
          { workItem: { id: 'WL-B', title: 'B', status: 'open', priority: 'high', sortIndex: 20 } },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', DISPATCHER_ASSIGNEE);
    const first = await deps.getNextItem('intake_complete', cwd);
    expect(first.ok && first.candidate?.id).toBe('WL-A'); // cursor 0 % 2 = 0

    const second = await deps.getNextItem('intake_complete', cwd);
    expect(second.ok && second.candidate?.id).toBe('WL-B'); // cursor advanced → 1 % 2 = 1
  });
});
