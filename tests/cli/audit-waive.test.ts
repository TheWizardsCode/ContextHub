/**
 * Integration tests for `wl audit-waive` / `wl audit-unwaive`
 * (WL-0MUBVH9FV0027COG AC1).
 *
 * Verifies the durable waiver record is created, surfaced by `wl show --json`,
 * removed by `audit-unwaive`, and round-trips through JSONL export/import.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
} from './cli-helpers.js';
import { exportToJsonl, importFromJsonl } from '../../src/jsonl.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';

async function runJson(args: string): Promise<any> {
  const { stdout } = await execAsync(`tsx ${cliPath} --json ${args}`);
  return JSON.parse(stdout);
}

describe('audit-waive / audit-unwaive', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeInitSemaphore(tempState.tempDir);
    writeConfig(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  async function createInReviewItem(title: string): Promise<string> {
    const created = await runJson(`create -t "${title}"`);
    const id = created.workItem.id;
    await runJson(`update ${id} --status completed --stage in_review`);
    return id;
  }

  it('records a durable waiver that `show --json` surfaces', async () => {
    const id = await createInReviewItem('Waivable item');

    const waived = await runJson(`audit-waive ${id} --reason "legacy pre-audit item" --author "producer"`);
    expect(waived.success).toBe(true);
    expect(waived.workItemId).toBe(id);
    expect(waived.auditWaiver).toMatchObject({
      reason: 'legacy pre-audit item',
      author: 'producer',
    });
    expect(typeof waived.auditWaiver.waivedAt).toBe('string');

    const shown = await runJson(`show ${id}`);
    expect(shown.workItem.auditWaiver).toMatchObject({
      reason: 'legacy pre-audit item',
      author: 'producer',
    });
    // Surfaced top-level too, for machine consumers.
    expect(shown.auditWaiver).toMatchObject({ reason: 'legacy pre-audit item' });
  });

  it('requires a non-empty --reason', async () => {
    const id = await createInReviewItem('Needs a reason');
    await expect(
      execAsync(`tsx ${cliPath} --json audit-waive ${id} --reason "   "`),
    ).rejects.toThrow();
  });

  it('audit-unwaive removes the record (and is idempotent)', async () => {
    const id = await createInReviewItem('Removable waiver');
    await runJson(`audit-waive ${id} --reason "temporary"`);

    const unwaived = await runJson(`audit-unwaive ${id}`);
    expect(unwaived.success).toBe(true);
    expect(unwaived.auditWaiver).toBeNull();

    const shown = await runJson(`show ${id}`);
    expect(shown.workItem.auditWaiver).toBeFalsy();
    expect(shown.auditWaiver).toBeNull();

    // Idempotent second removal.
    const again = await runJson(`audit-unwaive ${id}`);
    expect(again.success).toBe(true);
    expect(again.auditWaiver).toBeNull();
  });

  it('errors for an unknown work item', async () => {
    await expect(
      execAsync(`tsx ${cliPath} --json audit-waive TEST-DOESNOTEXIST --reason "x"`),
    ).rejects.toThrow();
    await expect(
      execAsync(`tsx ${cliPath} --json audit-unwaive TEST-DOESNOTEXIST`),
    ).rejects.toThrow();
  });

  it('round-trips the waiver through JSONL export/import', () => {
    const dir = createTempDir();
    try {
      const file = path.join(dir, 'data.jsonl');
      const waivedAt = '2026-09-28T10:00:00.000Z';
      const item: any = {
        id: 'TEST-ROUNDTRIP',
        title: 'JSONL round-trip',
        description: '',
        status: 'completed',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        tags: [],
        assignee: '',
        stage: 'in_review',
        issueType: '',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '',
        effort: '',
        needsProducerReview: false,
        auditWaiver: { reason: 'round-trip me', author: 'producer', waivedAt },
      };

      exportToJsonl([item], [], file, [], []);
      const { items } = importFromJsonl(file);

      expect(items).toHaveLength(1);
      expect(items[0].auditWaiver).toEqual({ reason: 'round-trip me', author: 'producer', waivedAt });

      // A JSONL entry without a waiver stays absent/null on import.
      const plain: any = { ...item, id: 'TEST-ROUNDTRIP-2' };
      delete plain.auditWaiver;
      exportToJsonl([plain], [], file, [], []);
      const { items: items2 } = importFromJsonl(file);
      expect(items2[0].auditWaiver == null).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
