/**
 * API-level filtering of work items by the `needsProducerReview` flag.
 *
 * Migrated from the legacy `test/validator.test.ts` (WL-0MV4UUK120029UR5,
 * child of WL-0MV28X3BT0079JM3). The only genuinely unique coverage in that
 * legacy file was the REST API `needsProducerReview` filter and its HTTP 400
 * response for an invalid value; the CLI-documentation validator assertion it
 * also contained remains covered by `test/validator.test.ts`.
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

  it('filters items by needsProducerReview', async () => {
    const needsReview = db.create({ title: 'Needs review', needsProducerReview: true });
    const noReview = db.create({ title: 'No review', needsProducerReview: false });

    const resTrue = await getItems('/items?needsProducerReview=true');
    expect(resTrue.status).toBe(200);
    expect(resTrue.body.map((i: any) => i.id)).toEqual([needsReview.id]);

    const resFalse = await getItems('/items?needsProducerReview=false');
    expect(resFalse.status).toBe(200);
    expect(resFalse.body.map((i: any) => i.id)).toEqual([noReview.id]);
  });

  it('rejects invalid needsProducerReview values', async () => {
    const res = await getItems('/items?needsProducerReview=maybe');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid');
  });
});
