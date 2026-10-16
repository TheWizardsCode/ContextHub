/**
 * packages/herdr/src/worklist-icon-truncation.test.ts — Line-truncation
 * safety for supplementary-plane (emoji) glyphs (WL-0MU3U1AMP0044WUX).
 *
 * Regression for the intermittent "error (?)" icon bug in the Herdr
 * selection list: rows whose line width exceeded the pane (triggering the
 * truncation paths in formatItemLine / truncateLine) appended only the LOW
 * surrogate of a supplementary-plane emoji (🔓 U+1F513, 📋 U+1F4CB,
 * 🔍 U+1F50D, …). Writing that unpaired surrogate to stdout encodes it as
 * the U+FFFD REPLACEMENT CHARACTER (EF BF BD), which terminals render as a
 * white-diamond/question-mark "error" glyph.
 *
 * The contract asserted here: every formatter that truncates text must emit
 * well-formed UTF-16 — no lone surrogates, therefore no U+FFFD after UTF-8
 * encoding — no matter where the truncation point lands.
 *
 * Run: npx vitest run packages/herdr/src/worklist-icon-truncation.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  formatItemLine,
  formatMetadataPanel,
  formatDetailContent,
} from './worklist.js';
import type { WorkItem } from './fetcher.js';

// ── UTF-16 well-formedness helpers ────────────────────────────────────

/**
 * True when `s` contains an unpaired UTF-16 surrogate (either a high
 * surrogate not followed by a low surrogate, or a bare low surrogate).
 */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= s.length) return true;
      const n = s.charCodeAt(i + 1);
      if (n < 0xdc00 || n > 0xdfff) return true;
      i += 1; // consume the low surrogate of a valid pair
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // bare low surrogate
    }
  }
  return false;
}

/**
 * True when a lone surrogate in `s` would become the U+FFFD replacement
 * character after UTF-8 round-tripping (the user-visible "?"/diamond).
 */
function utf8RoundTripMangles(s: string): boolean {
  return Buffer.from(s, 'utf8').toString('utf8') !== s;
}

// ── Fixtures ──────────────────────────────────────────────────────────

const LONG_TITLE =
  'Interview replay feature with a deliberately long title so the line must truncate';

/** Shape of the reported item (risk/effort shown in the metadata panel). */
function makeItem(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WL-0MU55UDBJ008DJ67',
    title: LONG_TITLE,
    status: 'open',
    stage: 'plan_complete',
    priority: 'critical',
    issueType: 'feature',
    risk: 'low',
    effort: 'small',
    description: 'Some description text for the metadata panel rendering path.',
    ...over,
  };
}

/** Widths that force truncation of long rows (observed in the affected pane). */
const NARROW_WIDTHS = [30, 36, 40, 46, 52, 60];
/** Wide width where the long title still exceeds the limit. */
const WIDE = 120;

// ── formatItemLine ────────────────────────────────────────────────────

describe('formatItemLine — truncation must never mangle emoji (WL-0MU3U1AMP0044WUX)', () => {
  it('reproduces the reported row: supplementary icons survive at every truncating width', () => {
    const item = makeItem(); // status open 🔓 + stage plan_complete 📋
    for (const cols of [...NARROW_WIDTHS, WIDE]) {
      const line = formatItemLine(item, cols);
      expect(hasLoneSurrogate(line), `cols=${cols}`).toBe(false);
      expect(utf8RoundTripMangles(line), `cols=${cols} must not produce U+FFFD`).toBe(false);
      expect(line).not.toContain('\uFFFD');
      // The supplementary-plane icons must still be present (intact 🔓 and 📋).
      expect(line, `cols=${cols} keeps the open icon`).toContain('\u{1F513}');
      expect(line, `cols=${cols} keeps the plan_complete icon`).toContain('\u{1F4CB}');
    }
  });

  it('covers every supplementary-plane status/stage icon pair', () => {
    const supplementary = [
      { status: 'open', stage: 'idea' },            // 🔓 💡
      { status: 'open', stage: 'intake_complete' }, // 🔓 📥
      { status: 'in-progress', stage: 'plan_complete' }, // 🔄 📋
      { status: 'open', stage: 'in_progress' },     // 🔓 🛠️ (legacy data)
      { status: 'open', stage: 'in_review' },       // 🔓 🔍 (stage fallback)
      { status: 'completed', stage: 'in_review' },  // ✔️ 🔍
    ] as const;
    for (const over of supplementary) {
      const item = makeItem({ status: over.status, stage: over.stage });
      for (const cols of [...NARROW_WIDTHS, WIDE]) {
        const line = formatItemLine(item, cols);
        expect(hasLoneSurrogate(line), `${over.status}/${over.stage} cols=${cols}`).toBe(false);
        expect(utf8RoundTripMangles(line), `${over.status}/${over.stage} cols=${cols}`).toBe(false);
        expect(line).not.toContain('\uFFFD');
      }
    }
  });

  it('still renders BMP-only icon rows unchanged (no regression)', () => {
    const item = makeItem({
      status: 'completed',
      stage: 'in_review',
      auditResult: true,
      auditedAt: '2026-09-17T10:00:30.000Z',
      updatedAt: '2026-09-17T10:00:00.000Z',
      needsProducerReview: false,
    });
    for (const cols of [...NARROW_WIDTHS, WIDE]) {
      const line = formatItemLine(item, cols);
      expect(line).toContain('\u{2714}\u{FE0F}'); // ✔️ status
      expect(line).toContain('\u{2705}');         // ✅ fresh audit
      expect(line).not.toContain('\uFFFD');
      expect(hasLoneSurrogate(line)).toBe(false);
    }
  });

  it('keeps the whole line valid after ANSI-coloured truncation', () => {
    const item = makeItem({ priority: 'medium', title: `Very ${LONG_TITLE}` });
    const line = formatItemLine(item, 40);
    // Coloured segments may be cut mid-way — the result must still be clean UTF-16.
    expect(hasLoneSurrogate(line)).toBe(false);
    expect(utf8RoundTripMangles(line)).toBe(false);
    expect(line).toContain('…');
  });
});

// ── Metadata panel / detail view (truncateLine path) ──────────────────

describe('truncateLine consumers — metadata panel and detail view (WL-0MU3U1AMP0044WUX)', () => {
  it('formatMetadataPanel never emits lone surrogates when truncated', () => {
    const item = makeItem(); // Status+Stage row: 🔓 open / 📋 plan_complete
    for (const cols of [30, 40, 50, 60, 80]) {
      const lines = formatMetadataPanel(item, cols, 6);
      const text = lines.join('\n');
      expect(hasLoneSurrogate(text), `cols=${cols}`).toBe(false);
      expect(utf8RoundTripMangles(text), `cols=${cols}`).toBe(false);
      expect(text).not.toContain('\uFFFD');
    }
  });

  it('formatDetailContent never emits lone surrogates when truncated', () => {
    const item = makeItem({ description: LONG_TITLE.repeat(2) });
    for (const cols of [30, 40, 50, 60, 80]) {
      const lines = formatDetailContent(item, cols);
      const text = lines.join('\n');
      expect(hasLoneSurrogate(text), `cols=${cols}`).toBe(false);
      expect(utf8RoundTripMangles(text), `cols=${cols}`).toBe(false);
      expect(text).not.toContain('\uFFFD');
    }
  });
});