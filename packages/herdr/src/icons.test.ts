/**
 * packages/herdr/src/icons.test.ts — Icon tests for the agent-status icon
 * and the fixed-width agent slot in the icon prefix (WL-0MSBQUJQX005RAT9).
 *
 * Alignment invariance (AC3): the agent icon occupies a fixed-width reserved
 * slot at the start of the icon prefix, so rows with and without an agent
 * keep the status/stage/review icons and the item-ID column at identical
 * columns.
 *
 * Run: npx vitest run packages/herdr/src/icons.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  agentStatusIcon,
  getIconPrefix,
  iconsEnabled,
  isAuditFresh,
  stageDisplayIcon,
  stringDisplayWidth,
} from '@worklog/shared/icons';
import { formatItemLine } from './worklist.js';
import type { WorkItem } from './fetcher.js';

describe('iconsEnabled — noIcons flag (WL-0MSBV4RYO008JL70)', () => {
  it('returns true by default', () => {
    expect(iconsEnabled()).toBe(true);
  });

  it('returns false when noIcons is true', () => {
    expect(iconsEnabled({ noIcons: true })).toBe(false);
  });

  it('returns true when noIcons is false', () => {
    expect(iconsEnabled({ noIcons: false })).toBe(true);
  });
});

describe('agentStatusIcon', () => {
  it('maps working → 🟢 (green circle)', () => {
    expect(agentStatusIcon('working')).toBe('\u{1F7E2}');
  });

  it('maps blocked → ⛔ (no-entry sign)', () => {
    expect(agentStatusIcon('blocked')).toBe('\u{26D4}');
  });

  it('maps idle → ⚪ (white circle)', () => {
    expect(agentStatusIcon('idle')).toBe('\u{26AA}');
  });

  it('renders no icon for done, unknown, or missing states', () => {
    expect(agentStatusIcon('done')).toBe('');
    expect(agentStatusIcon('unknown')).toBe('');
    expect(agentStatusIcon(undefined)).toBe('');
    expect(agentStatusIcon('')).toBe('');
  });

  it('is case-insensitive', () => {
    expect(agentStatusIcon('WORKING')).toBe('\u{1F7E2}');
    expect(agentStatusIcon('Blocked')).toBe('\u{26D4}');
  });

  it('uses [TEXT] fallbacks when noIcons is set', () => {
    expect(agentStatusIcon('working', { noIcons: true })).toBe('[WORK]');
    expect(agentStatusIcon('blocked', { noIcons: true })).toBe('[BLKD]');
    expect(agentStatusIcon('idle', { noIcons: true })).toBe('[IDLE]');
    expect(agentStatusIcon('done', { noIcons: true })).toBe('');
  });
});

describe('stageDisplayIcon — audit-aware stage icon shared by list and metadata (WL-0MSGIXHHI009KFW9)', () => {
  const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    stage: 'in_review',
    auditResult: null,
    auditedAt: null,
    updatedAt: '2026-08-02T10:00:00.000Z',
    ...over,
  });

  it('shows the audit-result icon for a fresh audit (✅/❌/❓)', () => {
    expect(stageDisplayIcon(item({ auditResult: true, auditedAt: '2026-08-02T10:00:30.000Z' }))).toBe('\u{2705}');
    expect(stageDisplayIcon(item({ auditResult: false, auditedAt: '2026-08-02T10:00:30.000Z' }))).toBe('\u{274C}');
    expect(stageDisplayIcon(item({ auditedAt: '2026-08-02T10:00:30.000Z' }))).toBe('\u{2753}');
  });

  it('shows the stale-passed hourglass when the audit is stale but passed', () => {
    expect(stageDisplayIcon(item({ auditResult: true, auditedAt: '2026-08-01T10:00:00.000Z' }))).toBe('\u{23F3}');
  });

  it('falls back to the plain stage icon otherwise (stale/no audit, non-in_review stages)', () => {
    expect(stageDisplayIcon(item())).toBe('\u{1F50D}'); // 🔍 no audit
    expect(stageDisplayIcon(item({ stage: 'idea' }))).toBe('\u{1F4A1}'); // 💡
    expect(stageDisplayIcon({ stage: 'in_progress' })).toBe('\u{1F6E0}\u{FE0F}'); // 🛠️
  });

  it('honours the noIcons flag like the other icon helpers', () => {
    expect(stageDisplayIcon(item({ stage: 'idea' }), { noIcons: true })).toBe('[IDEA]');
    expect(stageDisplayIcon(item({ auditResult: true, auditedAt: '2026-08-02T10:00:30.000Z' }), { noIcons: true })).toBe('[ready]');
  });
});

describe('getIconPrefix — fixed-width agent slot (AC3 alignment invariance)', () => {
  const base = { status: 'open', stage: 'idea' } as const;
  const withAgent = { status: 'open', stage: 'idea', agentState: 'working' } as const;
  const withBlockedAgent = { status: 'open', stage: 'idea', agentState: 'blocked' } as const;

  it('keeps the total prefix at the fixed width with and without an agent', () => {
    expect(stringDisplayWidth(getIconPrefix(base))).toBe(12);
    expect(stringDisplayWidth(getIconPrefix(withAgent))).toBe(12);
  });

  it('keeps the remaining icons at identical columns (no column shift)', () => {
    const noAgent = getIconPrefix(base);
    const yesAgent = getIconPrefix(withAgent);
    // Both prefixes are the same display width; the status icon (display
    // column 3-4) must start at the same display column in both.
    expect(stringDisplayWidth(noAgent)).toBe(stringDisplayWidth(yesAgent));
    // Display column where the status icon (🔓) begins:
    const statusCol = (s: string): number => stringDisplayWidth(s.slice(0, s.indexOf('\u{1F513}')));
    expect(statusCol(noAgent)).toBe(statusCol(yesAgent));
  });

  it('places the agent icon in the reserved leading slot', () => {
    const prefix = getIconPrefix(withAgent);
    // The green circle is the first 2-cell glyph.
    expect(prefix.startsWith('\u{1F7E2}')).toBe(true);
    // Rows without an agent reserve the slot with two spaces.
    expect(getIconPrefix(base).startsWith('  ')).toBe(true);
  });

  it('renders different agent states without shifting the status icon', () => {
    const working = getIconPrefix(withAgent);
    const blocked = getIconPrefix(withBlockedAgent);
    // Slot is fixed-width: both have the same display width, and the status
    // icon (🔓) appears at the same DISPLAY column (cells 3-4) in both.
    expect(stringDisplayWidth(working)).toBe(stringDisplayWidth(blocked));
    const statusCol = (s: string): number => stringDisplayWidth(s.slice(0, s.indexOf('\u{1F513}'))); // 🔓
    expect(statusCol(working)).toBe(statusCol(blocked));
  });

  it('keeps the item-ID column identical in full row rendering', () => {
    const makeItem = (agentState?: string): WorkItem => ({
      id: 'WL-0MSBQUJQX005RAT9',
      title: 'Some task',
      status: 'open',
      stage: 'idea',
      agentState: agentState as WorkItem['agentState'],
    });
    const withRow = formatItemLine(makeItem('working'), 120);
    const withoutRow = formatItemLine(makeItem(undefined), 120);
    // Compare DISPLAY columns (emoji are surrogate pairs, so JS indexOf
    // code-unit positions differ even though terminal columns do not).
    const idCol = (line: string): number =>
      stringDisplayWidth(line.slice(0, line.indexOf('WL-0MSBQUJQX005RAT9')));
    expect(idCol(withRow)).toBe(idCol(withoutRow));
    // And both place the ID at the same display column a row with a blocked
    // agent does.
    const blockedRow = formatItemLine(makeItem('blocked'), 120);
    expect(idCol(withRow)).toBe(idCol(blockedRow));
  });
});

describe('isAuditFresh — flag-only updates must not make a valid audit stale (WL-0MSN6ZCTN0027U2R)', () => {
  // The worklog core guarantees (packages/shared/src/database.ts update())
  // that flipping needsProducerReview does NOT bump updatedAt; only content
  // changes do.  These tests pin the herdr-side consequence: a previously
  // fresh audit stays fresh and the passed icon is shown (not the stale
  // hourglass).  herdr itself is unchanged.
  it('stays fresh when updatedAt does not move after the flag flip', () => {
    const auditedAt = '2026-08-02T10:00:30.000Z';
    const updatedAtAfterFlagFlip = '2026-08-02T10:00:00.000Z'; // unchanged by the flip
    expect(isAuditFresh(auditedAt, updatedAtAfterFlagFlip)).toBe(true);
  });

  it('shows the passed icon (not the stale hourglass) after a flag-only flip', () => {
    // Audit at 10:00:30, item updated at 10:00:00 — with the worklog
    // guarantee the updatedAt is unchanged by a flag flip, so the audit
    // remains within the 60 s buffer and the passed icon is shown.
    expect(
      stageDisplayIcon({
        stage: 'in_review',
        auditResult: true,
        auditedAt: '2026-08-02T10:00:30.000Z',
        updatedAt: '2026-08-02T10:00:00.000Z',
      }),
    ).toBe('\u{2705}'); // ✅ — not ⏳ (stale hourglass)
  });

  it('still reports stale when updatedAt genuinely moves (content change)', () => {
    const auditedAt = '2026-08-02T10:00:30.000Z';
    const updatedAtAfterContentChange = '2026-08-02T10:05:00.000Z'; // content edit bumps
    expect(isAuditFresh(auditedAt, updatedAtAfterContentChange)).toBe(false);
  });
});

describe('isAuditFresh — atomic audit persistence (WL-0MT8KTE3E001Q1D9)', () => {
  it('stays fresh when a comment bumps updatedAt within 60 s of the audit', () => {
    const auditedAt = '2026-08-02T10:00:30.000Z';
    const updatedAtAfterComment = '2026-08-02T10:00:40.000Z';
    expect(isAuditFresh(auditedAt, updatedAtAfterComment)).toBe(true);
  });

  it('stays fresh when updatedAt equals auditedAt (immediately after audit)', () => {
    const auditedAt = '2026-08-02T10:00:30.000Z';
    const updatedAt = auditedAt;
    expect(isAuditFresh(auditedAt, updatedAt)).toBe(true);
  });

  it('becomes stale when comment bumps updatedAt beyond 60 s', () => {
    const auditedAt = '2026-08-02T10:00:30.000Z';
    const updatedAtAfterComment = '2026-08-02T10:01:35.000Z';
    expect(isAuditFresh(auditedAt, updatedAtAfterComment)).toBe(false);
  });
});
