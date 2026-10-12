import { describe, it, expect } from 'vitest';
import { WorklogDatabase } from '../src/database.js';
import {
  createTempDir,
  cleanupTempDir,
  createTempDbPath,
  createTempJsonlPath,
} from './test-utils.js';

/**
 * Regression: creating a comment and then updating the work item must not
 * drop the comment. Migrated from the legacy `test/comment-update.test.ts`
 * (WL-0MV4UXG2X000W8QW) onto the shared modern temp-dir harness.
 */
describe('create comment then update workitem (regression)', () => {
  it('preserves comment after updating work item', () => {
    const tempDir = createTempDir();
    try {
      const db = new WorklogDatabase(
        'WL',
        createTempDbPath(tempDir),
        createTempJsonlPath(tempDir),
        true,
        false,
      );
      const item = db.create({ title: 'Test item', description: 'desc' });

      const comment = db.createComment({
        workItemId: item.id,
        author: 'tester',
        comment: 'closing',
        references: [],
      });
      expect(comment).not.toBeNull();
      expect(db.getAllComments().length).toBe(1);

      db.update(item.id, { status: 'completed' });

      const commentsAfter = db.getAllComments();
      expect(commentsAfter.length).toBe(1);
      expect(commentsAfter[0].comment).toBe('closing');
      db.close();
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
