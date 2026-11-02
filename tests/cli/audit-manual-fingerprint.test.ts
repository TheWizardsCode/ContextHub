/**
 * Manual audit writes record a content fingerprint (WL-0MVK01BBD005V7KK).
 *
 * Manual (synthetic) audit approval — the herdr `a-y` chord
 * (`wl audit-set --ready-to-close yes --summary 'Approved by manual review'`)
 * and any other `wl audit-set` / `wl update --audit-text` write — used to store
 * `fingerprint = null`. `isAuditFresh` then degraded to the fragile 60 s time
 * gate, so non-content `updatedAt` churn (a worklog-sync re-timestamp) wrongly
 * marked an unchanged manual approval stale.
 *
 * The fix is a pure fallback: when no explicit fingerprint input is supplied,
 * the CLI stores the item's current schema-2 content fingerprint
 * (`computeContentFingerprint` over title + description). These tests exercise
 * the real CLI in-process and assert observable behaviour — the stored
 * fingerprint, its precedence, the freshness gate, and that legacy
 * fingerprint-less rows stay untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runInProcess } from './cli-inproc.js';
import { writeConfig, writeInitSemaphore, cliPath } from './cli-helpers.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import { computeContentFingerprint } from '../../src/audit-fingerprint.js';
import { isAuditFresh } from '@worklog/shared/icons';

interface ManualApproval {
  id: string;
  auditedAt: string;
  fingerprint: string | null;
}

describe('manual audit writes record a content fingerprint (WL-0MVK01BBD005V7KK)', () => {
  let tempDir: string;
  let wlDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = createTempDir();
    writeConfig(tempDir, 'Manual Fingerprint Project', 'MFP');
    writeInitSemaphore(tempDir);
    wlDir = path.join(tempDir, '.worklog');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanupTempDir(tempDir);
  });

  const DESCRIPTION = [
    '## Summary',
    'Manual-approval fingerprint fixture.',
    '## Key Files',
    '- `package.json`',
  ].join('\n');

  async function createItem(title = 'Manual approval target'): Promise<{
    id: string;
    title: string;
    description: string;
  }> {
    const descFile = path.join(tempDir, 'description.md');
    fs.writeFileSync(descFile, DESCRIPTION);
    const res = await runInProcess(
      `tsx ${cliPath} --json --worklog-dir ${wlDir} create -t "${title}" --description-file ${descFile}`,
    );
    const created = JSON.parse(res.stdout);
    expect(created.success).toBe(true);
    return {
      id: created.workItem.id,
      title: created.workItem.title,
      description: created.workItem.description,
    };
  }

  async function auditShow(id: string): Promise<{ auditedAt: string; fingerprint: string | null }> {
    const res = await runInProcess(`tsx ${cliPath} --json --worklog-dir ${wlDir} audit-show ${id}`);
    const shown = JSON.parse(res.stdout);
    expect(shown.success).toBe(true);
    expect(shown.audit).toBeTruthy();
    return shown.audit;
  }

  /** Current content fingerprint as emitted by the `wl list` read path. */
  async function currentFingerprint(id: string): Promise<string | null> {
    const res = await runInProcess(`tsx ${cliPath} --json --worklog-dir ${wlDir} list`);
    const item = JSON.parse(res.stdout).workItems.find((w: { id: string }) => w.id === id);
    expect(item).toBeTruthy();
    return item.currentFingerprint;
  }

  /** Perform the herdr `a-y` approval chain verbatim (no fingerprint flag). */
  async function manualApproval(id: string): Promise<ManualApproval> {
    const res = await runInProcess(
      `tsx ${cliPath} --json --worklog-dir ${wlDir} audit-set ${id} ` +
        `--ready-to-close yes --summary "Approved by manual review"`,
    );
    expect(JSON.parse(res.stdout).success).toBe(true);
    const audit = await auditShow(id);
    return { id, ...audit };
  }

  describe('AC1 — wl audit-set auto-records a fingerprint', () => {
    it('stores the schema-2 content fingerprint for a --ready-to-close yes write', async () => {
      const item = await createItem();
      expect(item.description).toContain('Manual-approval fingerprint fixture.');

      const audit = await manualApproval(item.id);

      expect(audit.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(audit.fingerprint).toBe(
        computeContentFingerprint({ title: item.title, description: item.description }),
      );
      // Parity by construction with the read-time value the freshness gate uses.
      expect(audit.fingerprint).toBe(await currentFingerprint(item.id));
    });

    it('stores the fingerprint for a --ready-to-close no (reject) write too', async () => {
      const item = await createItem('Reject verdict target');

      await runInProcess(
        `tsx ${cliPath} --json --worklog-dir ${wlDir} audit-set ${item.id} ` +
          `--ready-to-close no --summary "Not ready yet"`,
      );

      const audit = await auditShow(item.id);
      expect(audit.fingerprint).toBe(
        computeContentFingerprint({ title: item.title, description: item.description }),
      );
    });
  });

  describe('AC2 — wl update --audit-text auto-records a fingerprint', () => {
    it('stores the schema-2 content fingerprint when no fingerprint input is supplied', async () => {
      const item = await createItem('Audit-text target');
      const auditText = ['Ready to close: Yes', 'All checks passed'].join('\n');

      const res = await runInProcess(
        `tsx ${cliPath} --json --worklog-dir ${wlDir} update ${item.id} --audit-text "${auditText}"`,
      );
      expect(JSON.parse(res.stdout).success).toBe(true);

      const audit = await auditShow(item.id);
      expect(audit.fingerprint).toBe(
        computeContentFingerprint({ title: item.title, description: item.description }),
      );
    });
  });

  describe('AC3 — explicit input keeps precedence', () => {
    it('keeps an explicit --fingerprint flag over the computed value', async () => {
      const item = await createItem('Explicit flag target');

      await runInProcess(
        `tsx ${cliPath} --json --worklog-dir ${wlDir} audit-set ${item.id} ` +
          `--ready-to-close yes --fingerprint sha256-explicit`,
      );

      expect((await auditShow(item.id)).fingerprint).toBe('sha256-explicit');
    });

    it('keeps a fingerprint embedded in --raw-output over the computed value', async () => {
      const item = await createItem('Embedded raw-output target');

      await runInProcess(
        `tsx ${cliPath} --json --worklog-dir ${wlDir} audit-set ${item.id} ` +
          `--ready-to-close yes --raw-output "Audit content fingerprint: sha256-embedded-raw"`,
      );

      expect((await auditShow(item.id)).fingerprint).toBe('sha256-embedded-raw');
    });

    it('keeps a fingerprint embedded in --summary over the computed value', async () => {
      const item = await createItem('Embedded summary target');

      await runInProcess(
        `tsx ${cliPath} --json --worklog-dir ${wlDir} audit-set ${item.id} ` +
          `--ready-to-close yes --summary "Audit content fingerprint: sha256-embedded-summary"`,
      );

      expect((await auditShow(item.id)).fingerprint).toBe('sha256-embedded-summary');
    });

    it('keeps an explicit --audit-fingerprint flag over the computed value', async () => {
      const item = await createItem('Explicit audit-fingerprint target');

      await runInProcess(
        `tsx ${cliPath} --json --worklog-dir ${wlDir} update ${item.id} ` +
          `--audit-text "Ready to close: Yes" --audit-fingerprint sha256-update-explicit`,
      );

      expect((await auditShow(item.id)).fingerprint).toBe('sha256-update-explicit');
    });

    it('keeps a fingerprint embedded in --audit-text over the computed value', async () => {
      const item = await createItem('Embedded audit-text target');
      const auditText = ['Ready to close: Yes', 'Audit content fingerprint: sha256-embedded-text'].join('\n');

      await runInProcess(
        `tsx ${cliPath} --json --worklog-dir ${wlDir} update ${item.id} --audit-text "${auditText}"`,
      );

      expect((await auditShow(item.id)).fingerprint).toBe('sha256-embedded-text');
    });
  });

  describe('AC4/AC5 — the freshness gate', () => {
    /** Simulated non-content `updatedAt` churn: a worklog sync re-timestamp. */
    const SYNC_BUMP_MS = 30 * 60 * 1000;

    it('a manual approval survives a sync updatedAt bump while content is unchanged', async () => {
      const item = await createItem('Churn-survivor target');
      const audit = await manualApproval(item.id);

      const syncedUpdatedAt = new Date(new Date(audit.auditedAt).getTime() + SYNC_BUMP_MS).toISOString();

      expect(
        isAuditFresh(audit.auditedAt, syncedUpdatedAt, audit.fingerprint, await currentFingerprint(item.id)),
      ).toBe(true);
      // The regression the fix closes: without a stored fingerprint the same
      // churn falls back to the 60 s time gate and marks the approval stale.
      expect(isAuditFresh(audit.auditedAt, syncedUpdatedAt, null, await currentFingerprint(item.id))).toBe(
        false,
      );
    });

    it('a content edit after a manual approval still invalidates the audit', async () => {
      const item = await createItem('Content-change target');
      const audit = await manualApproval(item.id);

      const res = await runInProcess(
        `tsx ${cliPath} --json --worklog-dir ${wlDir} update ${item.id} --title "Content-change target (edited)"`,
      );
      expect(JSON.parse(res.stdout).success).toBe(true);

      const syncedUpdatedAt = new Date(new Date(audit.auditedAt).getTime() + SYNC_BUMP_MS).toISOString();
      const refreshed = await currentFingerprint(item.id);

      expect(refreshed).not.toBe(audit.fingerprint);
      expect(isAuditFresh(audit.auditedAt, syncedUpdatedAt, audit.fingerprint, refreshed)).toBe(false);
    });
  });

  describe('AC6 — legacy manual audits are untouched', () => {
    it('does not inherit or backfill a previous fingerprint-less audit', async () => {
      const item = await createItem('Legacy row target');
      const { WorklogDatabase } = await import('../../src/database.js');

      // Seed a legacy fingerprint-less row the way pre-fix manual approvals
      // were stored (no fingerprint column value).
      const db = new WorklogDatabase(
        'MFP',
        path.join(wlDir, 'worklog.db'),
        path.join(wlDir, 'worklog-data.jsonl'),
        false,
        false,
      );
      try {
        db.saveAuditResult({
          workItemId: item.id,
          readyToClose: true,
          auditedAt: '2026-01-01T00:00:00.000Z',
          summary: 'Approved by manual review',
          rawOutput: null,
          author: 'legacy',
          fingerprint: null,
        });
        expect(db.getAuditResult(item.id)!.fingerprint).toBeNull();
      } finally {
        db.close();
      }

      // Reading the item back through the CLI must not invent a fingerprint.
      const audit = await auditShow(item.id);
      expect(audit.fingerprint).toBeNull();
      expect(audit.auditedAt).toBe('2026-01-01T00:00:00.000Z');
    });
  });
});
