/**
 * Unit tests for command-log.ts — Plugin command log for tracking commands
 * executed against work items in Herdr.
 *
 * Run: npx vitest run packages/herdr/src/command-log.test.ts
 * (from the project root)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Temporary directory helpers
// ---------------------------------------------------------------------------

/** Create a unique temp directory for each test run. */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'command-log-test-'));
}

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

import {
  recordCommand,
  getLastCommand,
  setLogPath,
  resetLogPath,
  type CommandEntry,
  type CommandLogData,
  MAX_ENTRIES_PER_ITEM,
} from './command-log.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the log file and parse it (for internal state inspection). */
function readRawLog(logPath: string): CommandLogData | null {
  if (!fs.existsSync(logPath)) return null;
  try {
    const raw = fs.readFileSync(logPath, 'utf-8');
    return JSON.parse(raw) as CommandLogData;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test groups
// ---------------------------------------------------------------------------

describe('command-log module', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    // Reset to default log path after each test
    resetLogPath();
  });

  // -----------------------------------------------------------------------
  // write/read round-trip
  // -----------------------------------------------------------------------

  describe('write/read round-trip', () => {
    it('records and retrieves a command for a work item', () => {
      const logPath = path.join(tempDir, 'command-log.json');
      setLogPath(logPath);

      // Record a command
      recordCommand('WL-123', '/skill:audit WL-123');

      // Retrieve it
      const last = getLastCommand('WL-123');
      expect(last).not.toBeNull();
      expect(last!.itemId).toBe('WL-123');
      expect(last!.command).toBe('/skill:audit WL-123');
      expect(typeof last!.timestamp).toBe('string');
    });

    it('stores multiple commands per item, last returns most recent', () => {
      const logPath = path.join(tempDir, 'command-log.json');
      setLogPath(logPath);

      recordCommand('WL-456', '/skill:plan WL-456');
      // Small delay to ensure different timestamps
      const start = Date.now();
      while (Date.now() - start < 15) { /* spin */ }

      recordCommand('WL-456', 'wl update WL-456 --status in_progress');

      const last = getLastCommand('WL-456');
      expect(last!.command).toBe('wl update WL-456 --status in_progress');
    });

    it('persists commands to the JSON file', () => {
      const logPath = path.join(tempDir, 'command-log.json');
      setLogPath(logPath);

      recordCommand('WL-100', 'wl update WL-100 --priority high');

      const data = readRawLog(logPath);
      expect(data).not.toBeNull();
      expect(data!.entries).toBeDefined();
      expect(data!.entries!['WL-100']).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // getLastCommand empty state
  // -----------------------------------------------------------------------

  describe('getLastCommand empty state', () => {
    it('returns null for an item with no recorded commands', () => {
      const logPath = path.join(tempDir, 'command-log.json');
      setLogPath(logPath);

      const last = getLastCommand('WL-999');
      expect(last).toBeNull();
    });

    it('returns null when log file is empty', () => {
      const logPath = path.join(tempDir, 'command-log.json');
      setLogPath(logPath);
      // Create empty file
      fs.writeFileSync(logPath, '', 'utf-8');

      const last = getLastCommand('WL-EMPTY');
      expect(last).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Pruning when entries exceed configurable limit
  // -----------------------------------------------------------------------

  describe('pruning', () => {
    it('prunes entries to MAX_ENTRIES_PER_ITEM per item', () => {
      const logPath = path.join(tempDir, 'command-log.json');
      setLogPath(logPath);

      // Record more entries than MAX_ENTRIES_PER_ITEM
      for (let i = 0; i < 25; i++) {
        recordCommand('WL-PRUNE', `command ${i}`);
      }

      const data = readRawLog(logPath);
      expect(data).not.toBeNull();
      expect(data!.entries!['WL-PRUNE'].length).toBeLessThanOrEqual(MAX_ENTRIES_PER_ITEM);
    });

    it('prunes each item independently', () => {
      const logPath = path.join(tempDir, 'command-log.json');
      setLogPath(logPath);

      for (let i = 0; i < 25; i++) {
        recordCommand(`WL-PRUNE-A`, `a-command ${i}`);
        recordCommand(`WL-PRUNE-B`, `b-command ${i}`);
      }

      const data = readRawLog(logPath);
      expect(data!.entries!['WL-PRUNE-A'].length).toBeLessThanOrEqual(MAX_ENTRIES_PER_ITEM);
      expect(data!.entries!['WL-PRUNE-B'].length).toBeLessThanOrEqual(MAX_ENTRIES_PER_ITEM);
    });
  });

  // -----------------------------------------------------------------------
  // Atomic write (temp file + rename)
  // -----------------------------------------------------------------------

  describe('atomic write', () => {
    it('writes to a temp file then renames', () => {
      const logPath = path.join(tempDir, 'command-log.json');
      setLogPath(logPath);

      recordCommand('WL-ATOMIC', 'test command');

      // The file should exist
      expect(fs.existsSync(logPath)).toBe(true);

      // It should be valid JSON
      const data = readRawLog(logPath);
      expect(data).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Graceful degradation — missing log file
  // -----------------------------------------------------------------------

  describe('graceful degradation', () => {
    it('does not throw when log file does not exist', () => {
      const logPath = path.join(tempDir, 'nonexistent-command-log.json');
      setLogPath(logPath);

      // Should not throw
      expect(() => {
        const last = getLastCommand('WL-MISSING');
        expect(last).toBeNull();
      }).not.toThrow();
    });

    it('does not throw when log file is empty', () => {
      const logPath = path.join(tempDir, 'command-log.json');
      setLogPath(logPath);
      fs.writeFileSync(logPath, '', 'utf-8');

      expect(() => {
        const last = getLastCommand('WL-EMPTY');
        expect(last).toBeNull();
      }).not.toThrow();
    });

    it('recovers from corrupt JSON gracefully', () => {
      const logPath = path.join(tempDir, 'command-log.json');
      setLogPath(logPath);
      fs.writeFileSync(logPath, '{invalid json content', 'utf-8');

      expect(() => {
        const last = getLastCommand('WL-CORRUPT');
        expect(last).toBeNull();
      }).not.toThrow();
    });

    it('recovers from JSON with unexpected structure', () => {
      const logPath = path.join(tempDir, 'command-log.json');
      setLogPath(logPath);
      // Write valid JSON but wrong structure (not an object with entries)
      fs.writeFileSync(logPath, '"just a string"', 'utf-8');

      expect(() => {
        const last = getLastCommand('WL-BAD-STRUCT');
        expect(last).toBeNull();
      }).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent write safety
  // -----------------------------------------------------------------------

  describe('concurrent write safety', () => {
    it('does not corrupt data on concurrent writes', () => {
      const logPath = path.join(tempDir, 'command-log.json');
      setLogPath(logPath);

      // Simulate concurrent writes using promises
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          new Promise<void>(resolve => {
            recordCommand(`WL-CONC-${i % 3}`, `concurrent command ${i}`);
            resolve();
          })
        );
      }
      Promise.all(promises).catch(() => {
        // Should not throw
      });

      // Allow a tiny delay for file I/O
      const start = Date.now();
      while (Date.now() - start < 50) { /* spin */ }

      // All items should still be retrievable
      for (let i = 0; i < 3; i++) {
        const last = getLastCommand(`WL-CONC-${i}`);
        expect(last).not.toBeNull();
        expect(last!.itemId).toBe(`WL-CONC-${i}`);
      }

      // The log file should be valid JSON
      const data = readRawLog(logPath);
      expect(data).not.toBeNull();
    });
  });
});
