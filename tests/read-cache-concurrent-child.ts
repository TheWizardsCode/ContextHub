/**
 * Child-process helper for read-cache cross-process concurrency tests.
 *
 * Spawned via `tsx tests/read-cache-concurrent-child.ts <childId> <rounds>`.
 * Each child:
 *   - writes/reads `rounds` unique keys (per-child argv variants) — must round-trip exactly;
 *   - hammers a shared key (`list --json`) so multiple processes race on one entry;
 *   - exits non-zero with a diagnostic if a unique-key round-trip ever fails.
 *
 * The parent test asserts exit codes, absence of temp files, and that every
 * entry file parses with a matching key header.
 */

import { ReadCache } from '../src/read-cache.js';

const childId = process.argv[2];
const rounds = Number(process.argv[3] ?? 10);

const cacheDir = process.env.CACHE_DIR;
const worklogDir = process.env.WORKLOG_DIR;
if (!cacheDir || !worklogDir) {
  process.stderr.write('CACHE_DIR and WORKLOG_DIR env vars are required\n');
  process.exit(3);
}

const cache = new ReadCache({ cacheDir });

// Unique-key round-trips: no other process touches these keys.
for (let round = 0; round < rounds; round++) {
  const argv = ['list', '--json', '--child', childId, '--round', String(round)];
  cache.set(worklogDir, argv, { child: childId, round });
  const got = cache.get(worklogDir, argv);
  if (!got || (got as any).child !== childId || (got as any).round !== round) {
    process.stderr.write(`UNIQUE-KEY MISMATCH child=${childId} round=${round}\n`);
    process.exit(1);
  }
}

// Shared-key hammering: races with other workers on one entry; the final
// value is whoever wrote last, but the file must never be unreadable.
for (let i = 0; i < rounds; i++) {
  cache.set(worklogDir, ['list', '--json'], { writer: childId, i });
  const got = cache.get(worklogDir, ['list', '--json']);
  if (got === null) {
    // Tolerated only transiently (LRU purge / concurrent invalidation) —
    // a *corrupt* entry would have been deleted by get() and reported below.
    continue;
  }
  if (typeof (got as any).writer !== 'string') {
    process.stderr.write(`SHARED-KEY CORRUPT child=${childId} i=${i}\n`);
    process.exit(2);
  }
}

process.exit(0);
