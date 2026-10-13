/**
 * Unit tests for the terminal-state `critical` priority auto-downgrade
 * (WL-0MSJM4EIV001A0V9).
 *
 * The helper is invoked from the explicit terminal-transition sites in the
 * `update` and `close` commands; these tests exercise its guard conditions
 * directly against a real `WorklogDatabase` so the mutable behaviour (only
 * `critical` + terminal is rewritten) is pinned independently of the CLI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { WorklogDatabase } from '../../src/database.js';
import {
  isTerminalState,
  downgradeCriticalIfTerminal,
  TERMINAL_DOWNGRADE_PRIORITY,
} from '../../src/terminal-priority.js';
import { createTempDir, cleanupTempDir, createTempJsonlPath, createTempDbPath } from '../test-utils.js';

describe('terminal-priority', () => {
  let tempDir: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    const jsonlPath = createTempJsonlPath(tempDir);
    if (fs.existsSync(jsonlPath)) {
      fs.unlinkSync(jsonlPath);
    }
    db = new WorklogDatabase('TEST', createTempDbPath(tempDir), jsonlPath, true, true);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  describe('isTerminalState', () => {
    it('treats `completed` status as terminal regardless of stage', () => {
      expect(isTerminalState({ status: 'completed', stage: 'plan_complete' })).toBe(true);
      expect(isTerminalState({ status: 'completed', stage: 'done' })).toBe(true);
    });

    it('treats `in_review` stage as terminal regardless of status', () => {
      expect(isTerminalState({ status: 'in-progress', stage: 'in_review' })).toBe(true);
    });

    it('treats non-terminal status/stage combinations as non-terminal', () => {
      expect(isTerminalState({ status: 'open', stage: 'plan_complete' })).toBe(false);
      expect(isTerminalState({ status: 'blocked', stage: 'idea' })).toBe(false);
      expect(isTerminalState({ status: 'open', stage: '' })).toBe(false);
    });
  });

  describe('downgradeCriticalIfTerminal', () => {
    it('downgrades a critical completed item to high', () => {
      const item = db.create({
        title: 'Completed critical',
        priority: 'critical',
        status: 'completed',
        stage: 'done',
      });

      const updated = downgradeCriticalIfTerminal(db, item.id);

      expect(updated).not.toBeNull();
      expect(updated?.priority).toBe(TERMINAL_DOWNGRADE_PRIORITY);
      expect(db.get(item.id)?.priority).toBe('high');
    });

    it('downgrades a critical in_review item to high', () => {
      const item = db.create({
        title: 'In-review critical',
        priority: 'critical',
        status: 'in-progress',
        stage: 'in_review',
      });

      const updated = downgradeCriticalIfTerminal(db, item.id);

      expect(updated?.priority).toBe('high');
      expect(db.get(item.id)?.priority).toBe('high');
    });

    it('leaves a non-terminal critical item untouched', () => {
      const item = db.create({
        title: 'Planning critical',
        priority: 'critical',
        status: 'open',
        stage: 'plan_complete',
      });

      expect(downgradeCriticalIfTerminal(db, item.id)).toBeNull();
      expect(db.get(item.id)?.priority).toBe('critical');
    });

    it('leaves non-critical priorities untouched even when terminal', () => {
      for (const priority of ['high', 'medium', 'low'] as const) {
        const item = db.create({
          title: `Terminal ${priority}`,
          priority,
          status: 'completed',
          stage: 'done',
        });

        expect(downgradeCriticalIfTerminal(db, item.id)).toBeNull();
        expect(db.get(item.id)?.priority).toBe(priority);
      }
    });

    it('returns null for a missing item', () => {
      expect(downgradeCriticalIfTerminal(db, 'TEST-DOES-NOT-EXIST')).toBeNull();
    });
  });
});
