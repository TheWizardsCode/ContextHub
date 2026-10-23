/**
 * Child-process helper for the cache state pruning concurrency test
 * (F8 — WL-0MVFRRGGC001IQK1).
 *
 * Spawned as `tsx tests/read-cache-prune-child.ts <bump|prune> <childId> <rounds>`.
 *
 *   bump  — increments the shared per-worklog-dir state counter `rounds`
 *           times, asserting the value never regresses (a concurrent prune
 *           must not reset a live counter) and that the counter file always
 *           parses back to a finite number.
 *   prune — runs `pruneStateDir` `rounds` times concurrently with the writers.
 *
 * Any violation exits non-zero with a diagnostic on stderr.
 */

import {
  bumpStateCounter,
  readStateCounter,
  pruneStateDir,
} from '../src/read-cache.js';

const mode = process.argv[2];
const childId = process.argv[3] ?? '0';
const rounds = Number(process.argv[4] ?? 10);

const cacheDir = process.env.CACHE_DIR;
const worklogDir = process.env.WORKLOG_DIR;
if (!cacheDir || !worklogDir) {
  process.stderr.write('CACHE_DIR and WORKLOG_DIR env vars are required\n');
  process.exit(3);
}

if (mode === 'bump') {
  let last = readStateCounter(cacheDir, worklogDir);
  for (let i = 0; i < rounds; i++) {
    const value = bumpStateCounter(cacheDir, worklogDir);
    if (!Number.isFinite(value) || value < 1) {
      process.stderr.write(`NON-FINITE COUNTER child=${childId} i=${i} value=${value}\n`);
      process.exit(1);
    }
    // Monotonicity: a bump must never return a value below the last observed
    // one, even with a pruning process racing this writer.
    if (value < last) {
      process.stderr.write(
        `COUNTER REGRESSION child=${childId} i=${i} last=${last} value=${value}\n`,
      );
      process.exit(2);
    }
    last = value;
  }
  process.exit(0);
}

if (mode === 'prune') {
  // TTL is supplied by the test (60 s) so the seeded stale counters are
  // removed while live counters (always freshly written) survive.
  const ttlMs = Number(process.env.PRUNE_TTL_MS ?? 60_000);
  for (let i = 0; i < rounds; i++) {
    const result = pruneStateDir(cacheDir, { maxFiles: 1000, ttlMs, liveWindowMs: 0 });
    if (!Number.isFinite(result.remaining) || result.remaining < 0) {
      process.stderr.write(`BAD PRUNE RESULT child=${childId} i=${i} ${JSON.stringify(result)}\n`);
      process.exit(4);
    }
  }
  process.exit(0);
}

process.stderr.write(`unknown mode: ${mode}\n`);
process.exit(5);
