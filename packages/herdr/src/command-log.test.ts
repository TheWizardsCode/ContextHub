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
import * as url from 'node:url';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
    it('writes complete content and leaves no temp file behind', () => {
      const logPath = path.join(tempDir, 'command-log.json');
      setLogPath(logPath);

      recordCommand('WL-ATOMIC', 'test command');

      // The file should exist
      expect(fs.existsSync(logPath)).toBe(true);

      // No temp files may remain after a successful write
      const leftovers = fs.readdirSync(tempDir).filter(f => f.includes('.tmp.'));
      expect(leftovers).toEqual([]);

      // Content must be complete and valid JSON
      const data = readRawLog(logPath);
      expect(data).not.toBeNull();
      expect(data!.entries!['WL-ATOMIC']).toHaveLength(1);
      expect(data!.entries!['WL-ATOMIC'][0].command).toBe('test command');
    });

    it('does not corrupt the existing log when a write fails mid-flight', () => {
      const logPath = path.join(tempDir, 'command-log.json');
      setLogPath(logPath);

      // Seed a log file with known content
      recordCommand('WL-OLD', 'old command');
      const before = fs.readFileSync(logPath, 'utf-8');

      // Point the log at a path whose parent is a regular file — the temp
      // write will fail, exercising the failure path of saveLog.
      const blocker = path.join(tempDir, 'blocker');
      fs.writeFileSync(blocker, 'not a directory', 'utf-8');
      const badLog = path.join(blocker, 'command-log.json');
      setLogPath(badLog);

      // Must not throw — saveLog swallows write errors
      expect(() => recordCommand('WL-NEW', 'new command')).not.toThrow();

      // Original log file must be untouched
      expect(fs.readFileSync(logPath, 'utf-8')).toBe(before);

      // No temp files may linger
      const leftovers = fs.readdirSync(tempDir).filter(f => f.includes('.tmp.'));
      expect(leftovers).toEqual([]);
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
    it('keeps the log valid and uncorrupted across real concurrent processes', async () => {
      const logPath = path.join(tempDir, 'command-log.json');
      setLogPath(logPath);

      // Worker script: imports the module under test from an absolute path
      // and records N commands for a given item id. Spawned concurrently to
      // exercise true multi-process file access (not single-threaded
      // promise interleaving).
      const modulePath = new URL('./command-log.ts', import.meta.url).href;
      const worker = path.join(tempDir, 'worker.ts');
      fs.writeFileSync(
        worker,
        `import { recordCommand, setLogPath } from ${JSON.stringify(modulePath)};
const logPath = process.argv[2];
const itemId = process.argv[3];
const count = Number(process.argv[4]);
setLogPath(logPath);
for (let i = 0; i < count; i++) {
  recordCommand(itemId, \`cmd-\${i}\`);
}
`,
        'utf-8'
      );

      const writers = 4;
      const writesPerWriter = 5;
      const runs: Promise<unknown>[] = [];
      for (let w = 0; w < writers; w++) {
        const itemId = `WL-CONC-${w}`;
        runs.push(
          execFileAsync('npx', ['tsx', worker, logPath, itemId, String(writesPerWriter)], {
            cwd: new URL('../../../..', import.meta.url).pathname,
            timeout: 60_000,
          })
        );
      }
      await Promise.all(runs);

      // The log file must be structurally valid JSON with a complete entries
      // object — atomic rename guarantees no torn/partial writes.
      const data = readRawLog(logPath);
      expect(data).not.toBeNull();
      expect(data!.version).toBe(1);
      expect(typeof data!.entries).toBe('object');
      expect(data!.entries).not.toBeNull();

      // Every entry present must be well-formed.
      for (const [id, entries] of Object.entries(data!.entries)) {
        expect(id).toMatch(/^WL-CONC-\d$/);
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) {
          expect(entry.itemId).toBe(id);
          expect(typeof entry.command).toBe('string');
          expect(typeof entry.timestamp).toBe('string');
        }
      }

      // No temp files may remain after concurrent writes
      const leftovers = fs.readdirSync(tempDir).filter(f => f.includes('.tmp.'));
      expect(leftovers).toEqual([]);
    }, 90_000);
  });
});
