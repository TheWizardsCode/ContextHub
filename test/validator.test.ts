import { execaSync } from 'execa';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import express from 'express';
import { createAPI } from '../src/api.js';
import { WorklogDatabase } from '../src/database.js';
import * as fs from 'fs';

const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');

describe('CLI documentation validator', () => {
  it('validator script exits zero and prints OK', () => {
    const res = execaSync(process.execPath, [path.resolve(__dirname, '..', 'scripts', 'validate-cli-md.cjs')], { encoding: 'utf-8' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('OK: All help commands present in CLI.md');
  });
});

describe('API needsProducerReview filter', () => {
  const tmpDir = path.join(process.cwd(), 'tmp-api-test');
  const worklogDir = path.join(tmpDir, '.worklog');
  const jsonlPath = path.join(worklogDir, 'worklog-data.jsonl');

  const seedJsonl = () => {
    const items = [
      {
        id: 'WL-API-1',
        title: 'Needs review',
        description: '',
        status: 'open',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: [],
        assignee: '',
        stage: '',
        issueType: '',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '',
        effort: '',
        needsProducerReview: true,
      },
      {
        id: 'WL-API-2',
        title: 'No review',
        description: '',
        status: 'open',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: [],
        assignee: '',
        stage: '',
        issueType: '',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '',
        effort: '',
        needsProducerReview: false,
      },
    ];
    const lines = items.map(item => JSON.stringify({ type: 'workitem', data: item })).join('\n') + '\n';
    fs.writeFileSync(jsonlPath, lines, 'utf-8');
  };

  const withServer = async (handler: (baseUrl: string) => Promise<void>) => {
    const app = express();
    app.use(express.json());
    const db = new WorklogDatabase('WL', undefined, jsonlPath, true, true);
    const api = createAPI(db);
    app.use(api);
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await handler(baseUrl);
    } finally {
      server.close();
      db.close();
    }
  };

  const fetchJson = async (url: string) => {
    const res = await fetch(url);
    const data = await res.json();
    return { status: res.status, data };
  };

  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(worklogDir, { recursive: true });
    fs.writeFileSync(path.join(worklogDir, 'initialized'), '', 'utf-8');
    seedJsonl();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(path.resolve(__dirname, '..'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('filters items by needsProducerReview', async () => {
    await withServer(async (baseUrl) => {
      const resTrue = await fetchJson(`${baseUrl}/items?needsProducerReview=true`);
      expect(resTrue.status).toBe(200);
      expect(resTrue.data.length).toBe(1);
      expect(resTrue.data[0].id).toBe('WL-API-1');

      const resFalse = await fetchJson(`${baseUrl}/items?needsProducerReview=false`);
      expect(resFalse.status).toBe(200);
      expect(resFalse.data.length).toBe(1);
      expect(resFalse.data[0].id).toBe('WL-API-2');
    });
  });

  it('rejects invalid needsProducerReview values', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetchJson(`${baseUrl}/items?needsProducerReview=maybe`);
      expect(res.status).toBe(400);
      expect(res.data.error).toContain('Invalid');
    });
  });
});
