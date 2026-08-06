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
  stringDisplayWidth,
} from './icons.js';
import { formatItemLine } from './worklist.js';
import type { WorkItem } from './fetcher.js';

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
