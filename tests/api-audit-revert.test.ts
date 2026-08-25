/**
 * Tests for the API-level audit write path reversion.
 *
 * The REST API (src/api.ts) routes an `audit` field in PUT /items/:id (and
 * the prefixed variant) to the audit_results table. For consistency with the
 * CLI audit write paths, a "not ready to close" verdict on an in_review
 * (completed) item reverts it to open/plan_complete and the response carries
 * a `reverted` field.
 *
 * Work item: WL-0MSKHYI5U0069FVV (child WL-0MT0T1EQJ009DHO8)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WorklogDatabase } from '../src/database.js';
import { createAPI } from '../src/api.js';
import { createTempDir, cleanupTempDir, createTempDbPath, createTempJsonlPath } from './test-utils.js';

describe('API audit write path reversion', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    dbPath = createTempDbPath(tempDir);
    jsonlPath = createTempJsonlPath(tempDir);
    if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath);
    db = new WorklogDatabase('APIT', dbPath, jsonlPath, true, true);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  async function putAudit(id: string, auditText: string, route = `/items/${id}`): Promise<any> {
    const app = createAPI(db);
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      const res = await globalThis.fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audit: auditText }),
      });
      return { status: res.status, body: await res.json() };
    } finally {
      server.close();
    }
  }

  it('reverts an in_review/completed item on a not-ready-to-close audit and reports it', async () => {
    const item = db.create({ title: 'API item', status: 'completed', stage: 'in_review' });

    const { status, body } = await putAudit(item.id, 'Ready to close: No\nStill needs work');

    expect(status).toBe(200);
    expect(body.reverted).toBeDefined();
    expect(body.reverted.item.id).toBe(item.id);
    expect(body.reverted.from).toEqual({ status: 'completed', stage: 'in_review' });
    expect(body.reverted.to).toEqual({ status: 'open', stage: 'plan_complete' });
    expect(body.status).toBe('open');
    expect(body.stage).toBe('plan_complete');

    const refreshed = db.get(item.id);
    expect(refreshed?.status).toBe('open');
    expect(refreshed?.stage).toBe('plan_complete');
  });

  it('preserves priority on API reversion', async () => {
    const item = db.create({ title: 'API item', status: 'completed', stage: 'in_review', priority: 'high' });

    const { body } = await putAudit(item.id, 'Ready to close: No\nNope');

    expect(body.reverted).toBeDefined();
    expect(db.get(item.id)?.priority).toBe('high');
  });

  it('does not revert when the verdict is ready-to-close yes', async () => {
    const item = db.create({ title: 'API item', status: 'completed', stage: 'in_review' });

    const { status, body } = await putAudit(item.id, 'Ready to close: Yes\nAll good');

    expect(status).toBe(200);
    expect(body.reverted).toBeUndefined();
    const refreshed = db.get(item.id);
    expect(refreshed?.status).toBe('completed');
    expect(refreshed?.stage).toBe('in_review');
  });

  it('does not revert done items', async () => {
    const item = db.create({ title: 'API item', status: 'completed', stage: 'done' });

    const { body } = await putAudit(item.id, 'Ready to close: No\nNope');

    expect(body.reverted).toBeUndefined();
    expect(db.get(item.id)?.stage).toBe('done');
  });

  it('reverts via the prefixed route for consistency', async () => {
    const item = db.create({ title: 'API item', status: 'completed', stage: 'in_review' });

    const { status, body } = await putAudit(
      item.id,
      'Ready to close: No\nNope',
      `/projects/APIT/items/${item.id}`
    );

    expect(status).toBe(200);
    expect(body.reverted).toBeDefined();
    expect(body.reverted.to).toEqual({ status: 'open', stage: 'plan_complete' });
  });
});
