import { describe, it, expect, vi, beforeEach } from 'vitest';
import throttler from '../../src/github-throttler.js';
import * as github from '../../src/github.js';

describe('gh API scheduled wrappers and migrated callsites', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('listGithubIssuesAsync uses throttler.schedule via ghApiAsyncScheduled', async () => {
    const scheduleSpy = vi.spyOn(throttler, 'schedule').mockImplementation(async (fn: any) => '[]');
    const config = { repo: 'owner/repo', labelPrefix: 'wl:' } as any;
    const issues = await github.listGithubIssuesAsync(config, undefined);
    expect(Array.isArray(issues)).toBe(true);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
  });

  it('listGithubIssueCommentsAsync uses throttler.schedule via ghApiJsonScheduled', async () => {
    const scheduleSpy = vi.spyOn(throttler, 'schedule').mockImplementation(async (fn: any) => []);
    const config = { repo: 'owner/repo', labelPrefix: 'wl:' } as any;
    const comments = await github.listGithubIssueCommentsAsync(config, 123);
    expect(Array.isArray(comments)).toBe(true);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
  });

  it('fetchLabelEventsAsync uses throttler.schedule via ghApiJsonScheduled', async () => {
    const fakeEvents = [ { event: 'labeled', label: { name: 'wl:stage:done' }, created_at: new Date().toISOString() } ];
    const scheduleSpy = vi.spyOn(throttler, 'schedule').mockImplementation(async (fn: any) => fakeEvents);
    const cache = new (github as any).LabelEventCache();
    const config = { repo: 'owner/repo', labelPrefix: 'wl:' } as any;
    const events = await github.fetchLabelEventsAsync(config, 1, cache);
    expect(Array.isArray(events)).toBe(true);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
  });
});
