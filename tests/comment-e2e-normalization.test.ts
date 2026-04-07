import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempDir, cleanupTempDir, createTempDbPath, createTempJsonlPath } from './test-utils.js';
import { WorklogDatabase } from '../src/database.js';
import { runInProcess } from './cli/cli-inproc.js';
import { createAPI } from '../src/api.js';

// End-to-end tests that exercise CLI, API, and TUI/Controller paths to ensure
// comment normalization (unescape of \n, \t, etc.) is applied consistently.

describe('comment normalization end-to-end (CLI, API, TUI)', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;

  beforeEach(async () => {
    tempDir = createTempDir();
    // Create .worklog directory so CLI and DB agree on locations
    const fs = await import('fs');
    const cfgDir = `${tempDir}/.worklog`;
    fs.mkdirSync(cfgDir, { recursive: true });
    // Use worklog's default filenames under .worklog so both CLI and
    // in-process DB instance operate on the same files.
    jsonlPath = `${cfgDir}/worklog-data.jsonl`;
    dbPath = `${cfgDir}/worklog.db`;
    // Minimal config and initialized marker so CLI recognizes the project
    fs.writeFileSync(`${cfgDir}/config.yaml`, `projectName: E2E\nprefix: E2E\n`, 'utf8');
    fs.writeFileSync(`${cfgDir}/initialized`, JSON.stringify({ version: '1.0.0', initializedAt: new Date().toISOString() }), 'utf8');
    db = new WorklogDatabase('E2E', dbPath, jsonlPath, true, true);
  });

  afterEach(async () => {
    db.close();
    cleanupTempDir(tempDir);
  });

  it('CLI: create comment with escaped newline becomes real newline in DB', async () => {
    const item = db.create({ title: 'CLI E2E' });

    // Ensure the CLI picks up the same DB by creating a minimal .worklog in
    // the temp directory and chdir'ing into it (the CLI uses getDefaultDataPath()).
    const cwd = process.cwd();
    let result: any;
    try {
      process.chdir(tempDir);
      const cfgDir = `${tempDir}/.worklog`;
      // Lazy-create .worklog and write a minimal config and initialized marker
      // so the CLI will treat this directory as an initialized project.
      // Keep contents minimal and aligned with Worklog expectations.
      // Write using Node fs via import to avoid pulling new helpers.
      // eslint-disable-next-line no-import-assign
      const fs = await import('fs');
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(`${cfgDir}/config.yaml`, `projectName: E2E\nprefix: E2E\n`, 'utf8');
      fs.writeFileSync(`${cfgDir}/initialized`, JSON.stringify({ version: '1.0.0', initializedAt: new Date().toISOString() }), 'utf8');

      const cmd = `node src/cli.ts comment add ${item.id} --comment "First\\nSecond" --author cli-test`;
      result = await runInProcess(cmd);
      // capture for diagnostics if needed
      // eslint-disable-next-line no-console
      // console.error('runInProcess result', result);
    } finally {
      process.chdir(cwd);
    }
    // Dump CLI output for diagnostics if the comment isn't stored
    const comments = db.getCommentsForWorkItem(item.id);
    if (comments.length === 0) {
      // Attach output to test logs for debugging
      // eslint-disable-next-line no-console
      console.error('CLI stdout:', result.stdout);
      // eslint-disable-next-line no-console
      console.error('CLI stderr:', result.stderr);
    }
    expect(comments).toHaveLength(1);
    expect(comments[0].comment).toBe('First\nSecond');
  });

  it('API: POST /items/:id/comments with escaped newline becomes real newline in DB', async () => {
    const item = db.create({ title: 'API E2E' });

    const app = createAPI(db);
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/items/${item.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: 'api-test', comment: 'One\\nTwo' }),
      });
      expect(res.status).toBe(201);

      const comments = db.getCommentsForWorkItem(item.id);
      expect(comments).toHaveLength(1);
      expect(comments[0].comment).toBe('One\nTwo'.replace('\\n', '\n'));
    } finally {
      server.close();
    }
  });

  it('TUI/Controller path: invoking createComment via controller flow stores unescaped newline', () => {
    const item = db.create({ title: 'TUI E2E' });

    // Instead of driving the full TUI, call the same controller-level method
    // the TUI uses which ultimately calls db.createComment.
    db.createComment({ workItemId: item.id, author: 'tui-test', comment: 'A\\nB', references: [] });

    const comments = db.getCommentsForWorkItem(item.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].comment).toBe('A\nB');
  });
});
