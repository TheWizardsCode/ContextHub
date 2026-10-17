/**
 * API-level filtering of work items by the `needsProducerReview` flag.
 *
 * Test-first contract (item WL-0MVAMS4RO000H3B0, child F1): restored from
 * the deleted corpus (`e0f04202^`). RED-pinned via `it.fails` so the
 * configured suite stays green while the contract is failing; the
 * implementation children (F2 flag + F3 CLI/API) flip `it.fails(` → `it(`
 * when the flag, the DB column and the API query param are restored.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { WorklogDatabase } from '../src/database.js';
import { createAPI } from '../src/api.js';
import {
  createTempDir,
  cleanupTempDir,
  createTempDbPath,
  createTempJsonlPath,
} from './test-utils.js';

describe('API needsProducerReview filter', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    dbPath = createTempDbPath(tempDir);
    jsonlPath = createTempJsonlPath(tempDir);
    if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath);
    db = new WorklogDatabase('APIF', dbPath, jsonlPath, true, true);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  async function getItems(query: string): Promise<{ status: number; body: any }> {
    const app = createAPI(db);
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      const res = await globalThis.fetch(`http://127.0.0.1:${port}${query}`);
      return { status: res.status, body: await res.json() };
    } finally {
      server.close();
    }
  }

  it('filters items by needsProducerReview (F3 restored)', async () => {
    const needsReview = db.create({ title: 'Needs review', needsProducerReview: true });
    const noReview = db.create({ title: 'No review', needsProducerReview: false });

    const resTrue = await getItems('/items?needsProducerReview=true');
    expect(resTrue.status).toBe(200);
    expect(resTrue.body.map((i: any) => i.id)).toEqual([needsReview.id]);

    const resFalse = await getItems('/items?needsProducerReview=false');
    expect(resFalse.status).toBe(200);
    expect(resFalse.body.map((i: any) => i.id)).toEqual([noReview.id]);
  });

  it('rejects invalid needsProducerReview values (F3 restored)', async () => {
    const res = await getItems('/items?needsProducerReview=maybe');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid');
  });
});
