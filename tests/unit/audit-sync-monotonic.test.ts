/**
 * Unit tests for the audit merge/persist guards that stop `wl sync` from
 * downgrading a newer audit to an older one (SA-0MUJNFF3K009BF03).
 *
 * Two invariants:
 *
 *  1. `mergeAuditResults` is last-write-wins by `auditedAt` — the newest audit
 *     wins whichever side it comes from, so a stale local copy cannot shadow a
 *     newer remote audit (and vice versa). Local wins exact ties.
 *  2. The bulk audit persist used by every sync import path is monotonic — an
 *     older incoming audit never overwrites a newer stored one. This protects
 *     against a stale snapshot reaching the persist layer (legacy exporter, a
 *     JSONL refresh, or an old process without the store lock).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { WorklogDatabase } from '../../src/database.js';
import { mergeAuditResults } from '../../src/sync.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';

const OLDER = '2026-08-15T12:59:45.425Z';
const NEWER = '2026-09-26T13:34:32.382Z';

function audit(summary: string, auditedAt: string, readyToClose = false) {
  return {
    workItemId: 'AUD-001',
    readyToClose,
    auditedAt,
    summary,
    rawOutput: `raw: ${summary}`,
    author: 'auditor',
    fingerprint: null,
  };
}

describe('mergeAuditResults — last-write-wins by auditedAt', () => {
  it('keeps the newer local audit when the remote copy is older', () => {
    const merged = mergeAuditResults([audit('local newer', NEWER)], [audit('remote older', OLDER)]).merged;
    expect(merged).toHaveLength(1);
    expect(merged[0].summary).toBe('local newer');
    expect(merged[0].auditedAt).toBe(NEWER);
  });

  it('adopts the newer remote audit when the local copy is older', () => {
    const merged = mergeAuditResults([audit('local older', OLDER)], [audit('remote newer', NEWER)]).merged;
    expect(merged).toHaveLength(1);
    expect(merged[0].summary).toBe('remote newer');
    expect(merged[0].auditedAt).toBe(NEWER);
  });

  it('prefers the local audit on identical timestamps', () => {
    const merged = mergeAuditResults([audit('local tie', NEWER)], [audit('remote tie', NEWER)]).merged;
    expect(merged).toHaveLength(1);
    expect(merged[0].summary).toBe('local tie');
  });

  it('keeps one audit per work item and unions distinct items', () => {
    const merged = mergeAuditResults(
      [audit('local a', OLDER), { ...audit('local b', OLDER), workItemId: 'AUD-002' }],
      [audit('remote a', NEWER), { ...audit('remote c', OLDER), workItemId: 'AUD-003' }],
    ).merged;
    const byId = new Map(merged.map(a => [a.workItemId, a]));
    expect(byId.size).toBe(3);
    expect(byId.get('AUD-001')!.summary).toBe('remote a');
    expect(byId.get('AUD-002')!.summary).toBe('local b');
    expect(byId.get('AUD-003')!.summary).toBe('remote c');
  });

  it('falls back to local precedence when timestamps are unparseable', () => {
    const merged = mergeAuditResults(
      [audit('local invalid', 'not-a-date')],
      [audit('remote invalid', 'also-not-a-date')],
    ).merged;
    expect(merged).toHaveLength(1);
    expect(merged[0].summary).toBe('local invalid');
  });
});

describe('audit persist guard — sync imports never downgrade', () => {
  let testDir: string;
  let db: WorklogDatabase;

  const item = {
    id: 'AUD-001',
    title: 'Audited item',
    description: 'desc',
    status: 'open' as const,
    priority: 'medium' as const,
    sortIndex: 0,
    parentId: null,
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
    tags: [],
    assignee: '',
    stage: 'plan_complete',
    dependencies: [],
    issueType: 'bug',
    createdBy: 'test',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
  };

  beforeEach(() => {
    testDir = createTempDir();
    db = new WorklogDatabase(
      'AUD',
      path.join(testDir, 'worklog.db'),
      path.join(testDir, 'worklog-data.jsonl'),
      true,
    );
    db.import([item], []);
    db.saveAuditResult(audit('newer stored audit', NEWER));
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(testDir);
  });

  it('bulk persist (delta sync path) ignores an older incoming audit', () => {
    db.importAuditResults([audit('older incoming audit', OLDER)]);

    const stored = db.getAuditResult('AUD-001');
    expect(stored).not.toBeNull();
    expect(stored!.summary).toBe('newer stored audit');
    expect(stored!.auditedAt).toBe(NEWER);
  });

  it('full import (full-snapshot sync path) ignores an older incoming audit', () => {
    db.import([item], [], [audit('older incoming audit', OLDER)]);

    const stored = db.getAuditResult('AUD-001');
    expect(stored).not.toBeNull();
    expect(stored!.summary).toBe('newer stored audit');
    expect(stored!.auditedAt).toBe(NEWER);
  });

  it('still applies a newer incoming audit (guard is not a blanket no-op)', () => {
    const newest = '2026-10-01T08:00:00.000Z';
    db.importAuditResults([audit('even newer audit', newest, true)]);

    const stored = db.getAuditResult('AUD-001');
    expect(stored!.summary).toBe('even newer audit');
    expect(stored!.auditedAt).toBe(newest);
    expect(stored!.readyToClose).toBe(true);
  });

  it('inserts an audit for a work item that has none', () => {
    db.import([{ ...item, id: 'AUD-002' }], []);
    const incoming = { ...audit('first audit', OLDER), workItemId: 'AUD-002' };
    db.importAuditResults([incoming]);

    const stored = db.getAuditResult('AUD-002');
    expect(stored).not.toBeNull();
    expect(stored!.summary).toBe('first audit');
  });

  it('does not block an identical-timestamp audit with newer content (tie applies)', () => {
    // Equal auditedAt is a tie: the incoming row applies, as is the current
    // upsert behaviour — only strictly-older incoming audits are ignored.
    const tie = { ...audit('tie audit applies', NEWER), readyToClose: true };
    db.importAuditResults([tie]);
    const stored = db.getAuditResult('AUD-001');
    expect(stored!.summary).toBe('tie audit applies');
    expect(stored!.readyToClose).toBe(true);
  });
});
