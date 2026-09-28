/**
 * Unit tests for the synthetic "recent dispatch" row builder
 * (WL-0MUL2IY8L009S3PQ, parent WL-0MUGLL9SS002E1D2).
 *
 * The projection in `downtime-log.ts` yields `RecentDispatchRow`s; this slice
 * converts each into a synthetic `WorkItem` that renders through the existing
 * list line formatter and metadata panel. Synthetic rows are marked
 * `isLogDerived` so absent live fields degrade to `—` rather than crashing or
 * blanking the panel.
 */

import { describe, it, expect } from 'vitest';
import { buildDispatchWorkItem } from './dispatch-view.js';
import type { RecentDispatchRow } from './downtime-log.js';
import { formatItemLine, formatMetadataPanel, buildMetaRows } from './worklist.js';

const baseRow: RecentDispatchRow = {
  itemId: 'WL-DISP1',
  title: 'Dispatched item',
  kind: 'plan',
  latestOutcome: 'closed-as-plan-complete',
  latestTimestamp: '2026-01-02T00:00:00.000Z',
};

/** Strip ANSI escapes so assertions are readable. */
function visible(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('buildDispatchWorkItem (synthetic log-derived row)', () => {
  it('carries the log-sourced id and title (never a live wl value)', () => {
    const item = buildDispatchWorkItem(baseRow);
    expect(item.id).toBe('WL-DISP1');
    expect(item.title).toBe('Dispatched item');
  });

  it('marks the row log-derived and exposes the dispatch metadata', () => {
    const item = buildDispatchWorkItem(baseRow);
    expect(item.isLogDerived).toBe(true);
    expect(item.dispatchKind).toBe('plan');
    expect(item.dispatchOutcome).toBe('closed-as-plan-complete');
    expect(item.dispatchedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('leaves live-only fields unset so the panel can degrade them', () => {
    const item = buildDispatchWorkItem(baseRow);
    expect(item.priority).toBeUndefined();
    expect(item.risk).toBeUndefined();
    expect(item.effort).toBeUndefined();
    expect(item.auditResult).toBeUndefined();
  });

  it('derives a status from the latest outcome', () => {
    expect(buildDispatchWorkItem({ ...baseRow, latestOutcome: undefined }).status).toBe('in_progress');
    expect(buildDispatchWorkItem({ ...baseRow, latestOutcome: 'requires-attention' }).status).toBe('blocked');
    expect(buildDispatchWorkItem({ ...baseRow, latestOutcome: 'audit-passed' }).status).toBe('completed');
  });

  it('tolerates a row with no kind, outcome or timestamp', () => {
    const item = buildDispatchWorkItem({ itemId: 'WL-MIN', title: 'Minimal' });
    expect(item.id).toBe('WL-MIN');
    expect(item.dispatchKind).toBeUndefined();
    expect(item.dispatchOutcome).toBeUndefined();
    expect(item.dispatchedAt).toBeUndefined();
    expect(item.status).toBe('in_progress');
  });
});

describe('formatItemLine — synthetic dispatch row (WL-0MUL2IY8L009S3PQ)', () => {
  it('renders the id and title without throwing', () => {
    const line = formatItemLine(buildDispatchWorkItem(baseRow), 120);
    expect(visible(line)).toContain('WL-DISP1');
    expect(visible(line)).toContain('Dispatched item');
  });

  it('shows the dispatch kind and latest outcome', () => {
    const line = visible(formatItemLine(buildDispatchWorkItem(baseRow), 160));
    expect(line).toContain('[plan]');
    expect(line).toContain('closed-as-plan-complete');
  });

  it('does not annotate a normal (non-log-derived) item', () => {
    const line = visible(
      formatItemLine({ id: 'WL-LIVE', title: 'Live item', status: 'open' }, 160),
    );
    expect(line).toContain('WL-LIVE');
    expect(line).not.toContain('[plan]');
  });
});

describe('formatMetadataPanel — absent live fields degrade to — (WL-0MUL2IY8L009S3PQ)', () => {
  it('renders — for priority, risk, effort and audit state', () => {
    const joined = visible(formatMetadataPanel(buildDispatchWorkItem(baseRow), 80, 30, 0).join('\n'));
    expect(joined).toMatch(/Priority\s+—/);
    expect(joined).toMatch(/Risk\s+—/);
    expect(joined).toMatch(/Effort\s+—/);
    expect(joined).toMatch(/Audit\s+—/);
  });

  it('shows the dispatch kind, outcome and timestamp in the panel', () => {
    const joined = visible(formatMetadataPanel(buildDispatchWorkItem(baseRow), 100, 30, 0).join('\n'));
    expect(joined).toContain('Dispatch');
    expect(joined).toContain('plan');
    expect(joined).toContain('Outcome');
    expect(joined).toContain('closed-as-plan-complete');
    expect(joined).toContain('Dispatched');
  });

  it('does not crash and still renders the id/title for a minimal synthetic row', () => {
    const lines = formatMetadataPanel(buildDispatchWorkItem({ itemId: 'WL-MIN', title: '[unknown]' }), 80, 30, 0);
    const joined = visible(lines.join('\n'));
    expect(joined).toContain('WL-MIN');
    expect(joined).toContain('[unknown]');
    expect(lines.length).toBe(30);
  });

  it('leaves live items with a genuinely absent field omitted (no — regression)', () => {
    const rows = buildMetaRows({ id: 'WL-LIVE', title: 'Live', status: 'open' });
    const labels = rows.map(([l]) => l);
    expect(labels).not.toContain('Priority');
    expect(labels).not.toContain('Risk');
    expect(labels).not.toContain('Effort');
  });
});
