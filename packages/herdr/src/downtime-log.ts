/**
 * Bounded JSONL audit log for herdr downtime dispatches
 * (WL-0MSGPI4AR000YOK8, parent WL-0MSF49FMW009M06K).
 *
 * The log lives at `<cwd>/.worklog/downtime-dispatches.log` (the `.worklog`
 * directory is gitignored, so the file is a local artifact; the worklog
 * comment added alongside it is the durable cross-machine trail). The file
 * is bounded — only the most recent DOWNTIME_LOG_MAX_ENTRIES entries are
 * kept — so it rolls instead of growing unbounded over a long-lived plugin
 * pane. Callers must treat failures as fail-closed (never crash the worker).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** File name of the downtime dispatch audit log inside `.worklog/`. */
export const DOWNTIME_LOG_FILE = 'downtime-dispatches.log';

/** Rolling bound: keep at most this many entries in the log file. */
export const DOWNTIME_LOG_MAX_ENTRIES = 100;

/**
 * Append one entry (a JSONL line) to `<cwd>/.worklog/downtime-dispatches.log`,
 * creating the `.worklog` directory if needed and trimming the file back to
 * the most recent DOWNTIME_LOG_MAX_ENTRIES entries. Throws on I/O failure —
 * callers must catch (fail-closed).
 */
export async function appendDowntimeLogEntry(cwd: string, entry: string): Promise<void> {
  const dir = join(cwd, '.worklog');
  const file = join(dir, DOWNTIME_LOG_FILE);
  await mkdir(dir, { recursive: true });

  let lines: string[] = [];
  try {
    const existing = await readFile(file, 'utf8');
    lines = existing.split('\n').filter((line) => line.trim() !== '');
  } catch {
    lines = []; // first entry or unreadable file → start fresh
  }

  lines.push(entry);
  if (lines.length > DOWNTIME_LOG_MAX_ENTRIES) {
    lines = lines.slice(lines.length - DOWNTIME_LOG_MAX_ENTRIES);
  }
  await writeFile(file, lines.join('\n') + '\n', 'utf8');
}
