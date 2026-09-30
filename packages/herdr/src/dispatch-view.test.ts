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
import { stageIcon, auditIcon } from '@worklog/shared/icons';
import { buildDispatchWorkItem, mergeDispatchRow } from './dispatch-view.js';
import type { RecentDispatchRow } from './downtime-log.js';
import type { WorkItem } from './fetcher.js';
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
    expect(item.isLogOnly).toBe(true);
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

// ── Icon consistency with every other view (WL-0MUGLL9SS002E1D2 audit fix) ──
// A manual review rejected the first implementation because the dispatches view
// rendered the ❓ unknown-stage glyph where every other view shows a real
// stage/audit icon. The synthetic row now carries the log-derived stage (and
// any audit verdict) so the shared icon helpers produce identical output.
describe('buildDispatchWorkItem — stage/audit icons match other views', () => {
  it('carries the log-derived stage onto the synthetic item', () => {
    const item = buildDispatchWorkItem({ ...baseRow, stage: 'plan_complete' });
    expect(item.stage).toBe('plan_complete');
  });

  it('renders a real stage icon in the list line, never the ❓ unknown fallback', () => {
    const line = visible(formatItemLine(buildDispatchWorkItem({ ...baseRow, stage: 'plan_complete' }), 160));
    expect(line).toContain(stageIcon('plan_complete'));
    expect(line).not.toContain('\u{2753}');
  });

  it('renders the fresh audit verdict icon for an audit outcome (like a live in_review audit)', () => {
    const passed = visible(
      formatItemLine(
        buildDispatchWorkItem({ ...baseRow, stage: 'in_review', auditResult: true, latestOutcome: 'audit-passed' }),
        160,
      ),
    );
    expect(passed).toContain(auditIcon(true));

    const failed = visible(
      formatItemLine(
        buildDispatchWorkItem({ ...baseRow, stage: 'in_review', auditResult: false, latestOutcome: 'audit-failed' }),
        160,
      ),
    );
    expect(failed).toContain(auditIcon(false));
  });

  it('shows the stage icon in the metadata Stage row', () => {
    const rows = buildMetaRows(buildDispatchWorkItem({ ...baseRow, stage: 'plan_complete' }));
    const stageRow = rows.find(([label]) => label === 'Stage');
    expect(stageRow?.[1]).toBe(`${stageIcon('plan_complete')} plan_complete`);
  });

  it('shows the audit verdict in the metadata Audit row for an audit outcome', () => {
    const rows = buildMetaRows(
      buildDispatchWorkItem({ ...baseRow, stage: 'in_review', auditResult: true, latestOutcome: 'audit-passed' }),
    );
    const auditRow = rows.find(([label]) => label === 'Audit');
    expect(auditRow?.[1]).toContain(auditIcon(true));
    expect(auditRow?.[1]).toContain('ready to close');
  });

  it('still shows — for the Audit row when the log carries no verdict', () => {
    const rows = buildMetaRows(buildDispatchWorkItem({ ...baseRow, stage: 'plan_complete' }));
    const auditRow = rows.find(([label]) => label === 'Audit');
    expect(auditRow?.[1]).toBe('—');
  });
});

// ── Surviving items are rendered from the LIVE work item ─────────────────────
// The first cut built a bespoke synthetic row for every dispatch, so the row
// icons diverged from every other view (status/review/priority). A surviving
// item is now rendered from the live `WorkItem` with only the dispatch
// provenance overlaid (WL-0MUGLL9SS002E1D2 audit fix).
describe('mergeDispatchRow — surviving items render exactly like live rows', () => {
  const live: WorkItem = {
    id: 'WL-DISP1',
    title: 'Live title',
    status: 'completed',
    stage: 'in_review',
    priority: 'high',
    risk: 'Medium',
    effort: 'Small',
    needsProducerReview: false,
    auditResult: true,
    auditedAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
  };

  it('keeps every live field so the icons match other views', () => {
    const merged = mergeDispatchRow(live, baseRow);
    expect(merged.title).toBe('Live title');
    expect(merged.status).toBe('completed');
    expect(merged.stage).toBe('in_review');
    expect(merged.priority).toBe('high');
    expect(merged.risk).toBe('Medium');
    expect(merged.effort).toBe('Small');
    expect(merged.needsProducerReview).toBe(false);
    expect(merged.auditResult).toBe(true);
  });

  it('overlays the dispatch provenance and marks the row log-derived but not log-only', () => {
    const merged = mergeDispatchRow(live, baseRow);
    expect(merged.isLogDerived).toBe(true);
    expect(merged.isLogOnly).toBeFalsy();
    expect(merged.dispatchKind).toBe('plan');
    expect(merged.dispatchOutcome).toBe('closed-as-plan-complete');
    expect(merged.dispatchedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('renders the identical live icon prefix, adding only the dispatch tag', () => {
    const merged = mergeDispatchRow(live, baseRow);
    const liveLine = visible(formatItemLine(live, 200));
    const mergedLine = visible(formatItemLine(merged, 200));
    const prefixOf = (line: string): string => line.slice(0, line.indexOf('WL-DISP1'));
    expect(prefixOf(mergedLine)).toBe(prefixOf(liveLine));
    expect(mergedLine).toContain('[plan]');
  });

  it('strips the live browse grouping so the view stays a flat newest-first list', () => {
    const grouped: WorkItem = { ...live, group: 2, groupLabel: 'In Review' };
    const merged = mergeDispatchRow(grouped, baseRow);
    expect(merged.group).toBeUndefined();
    expect(merged.groupLabel).toBeUndefined();
  });

  it('renders live metadata instead of — (only the provenance rows are added)', () => {
    const joined = visible(formatMetadataPanel(mergeDispatchRow(live, baseRow), 100, 30, 0).join('\n'));
    expect(joined).toMatch(/Priority\s+.*high/);
    expect(joined).toMatch(/Risk\s+.*Medium/);
    expect(joined).toMatch(/Effort\s+.*Small/);
    expect(joined).not.toMatch(/Priority\s+—/);
    expect(joined).toContain('Dispatch');
    expect(joined).toContain('closed-as-plan-complete');
  });
});
