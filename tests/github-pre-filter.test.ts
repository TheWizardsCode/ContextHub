import { describe, it, expect } from 'vitest';
import { filterItemsForPush, readLastPushTimestamp, writeLastPushTimestamp } from '../src/github-pre-filter.js';

const baseTime = new Date('2025-01-01T00:00:00.000Z').toISOString();

function makeItem(id: string, updatedAt: string, githubIssueNumber?: number, status: string = 'open') {
  return {
    id,
    title: id,
    description: '',
    status,
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: baseTime,
    updatedAt,
    tags: [],
    assignee: '',
    stage: '',
    issueType: '',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    githubIssueNumber,
  } as any;
}

function makeComment(id: string, workItemId: string) {
  return { id, workItemId, author: 'a', comment: 'c', createdAt: baseTime, references: [] } as any;
}

describe('github pre-filter', () => {
  it('returns all items when no timestamp', () => {
    const items = [makeItem('A', baseTime), makeItem('B', baseTime)];
    const comments = [makeComment('C1', 'A'), makeComment('C2', 'B')];
    const res = filterItemsForPush(items, comments, null);
    expect(res.filteredItems.length).toBe(2);
    expect(res.filteredComments.length).toBe(2);
    expect(res.skippedCount).toBe(0);
  });

  it('filters unchanged items with githubIssueNumber set', () => {
    const lastPush = new Date('2025-01-02T00:00:00.000Z').toISOString();
    const newer = new Date('2025-01-03T00:00:00.000Z').toISOString();
    const older = new Date('2025-01-01T12:00:00.000Z').toISOString();
    const items = [makeItem('A', older, 1), makeItem('B', newer, 2), makeItem('C', older) /* no issue number */];
    const comments = [makeComment('C1', 'A'), makeComment('C2', 'B'), makeComment('C3', 'C')];
    const res = filterItemsForPush(items, comments, lastPush);
    // A is older than lastPush and has issue number -> skipped
    // B is newer -> included
    // C has no githubIssueNumber -> included
    expect(res.filteredItems.map(i => i.id).sort()).toEqual(['B', 'C']);
    expect(res.filteredComments.map(c => c.workItemId).sort()).toEqual(['B', 'C']);
    expect(res.totalCandidates).toBe(3);
    expect(res.skippedCount).toBe(1);
  });

  it('excludes deleted items from candidates', () => {
    // Use no timestamp so filtering only removes deleted items
    const items = [makeItem('A', baseTime, 1), makeItem('B', baseTime, undefined, 'deleted')];
    const comments = [makeComment('C1', 'A'), makeComment('C2', 'B')];
    const res = filterItemsForPush(items, comments, null);
    expect(res.totalCandidates).toBe(1);
    expect(res.filteredItems.map(i => i.id)).toEqual(['A']);
    expect(res.filteredComments.map(c => c.workItemId)).toEqual(['A']);
  });

  it('read/write timestamp file roundtrip fallback', () => {
    // Ensure we can write and read a timestamp via file fallback
    const now = new Date().toISOString();
    // write to file (no DB provided)
    writeLastPushTimestamp(now as string, undefined as any);
    const read = readLastPushTimestamp(undefined as any);
    expect(read).toBeTruthy();
    expect(new Date(read as string).getTime()).toBeGreaterThan(0);
  });
});
