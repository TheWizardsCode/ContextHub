/**
 * Concurrency test: lockless reads alongside writes.
 *
 * Validates that 5+ concurrent read-only database operations do not error
 * when running alongside a write operation on a shared JSONL file.
 * This is the acceptance test for WL-0MM09WVWK12GTWPY.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fork, ChildProcess } from 'child_process';
import { createTempDir, cleanupTempDir, createTempJsonlPath, createTempDbPath } from './test-utils.js';

const WORKER_SCRIPT = path.resolve(import.meta.dirname, 'lockless-reads-worker.ts');

/**
 * Fork a worker process that either writes to or reads from a shared
 * WorklogDatabase.  The worker communicates results back via IPC.
 */
function forkWorker(
  role: 'writer' | 'reader',
  jsonlPath: string,
  tempDir: string,
  iterations: number,
): Promise<{ role: string; exitCode: number | null; error?: string; result?: string }> {
  return new Promise((resolve) => {
    const child: ChildProcess = fork(WORKER_SCRIPT, [role, jsonlPath, tempDir, String(iterations)], {
      execArgv: ['--import', 'tsx'],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });

    let stderr = '';
    let stdout = '';

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.on('exit', (code) => {
      resolve({
        role,
        exitCode: code,
        error: stderr.trim() || undefined,
        result: stdout.trim() || undefined,
      });
    });

    child.on('error', (err) => {
      resolve({
        role,
        exitCode: 1,
        error: err.message,
      });
    });
  });
}

describe('Lockless reads concurrency', () => {
  let tempDir: string;
  let jsonlPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    jsonlPath = createTempJsonlPath(tempDir);
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should allow 5+ concurrent readers alongside a writer with no lock errors', async () => {
    const NUM_READERS = 5;
    const WRITER_ITERATIONS = 20;
    const READER_ITERATIONS = 30;

    // Seed the JSONL with an initial item so readers have something to find
    const { WorklogDatabase } = await import('../src/database.js');
    const seedDbPath = createTempDbPath(tempDir);
    const seedDb = new WorklogDatabase('CONC', seedDbPath, jsonlPath, true, true);
    seedDb.create({ title: 'Seed item for concurrency test' });
    seedDb.close();

    // Launch 1 writer + N readers concurrently
    const writerPromise = forkWorker('writer', jsonlPath, tempDir, WRITER_ITERATIONS);
    const readerPromises = Array.from({ length: NUM_READERS }, () =>
      forkWorker('reader', jsonlPath, tempDir, READER_ITERATIONS),
    );

    const results = await Promise.all([writerPromise, ...readerPromises]);

    // Assertions
    for (const result of results) {
      // No process should have a non-zero exit code
      expect(result.exitCode, `${result.role} exited with code ${result.exitCode}: ${result.error}`).toBe(0);

      // No lock-related errors in stderr
      if (result.error) {
        expect(result.error).not.toContain('timeout');
        expect(result.error).not.toContain('EACCES');
        expect(result.error).not.toContain('lock');
      }
    }

    // Verify the writer actually wrote items
    const writerResult = results[0];
    expect(writerResult.result).toBeDefined();
    const writerOutput = JSON.parse(writerResult.result!);
    expect(writerOutput.itemsCreated).toBe(WRITER_ITERATIONS);

    // Verify each reader got valid data (possibly stale but valid arrays)
    for (let i = 1; i < results.length; i++) {
      const readerResult = results[i];
      expect(readerResult.result).toBeDefined();
      const readerOutput = JSON.parse(readerResult.result!);
      expect(readerOutput.totalReads).toBe(READER_ITERATIONS);
      // Each read should have returned a valid array (length >= 0)
      expect(readerOutput.allReadsValid).toBe(true);
      // At least one read should have found items (seed item exists)
      expect(readerOutput.maxItemsSeen).toBeGreaterThanOrEqual(1);
    }
  }, 30_000); // 30s timeout to catch deadlocks
});
