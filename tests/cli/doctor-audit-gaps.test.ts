/**
 * Integration tests for `wl doctor audit-gaps` (WL-0MUBVH9FV0027COG AC4).
 *
 * Verifies the read-only report lists completed/in_review items with no audit
 * record, distinguishes root vs child, age, and the shared
 * covered/waived/uncovered classification, and excludes covered/waived items
 * from the flagged set.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
  seedWorkItems,
} from './cli-helpers.js';

describe('doctor audit-gaps', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  const WAIVED_AT = '2026-09-01T00:00:00.000Z';

  function seedFixture(): void {
    const seededAt = new Date().toISOString();
    seedWorkItems(
      tempState.tempDir,
      [
        { id: 'TEST-FRESH-PARENT', title: 'Fresh-audited parent', status: 'completed', stage: 'in_review' },
        { id: 'TEST-COVERED-CHILD', title: 'Covered child', status: 'completed', stage: 'in_review', parentId: 'TEST-FRESH-PARENT' },
        { id: 'TEST-PLAIN-PARENT', title: 'Unaudited parent', status: 'completed', stage: 'in_review' },
        { id: 'TEST-UNCOVERED-CHILD', title: 'Uncovered child', status: 'completed', stage: 'in_review', parentId: 'TEST-PLAIN-PARENT' },
        {
          id: 'TEST-WAIVED-ROOT',
          title: 'Waived root',
          status: 'completed',
          stage: 'in_review',
          auditWaiver: { reason: 'legacy item', author: 'producer', waivedAt: WAIVED_AT },
        },
        { id: 'TEST-NOT-IN-SCOPE', title: 'Open item', status: 'open', stage: 'idea' },
        { id: 'TEST-DELETED', title: 'Deleted item', status: 'deleted', stage: 'in_review' },
      ],
      [],
      [
        {
          workItemId: 'TEST-FRESH-PARENT',
          readyToClose: true,
          auditedAt: seededAt,
          summary: 'ready',
          author: 'producer',
        },
      ],
    );
  }

  it('lists no-audit items with relationship, age, and coverage/waiver status', async () => {
    seedFixture();

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor audit-gaps`);
    const report = JSON.parse(stdout);

    expect(report.success).toBe(true);
    expect(report.totalScanned).toBe(7);
    // Covered child, plain parent, uncovered child, waived root.
    expect(report.noAuditCount).toBe(4);
    expect(report.coveredCount).toBe(1);
    expect(report.waivedCount).toBe(1);
    expect(report.flaggedCount).toBe(2);

    const byId = Object.fromEntries(report.items.map((i: any) => [i.id, i]));

    // Items with a fresh audit are excluded from the no-audit report.
    expect(byId['TEST-FRESH-PARENT']).toBeUndefined();
    // Out-of-scope and deleted items are excluded.
    expect(byId['TEST-NOT-IN-SCOPE']).toBeUndefined();
    expect(byId['TEST-DELETED']).toBeUndefined();

    const covered = byId['TEST-COVERED-CHILD'];
    expect(covered.classification).toBe('covered');
    expect(covered.relationship).toBe('child');
    expect(covered.parentId).toBe('TEST-FRESH-PARENT');
    expect(covered.coveredByParentId).toBe('TEST-FRESH-PARENT');
    expect(typeof covered.ageMs).toBe('number');
    expect(covered.ageMs).toBeGreaterThanOrEqual(0);
    expect(typeof covered.ageDays).toBe('number');

    const plainParent = byId['TEST-PLAIN-PARENT'];
    expect(plainParent.classification).toBe('uncovered');
    expect(plainParent.relationship).toBe('root');
    expect(plainParent.parentId).toBeNull();
    expect(plainParent.coveredByParentId).toBeNull();

    const uncoveredChild = byId['TEST-UNCOVERED-CHILD'];
    expect(uncoveredChild.classification).toBe('uncovered');
    expect(uncoveredChild.relationship).toBe('child');
    expect(uncoveredChild.parentId).toBe('TEST-PLAIN-PARENT');

    const waived = byId['TEST-WAIVED-ROOT'];
    expect(waived.classification).toBe('waived');
    expect(waived.waiver).toMatchObject({ reason: 'legacy item', author: 'producer', waivedAt: WAIVED_AT });

    // The flagged set contains only genuinely uncovered items.
    const flaggedIds = report.flagged.map((i: any) => i.id).sort();
    expect(flaggedIds).toEqual(['TEST-PLAIN-PARENT', 'TEST-UNCOVERED-CHILD']);
    expect(report.flagged.every((i: any) => i.classification === 'uncovered')).toBe(true);
  });

  it('reports no gaps for a clean database', async () => {
    const seededAt = new Date().toISOString();
    seedWorkItems(
      tempState.tempDir,
      [{ id: 'TEST-AUDITED', title: 'Audited', status: 'completed', stage: 'in_review' }],
      [],
      [{ workItemId: 'TEST-AUDITED', readyToClose: true, auditedAt: seededAt, summary: 'ok', author: 'a' }],
    );

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor audit-gaps`);
    const report = JSON.parse(stdout);

    expect(report.noAuditCount).toBe(0);
    expect(report.flaggedCount).toBe(0);
    expect(report.items).toEqual([]);
    expect(report.flagged).toEqual([]);
  });

  it('is read-only: does not change item status/stage or audit records', async () => {
    seedFixture();
    await execAsync(`tsx ${cliPath} --json doctor audit-gaps`);

    const { stdout } = await execAsync(`tsx ${cliPath} --json show TEST-PLAIN-PARENT`);
    const shown = JSON.parse(stdout);
    expect(shown.workItem.status).toBe('completed');
    expect(shown.workItem.stage).toBe('in_review');
    expect(shown.auditResult).toBeNull();
  });
});
