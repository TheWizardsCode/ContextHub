/**
 * Test: wl list --json includes auditedAt
 *
 * Verifies that `wl list --json` and `wl next --json` include the
 * `auditedAt` timestamp for each work item that has an audit result.
 * Items without an audit result should have `auditedAt: null`.
 *
 * See WL-0MS7EVW8K002FYN2.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, seedWorkItems, cliPath } from './cli-helpers.js';

describe('wl list --json includes auditedAt', () => {
  let state: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(state.tempDir);
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  it('includes auditedAt for items with an audit result', async () => {
    const now = new Date().toISOString();
    seedWorkItems(
      state.tempDir,
      [
        { id: 'TEST-1', title: 'Audited item' },
      ],
      [],
      [
        { workItemId: 'TEST-1', readyToClose: true, auditedAt: now, summary: 'Ready', author: 'auditor' },
      ]
    );

    const { stdout } = await execAsync(`tsx ${cliPath} list --json`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItems).toBeDefined();
    expect(result.workItems.length).toBe(1);
    const item = result.workItems[0];
    expect(item.id).toBe('TEST-1');
    expect(item.auditedAt).toBe(now);
    expect(item.auditResult).toBe(true);
  });

  it('includes auditedAt: null for items without an audit result', async () => {
    seedWorkItems(
      state.tempDir,
      [
        { id: 'TEST-1', title: 'Unaudited item' },
      ]
    );

    const { stdout } = await execAsync(`tsx ${cliPath} list --json`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItems.length).toBe(1);
    const item = result.workItems[0];
    expect(item.id).toBe('TEST-1');
    expect(item.auditedAt).toBeNull();
    expect(item.auditResult).toBeNull();
  });

  it('includes auditedAt in mixed items (some audited, some not)', async () => {
    const now = new Date().toISOString();
    seedWorkItems(
      state.tempDir,
      [
        { id: 'TEST-1', title: 'Audited item' },
        { id: 'TEST-2', title: 'Unaudited item' },
        { id: 'TEST-3', title: 'Another audited item' },
      ],
      [],
      [
        { workItemId: 'TEST-1', readyToClose: true, auditedAt: now, summary: 'Ready', author: 'auditor' },
        { workItemId: 'TEST-3', readyToClose: false, auditedAt: now, summary: 'Needs work', author: 'auditor' },
      ]
    );

    const { stdout } = await execAsync(`tsx ${cliPath} list --json`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItems.length).toBe(3);

    const byId = Object.fromEntries(result.workItems.map((wi: any) => [wi.id, wi]));

    expect(byId['TEST-1'].auditedAt).toBe(now);
    expect(byId['TEST-1'].auditResult).toBe(true);
    expect(byId['TEST-2'].auditedAt).toBeNull();
    expect(byId['TEST-2'].auditResult).toBeNull();
    expect(byId['TEST-3'].auditedAt).toBe(now);
    expect(byId['TEST-3'].auditResult).toBe(false);
  });
});

describe('wl next --json includes auditedAt', () => {
  let state: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(state.tempDir);
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  it('includes auditedAt for the next work item', async () => {
    const now = new Date().toISOString();
    seedWorkItems(
      state.tempDir,
      [
        { id: 'TEST-1', title: 'Next item', status: 'open', stage: 'plan_complete' },
      ],
      [],
      [
        { workItemId: 'TEST-1', readyToClose: true, auditedAt: now, summary: 'Ready', author: 'auditor' },
      ]
    );

    const { stdout } = await execAsync(`tsx ${cliPath} next --json`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItem).toBeDefined();
    expect(result.workItem.id).toBe('TEST-1');
    expect(result.workItem.auditedAt).toBe(now);
    expect(result.workItem.auditResult).toBe(true);
  });

  it('includes auditedAt: null for the next item without an audit', async () => {
    seedWorkItems(
      state.tempDir,
      [
        { id: 'TEST-1', title: 'Next item', status: 'open', stage: 'plan_complete' },
      ]
    );

    const { stdout } = await execAsync(`tsx ${cliPath} next --json`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItem.id).toBe('TEST-1');
    expect(result.workItem.auditedAt).toBeNull();
  });
});
