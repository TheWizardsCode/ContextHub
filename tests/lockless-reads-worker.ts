/**
 * Worker script for lockless-reads concurrency test.
 *
 * Invoked via child_process.fork() with arguments:
 *   [role, jsonlPath, tempDir, iterations]
 *
 * role = 'writer' | 'reader'
 * - writer: creates N work items (each triggers exportToJsonl with lock)
 * - reader: instantiates WorklogDatabase N times and calls list() (lockless reads)
 *
 * Outputs JSON to stdout with results.
 */

import * as path from 'path';
import { WorklogDatabase } from '../src/database.js';

const [role, jsonlPath, tempDir, iterationsStr] = process.argv.slice(2);
const iterations = parseInt(iterationsStr, 10);

async function runWriter(): Promise<void> {
  const dbPath = path.join(tempDir, `writer-${process.pid}.db`);
  const db = new WorklogDatabase('CONC', dbPath, jsonlPath, true, true);

  let itemsCreated = 0;
  for (let i = 0; i < iterations; i++) {
    db.create({ title: `Writer item ${i}`, description: `Created by writer pid ${process.pid}` });
    itemsCreated++;
    // Small delay to spread writes over time
    await new Promise((r) => setTimeout(r, 10));
  }

  db.close();
  process.stdout.write(JSON.stringify({ itemsCreated }));
}

async function runReader(): Promise<void> {
  let totalReads = 0;
  let allReadsValid = true;
  let maxItemsSeen = 0;

  for (let i = 0; i < iterations; i++) {
    // Each iteration creates a fresh DB instance (like a new CLI invocation)
    const dbPath = path.join(tempDir, `reader-${process.pid}-${i}.db`);
    try {
      const db = new WorklogDatabase('CONC', dbPath, jsonlPath, true, true);
      const items = db.list();

      if (!Array.isArray(items)) {
        allReadsValid = false;
      } else {
        maxItemsSeen = Math.max(maxItemsSeen, items.length);
      }

      db.close();
      totalReads++;
    } catch (error) {
      // If any read throws, report it
      allReadsValid = false;
      totalReads++;
      process.stderr.write(`Reader error on iteration ${i}: ${error}\n`);
    }

    // Small staggered delay
    await new Promise((r) => setTimeout(r, 5));
  }

  process.stdout.write(JSON.stringify({ totalReads, allReadsValid, maxItemsSeen }));
}

if (role === 'writer') {
  runWriter().catch((err) => {
    process.stderr.write(`Writer fatal: ${err}\n`);
    process.exit(1);
  });
} else if (role === 'reader') {
  runReader().catch((err) => {
    process.stderr.write(`Reader fatal: ${err}\n`);
    process.exit(1);
  });
} else {
  process.stderr.write(`Unknown role: ${role}\n`);
  process.exit(1);
}
