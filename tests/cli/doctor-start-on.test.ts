/**
 * `wl doctor` reports a startOn storage mismatch (WL-0MWMGEPY2004EDZ8, parent
 * WL-0MWM0FDZK007BAD0, AC6).
 *
 * The unit suite (`tests/unit/start-on-doctor-check.test.ts`) pins the check
 * logic; this file pins the **wiring**: a global `startOn.missing` finding, with
 * a remediation hint, appears in the real `wl doctor --json` payload when a row
 * still has no stored `startOn`, and disappears once every row is populated.
 *
 * Reaching the mismatch needs a raw SQL write: the store back-fills the column on
 * every write and reads `NULL` as `createdAt`, so only the stored column can
 * show an un-run back-fill. That is exactly why the check reads the raw column.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
  seedWorkItems,
} from './cli-helpers.js';

describe('wl doctor startOn checks (CLI)', () => {
  let state: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(state.tempDir);
    seedWorkItems(state.tempDir, [
      { id: 'TEST-SCHEDULED', title: 'Scheduled item', startOn: '2026-11-19T10:25:00Z' },
      { id: 'TEST-DEFAULT', title: 'Default item' },
    ]);
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  /** Run `wl doctor --json` and return its findings array. */
  async function doctorFindings(): Promise<any[]> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor`);
    return JSON.parse(stdout);
  }

  /** The startOn findings in a doctor payload. */
  function startOnFindings(findings: any[]): any[] {
    return findings.filter(
      (finding) => typeof finding.checkId === 'string' && finding.checkId.startsWith('startOn.'),
    );
  }

  it('reports no startOn finding for a fully populated store', async () => {
    // First invocation materialises the SQLite store from the seeded JSONL.
    await execAsync(`tsx ${cliPath} --json list`);

    const findings = startOnFindings(await doctorFindings());

    expect(findings).toEqual([]);
  });

  it('reports the un-back-filled rows as one global finding with a remediation hint', async () => {
    await execAsync(`tsx ${cliPath} --json list`);
    const dbPath = path.join(state.tempDir, '.worklog', 'worklog.db');
    const conn = new Database(dbPath);
    try {
      conn.prepare('UPDATE workitems SET startOn = NULL WHERE id = ?').run('TEST-DEFAULT');
    } finally {
      conn.close();
    }

    const findings = startOnFindings(await doctorFindings());

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      checkId: 'startOn.missing',
      type: 'start-on-missing',
      severity: 'warning',
      itemId: null,
      safe: false,
    });
    expect(findings[0].message).toContain('TEST-DEFAULT');
    expect(findings[0].message).toContain('wl doctor upgrade --confirm');
    expect(findings[0].context.missingCount).toBe(1);
    expect(findings[0].context.remediation).toContain('docs/migrations/start_on.md');
  });
});
