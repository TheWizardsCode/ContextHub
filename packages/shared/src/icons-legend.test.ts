/**
 * packages/shared/src/icons-legend.test.ts — Icon legend coverage + drift
 * guard (parent WL-0MTV97GV20088CS7 AC5; test-first child WL-0MV85R1V6000IL4E;
 * implementation child WL-0MV85R2G6000G7BU).
 *
 * The `?` help overlay must explain every glyph rendered in a work-item row.
 * The legend is authored in the single source of truth (`icons.ts`) and these
 * tests pin its completeness so a new row glyph cannot be added without a
 * matching legend entry (drift guard).
 *
 * The implementation child WL-0MV85R2G6000G7BU landed the legend, so the
 * bodies below assert the implemented behaviour with a plain `it` (the
 * red-witness `it.fails` form was flipped on landing).
 *
 * Run through the test skill (`/skill:test`); do not invoke vitest directly.
 */
import { describe, it, expect } from 'vitest';
// The repo-wide guard forbids importing an `icons.js` path directly; import
// the package re-export instead.
import { ICON_LEGEND, iconLegendGlyphs, type IconLegendEntry } from '@worklog/shared/icons';

/** Categories the legend must cover (parent AC5). */
const REQUIRED_CATEGORIES = [
  'status',
  'stage',
  'priority',
  'epic',
  'risk',
  'effort',
  'audit',
  'agent',
  'coverage',
];

describe('icon legend — coverage (WL-0MV85R1V6000IL4E)', () => {
  it('covers every row glyph advertised by the icon source of truth', () => {
    const glyphs = iconLegendGlyphs();
    const legendGlyphs = new Set(ICON_LEGEND.map((e) => e.glyph));

    expect(glyphs.length).toBeGreaterThan(0);
    for (const glyph of glyphs) {
      expect(
        legendGlyphs.has(glyph),
        `legend is missing an entry for glyph ${JSON.stringify(glyph)}`,
      ).toBe(true);
    }
  });

  it('does not invent glyphs the row renderer never emits', () => {
    const glyphs = new Set(iconLegendGlyphs());
    for (const entry of ICON_LEGEND) {
      expect(
        glyphs.has(entry.glyph),
        `legend entry ${JSON.stringify(entry.glyph)} is not a row glyph`,
      ).toBe(true);
    }
  });

  it('covers every required icon category', () => {
    const categories = new Set(ICON_LEGEND.map((e) => e.category));
    for (const required of REQUIRED_CATEGORIES) {
      expect(categories.has(required), `missing legend category ${required}`).toBe(true);
    }
  });

  // RED-pinned contract (WL-0MVAMS4RO000H3B0 F1): the `producer-review`
  // category and its legend rows (❌ / ✅) were removed with
  // `needsProducerReview` (WL-0MV85WFYU0071YQ9); F4 restores the shared
  // icons legend entries and flips `it.fails(` → `it(`. (The ❌/✅ glyphs
  // already exist under `audit`, so only the dedicated category is red.)
  it.fails('RED (F4 flips it.fails→it): legend covers the producer-review category', () => {
    const categories = new Set(ICON_LEGEND.map((e) => e.category));
    expect(categories.has('producer-review')).toBe(true);
  });

  it('pairs every glyph with a short, non-empty meaning', () => {
    for (const entry of ICON_LEGEND) {
      expect(entry.glyph.length).toBeGreaterThan(0);
      expect(entry.meaning.trim().length).toBeGreaterThan(0);
    }
  });
});
