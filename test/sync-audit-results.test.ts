import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WorklogDatabase } from '../src/database.js';
import { importFromJsonlContent } from '../src/jsonl.js';

const testDir = path.join(__dirname, 'tmp_sync_audits');
const dbPath = path.join(testDir, 'worklog.db');
const jsonlPath = path.join(testDir, 'worklog-data.jsonl');

function ensureTestDir() {
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
}

function cleanup() {
  for (const f of fs.readdirSync(testDir)) {
    const p = path.join(testDir, f);
    if (fs.lstatSync(p).isDirectory()) {
      for (const bf of fs.readdirSync(p)) fs.unlinkSync(path.join(p, bf));
      fs.rmdirSync(p);
    } else {
      fs.unlinkSync(p);
    }
  }
}

function makeItem(id: string, title: string) {
  return {
    id,
    title,
    description: `Description for ${title}`,
    status: 'open' as const,
    priority: 'medium' as const,
    sortIndex: 0,
    parentId: null,
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
    tags: [],
    assignee: 'test-agent',
    stage: 'intake_complete',
    dependencies: [],
    issueType: 'feature',
    createdBy: 'test',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    needsProducerReview: false,
  };
}

describe('sync audit results preservation', () => {
  beforeEach(() => {
    ensureTestDir();
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it('preserves audit results across a full export->import round-trip', async () => {
    const db = new WorklogDatabase('WI', dbPath, jsonlPath);
    
    const item = makeItem('WL-001', 'Test Item');
    db.import([item], []);
    
    db.saveAuditResult({
      workItemId: item.id,
      readyToClose: true,
      auditedAt: '2026-06-05T12:00:00.000Z',
      summary: 'All acceptance criteria satisfied',
      rawOutput: 'Test output',
      author: 'test-agent',
    });

    // Verify audit exists before export
    const auditsBefore = db.getAllAuditResults();
    expect(auditsBefore.length).toBe(1);
    expect(auditsBefore[0].workItemId).toBe(item.id);
    expect(auditsBefore[0].readyToClose).toBe(true);
    expect(auditsBefore[0].summary).toBe('All acceptance criteria satisfied');

    // Export to JSONL
    await db.exportForSync();
    
    // Import from JSONL (simulating a pull+import cycle)
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const data = importFromJsonlContent(content);
    
    expect(data.auditResults).toBeDefined();
    expect(data.auditResults.length).toBe(1);
    expect(data.auditResults[0].workItemId).toBe(item.id);
    expect(data.auditResults[0].readyToClose).toBe(true);
    expect(data.auditResults[0].summary).toBe('All acceptance criteria satisfied');
    expect(data.auditResults[0].author).toBe('test-agent');
    expect(data.auditResults[0].rawOutput).toBe('Test output');
  });

  it('preserves multiple audit results across export->import', async () => {
    const db = new WorklogDatabase('WI', dbPath, jsonlPath);
    
    const item1 = makeItem('WL-001', 'Item One');
    const item2 = makeItem('WL-002', 'Item Two');
    db.import([item1, item2], []);

    db.saveAuditResult({
      workItemId: item1.id,
      readyToClose: false,
      auditedAt: '2026-06-05T10:00:00.000Z',
      summary: 'Needs more tests',
      rawOutput: null,
      author: 'reviewer-1',
    });

    db.saveAuditResult({
      workItemId: item2.id,
      readyToClose: true,
      auditedAt: '2026-06-05T11:00:00.000Z',
      summary: 'Ready to ship',
      rawOutput: 'Full output here',
      author: 'reviewer-2',
    });

    // Export and import
    await db.exportForSync();
    
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const data = importFromJsonlContent(content);
    
    expect(data.auditResults.length).toBe(2);
    
    const auditMap = new Map(data.auditResults.map(a => [a.workItemId, a]));
    
    expect(auditMap.has(item1.id)).toBe(true);
    expect(auditMap.has(item2.id)).toBe(true);
    expect(auditMap.get(item1.id)!.readyToClose).toBe(false);
    expect(auditMap.get(item1.id)!.author).toBe('reviewer-1');
    expect(auditMap.get(item2.id)!.readyToClose).toBe(true);
    expect(auditMap.get(item2.id)!.author).toBe('reviewer-2');
  });

  it('does not lose audit results when importing with import() (the destructive path)', async () => {
    const db = new WorklogDatabase('WI', dbPath, jsonlPath);
    
    const item = makeItem('WL-001', 'Test Item');
    db.import([item], []);

    db.saveAuditResult({
      workItemId: item.id,
      readyToClose: true,
      auditedAt: '2026-06-05T12:00:00.000Z',
      summary: 'Good to go',
      rawOutput: null,
      author: 'auditor',
    });

    // Export
    await db.exportForSync();
    
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const data = importFromJsonlContent(content);
    
    // Import via db.import (which calls clearWorkItems - the old destructive path)
    db.import(data.items, data.dependencyEdges, data.auditResults);
    db.importComments(data.comments);
    
    // Verify audits are preserved
    const audits = db.getAllAuditResults();
    expect(audits.length).toBe(1);
    expect(audits[0].workItemId).toBe(item.id);
    expect(audits[0].summary).toBe('Good to go');
    expect(audits[0].author).toBe('auditor');
  });

  it('handles empty audit results gracefully', async () => {
    const db = new WorklogDatabase('WI', dbPath, jsonlPath);
    
    const item = makeItem('WL-001', 'No Audit Item');
    db.import([item], []);

    // Verify no audits before export
    expect(db.getAllAuditResults().length).toBe(0);
    
    // Export and import
    await db.exportForSync();
    
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const data = importFromJsonlContent(content);
    
    expect(data.auditResults).toBeDefined();
    expect(data.auditResults.length).toBe(0);
  });
});

describe('mergeAuditResults', () => {
  it('merges local and remote audit results with local precedence', async () => {
    const { mergeAuditResults } = await import('../src/sync.js');
    
    const localAudits = [
      {
        workItemId: 'WL-001',
        readyToClose: true,
        auditedAt: '2026-06-05T10:00:00.000Z',
        summary: 'Local says ready',
        rawOutput: null,
        author: 'local-reviewer',
      },
      {
        workItemId: 'WL-003',
        readyToClose: false,
        auditedAt: '2026-06-05T10:00:00.000Z',
        summary: 'Local audit for item 3',
        rawOutput: null,
        author: 'local-reviewer',
      },
    ];
    
    const remoteAudits = [
      {
        workItemId: 'WL-002',
        readyToClose: true,
        auditedAt: '2026-06-05T11:00:00.000Z',
        summary: 'Remote audit for item 2',
        rawOutput: null,
        author: 'remote-reviewer',
      },
      {
        workItemId: 'WL-003',
        readyToClose: true,
        auditedAt: '2026-06-05T11:00:00.000Z',
        summary: 'Remote says ready too',
        rawOutput: null,
        author: 'remote-reviewer',
      },
    ];
    
    const merged = mergeAuditResults(localAudits, remoteAudits);
    
    // Should have 3 unique items
    expect(merged.merged.length).toBe(3);
    
    const map = new Map(merged.merged.map(a => [a.workItemId, a]));
    
    // WL-001: local only
    expect(map.get('WL-001')!.author).toBe('local-reviewer');
    expect(map.get('WL-001')!.summary).toBe('Local says ready');
    
    // WL-002: remote only
    expect(map.get('WL-002')!.author).toBe('remote-reviewer');
    
    // WL-003: local wins (local precedence)
    expect(map.get('WL-003')!.author).toBe('local-reviewer');
    expect(map.get('WL-003')!.summary).toBe('Local audit for item 3');
    expect(map.get('WL-003')!.readyToClose).toBe(false);
  });

  it('handles empty audit arrays', async () => {
    const { mergeAuditResults } = await import('../src/sync.js');
    
    const merged1 = mergeAuditResults([], []);
    expect(merged1.merged.length).toBe(0);
    
    const merged2 = mergeAuditResults(
      [{
        workItemId: 'WL-001',
        readyToClose: true,
        auditedAt: '2026-06-05T10:00:00.000Z',
        summary: 'Local',
        rawOutput: null,
        author: 'local',
      }],
      []
    );
    expect(merged2.merged.length).toBe(1);
    
    const merged3 = mergeAuditResults(
      [],
      [{
        workItemId: 'WL-002',
        readyToClose: false,
        auditedAt: '2026-06-05T11:00:00.000Z',
        summary: 'Remote',
        rawOutput: null,
        author: 'remote',
      }]
    );
    expect(merged3.merged.length).toBe(1);
  });
});

describe('JSONL audit_result record format', () => {
  it('parses audit_result records from JSONL content', () => {
    const jsonlContent = [
      JSON.stringify({ type: 'workitem', data: makeItem('WL-ABC', 'Test') }),
      JSON.stringify({ type: 'comment', data: { id: 'WL-C001', workItemId: 'WL-ABC', author: 'agent', comment: 'A comment', createdAt: '2026-06-05T01:00:00.000Z', references: [] } }),
      JSON.stringify({ type: 'audit_result', data: { workItemId: 'WL-ABC', readyToClose: true, auditedAt: '2026-06-05T02:00:00.000Z', summary: 'Audited', rawOutput: null, author: 'auditor' } }),
    ].join('\n') + '\n';

    const data = importFromJsonlContent(jsonlContent);
    
    expect(data.items.length).toBe(1);
    expect(data.comments.length).toBe(1);
    expect(data.auditResults.length).toBe(1);
    expect(data.auditResults[0].workItemId).toBe('WL-ABC');
    expect(data.auditResults[0].readyToClose).toBe(true);
    expect(data.auditResults[0].summary).toBe('Audited');
    expect(data.auditResults[0].author).toBe('auditor');
  });

  it('parses mixed record types in any order', () => {
    const jsonlContent = [
      JSON.stringify({ type: 'audit_result', data: { workItemId: 'WL-ABC', readyToClose: false, auditedAt: '2026-06-05T02:00:00.000Z', summary: 'First', rawOutput: null, author: 'auditor' } }),
      JSON.stringify({ type: 'workitem', data: makeItem('WL-ABC', 'Test') }),
      JSON.stringify({ type: 'comment', data: { id: 'WL-C001', workItemId: 'WL-ABC', author: 'agent', comment: 'Comment', createdAt: '2026-06-05T01:00:00.000Z', references: [] } }),
      JSON.stringify({ type: 'audit_result', data: { workItemId: 'WL-ABC', readyToClose: true, auditedAt: '2026-06-05T03:00:00.000Z', summary: 'Second', rawOutput: null, author: 'auditor2' } }),
    ].join('\n') + '\n';

    const data = importFromJsonlContent(jsonlContent);
    
    expect(data.items.length).toBe(1);
    expect(data.comments.length).toBe(1);
    expect(data.auditResults.length).toBe(2);
  });

  it('ignores unknown record types', () => {
    const jsonlContent = [
      JSON.stringify({ type: 'workitem', data: makeItem('WL-ABC', 'Test') }),
      JSON.stringify({ type: 'unknown_type', data: { foo: 'bar' } }),
      JSON.stringify({ type: 'audit_result', data: { workItemId: 'WL-ABC', readyToClose: true, auditedAt: '2026-06-05T02:00:00.000Z', summary: 'Audited', rawOutput: null, author: 'auditor' } }),
    ].join('\n') + '\n';

    const data = importFromJsonlContent(jsonlContent);
    
    expect(data.items.length).toBe(1);
    expect(data.comments.length).toBe(0);
    expect(data.auditResults.length).toBe(1);
  });
});
