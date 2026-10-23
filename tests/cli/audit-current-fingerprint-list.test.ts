/**
 * `wl list --json` emits `currentFingerprint` and it drives audit freshness —
 * end-to-end integration test (WL-0MUN7QWFP0010EQC).
 *
 * The canonical fingerprint is schema 2 (item data only — WL-0MVK5SWZE00254Y7):
 * it hashes the item's own title/description and needs no git state, so this
 * test needs no commit history. Verifies:
 *
 *   - `currentFingerprint` is present in the JSON output;
 *   - it equals the stored audit `fingerprint` for unchanged content, so
 *     `isAuditFresh` takes the primary content gate (fresh despite a stale
 *     `updatedAt`), fixing the "audit immediately invalidated" bug;
 *   - it survives `--fields` projection;
 *   - a comment (non-content change) does not invalidate it, while a title
 *     change does.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runInProcess } from './cli-inproc.js';
import { writeConfig, writeInitSemaphore, cliPath } from './cli-helpers.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import { computeContentFingerprint } from '../../src/audit-fingerprint.js';
import { isAuditFresh } from '@worklog/shared/icons';

describe('wl list --json currentFingerprint (WL-0MUN7QWFP0010EQC)', () => {
  let tempDir: string;
  let wlDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = createTempDir();
    writeConfig(tempDir, 'Fingerprint Project', 'CFP');
    writeInitSemaphore(tempDir);
    wlDir = path.join(tempDir, '.worklog');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanupTempDir(tempDir);
  });

  async function createItem(
    description: string,
    title = 'Fingerprint item',
  ): Promise<{ id: string; title: string; description: string }> {
    const descFile = path.join(tempDir, 'description.md');
    fs.writeFileSync(descFile, description);
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

  it('emits a currentFingerprint matching the stored fingerprint for unchanged content', async () => {
    const { id, title, description } = await createItem(
      ['## Summary', 'Fingerprint integration fixture.', '## Key Files', '- `package.json`'].join('\n'),
    );
    const expected = computeContentFingerprint({ title, description });
    expect(expected).toMatch(/^[0-9a-f]{64}$/);

    const auditRes = await runInProcess(
      `tsx ${cliPath} --json --worklog-dir ${wlDir} audit-set ${id} --ready-to-close yes --fingerprint ${expected} --summary "Ready to close: Yes"`,
    );
    expect(JSON.parse(auditRes.stdout).success).toBe(true);

    const listRes = await runInProcess(`tsx ${cliPath} --json --worklog-dir ${wlDir} list`);
    const payload = JSON.parse(listRes.stdout);
    const item = payload.workItems.find((w: { id: string }) => w.id === id);
    expect(item).toBeTruthy();
    expect(item.fingerprint).toBe(expected);
    expect(item.currentFingerprint).toBe(expected);
    // The primary content gate now applies: the audit is fresh because the
    // fingerprints match, independent of the updatedAt/time gate.
    expect(
      isAuditFresh(item.auditedAt, item.updatedAt, item.fingerprint, item.currentFingerprint),
    ).toBe(true);
  });

  it('ignores non-content changes (a comment) and invalidates on a title change', async () => {
    const { id, title, description } = await createItem(
      ['## Summary', 'Comment/title fixture.', '## Key Files', '- `package.json`'].join('\n'),
    );
    const expected = computeContentFingerprint({ title, description });
    await runInProcess(
      `tsx ${cliPath} --json --worklog-dir ${wlDir} audit-set ${id} --ready-to-close yes --fingerprint ${expected} --summary "Ready to close: Yes"`,
    );

    // A comment is not content: the schema-2 fingerprint is unchanged.
    await runInProcess(`tsx ${cliPath} --json --worklog-dir ${wlDir} comment add ${id} --comment "note"`);
    const afterComment = JSON.parse(
      (await runInProcess(`tsx ${cliPath} --json --worklog-dir ${wlDir} list`)).stdout,
    ).workItems.find((w: { id: string }) => w.id === id);
    expect(afterComment.currentFingerprint).toBe(expected);
    expect(
      isAuditFresh(
        afterComment.auditedAt,
        afterComment.updatedAt,
        afterComment.fingerprint,
        afterComment.currentFingerprint,
      ),
    ).toBe(true);

    // The title IS content: the fingerprint moves and the audit is stale.
    await runInProcess(
      `tsx ${cliPath} --json --worklog-dir ${wlDir} update ${id} --title "Renamed fingerprint item"`,
    );
    const afterTitle = JSON.parse(
      (await runInProcess(`tsx ${cliPath} --json --worklog-dir ${wlDir} list`)).stdout,
    ).workItems.find((w: { id: string }) => w.id === id);
    expect(afterTitle.currentFingerprint).not.toBe(expected);
    expect(
      isAuditFresh(
        afterTitle.auditedAt,
        afterTitle.updatedAt,
        afterTitle.fingerprint,
        afterTitle.currentFingerprint,
      ),
    ).toBe(false);
  });

  it('keeps a strict --fields projection (enrichment fields, including currentFingerprint, are dropped)', async () => {
    const { id, title, description } = await createItem(
      ['## Work', 'Projection fixture.', '## Key Files', '- `package.json`'].join('\n'),
    );
    const expected = computeContentFingerprint({ title, description });
    await runInProcess(
      `tsx ${cliPath} --json --worklog-dir ${wlDir} audit-set ${id} --ready-to-close yes --fingerprint ${expected} --summary "ok"`,
    );

    const listRes = await runInProcess(
      `tsx ${cliPath} --json --worklog-dir ${wlDir} list --fields id,title,status`,
    );
    const payload = JSON.parse(listRes.stdout);
    const item = payload.workItems.find((w: { id: string }) => w.id === id);
    expect(item).toBeTruthy();
    expect(Object.keys(item).sort()).toEqual(['id', 'status', 'title']);
    expect(item.currentFingerprint).toBeUndefined();
  });

  it('reports null currentFingerprint for items without a stored audit fingerprint', async () => {
    const { id } = await createItem('## Key Files\n- `package.json`');
    const listRes = await runInProcess(`tsx ${cliPath} --json --worklog-dir ${wlDir} list`);
    const payload = JSON.parse(listRes.stdout);
    const item = payload.workItems.find((w: { id: string }) => w.id === id);
    expect(item.currentFingerprint).toBeNull();
  });
});
