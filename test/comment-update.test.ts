import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WorklogDatabase } from '../src/database';
import { cleanupTempDir } from '../tests/test-utils';

describe('create comment then update workitem (regression)', () => {
  const tmpDir = path.join(process.cwd(), 'tmp-test');
  const worklogDir = path.join(tmpDir, '.worklog');
  const jsonlPath = path.join(worklogDir, 'worklog-data.jsonl');

  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(worklogDir, { recursive: true });
    // Seed a single work item
    const item = {
      id: 'WL-TEST-1',
      title: 'Test item',
      description: 'desc',
      status: 'open',
      priority: 'medium',
      parentId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: [],
      assignee: '',
      stage: '',
      issueType: '',
      createdBy: '',
      deletedBy: '',
      deleteReason: ''
    };
    fs.writeFileSync(jsonlPath, JSON.stringify({ type: 'workitem', data: item }) + '\n', 'utf-8');
    // Mark as initialized so resolveWorklogDir prefers this dir over the repo root
    fs.writeFileSync(path.join(worklogDir, 'initialized'), '', 'utf-8');
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(path.resolve(__dirname, '..'));
    cleanupTempDir(tmpDir);
  });

  it('preserves comment after updating work item', () => {
    const db = new WorklogDatabase('WL', undefined, undefined, true, false);

    const comment = db.createComment({ workItemId: 'WL-TEST-1', author: 'tester', comment: 'closing', references: [] });
    expect(comment).not.toBeNull();
    expect(db.getAllComments().length).toBe(1);

    db.update('WL-TEST-1', { status: 'completed' });
    const commentsAfter = db.getAllComments();
    expect(commentsAfter.length).toBe(1);
    expect(commentsAfter[0].comment).toBe('closing');
    db.close?.();
  });
});
