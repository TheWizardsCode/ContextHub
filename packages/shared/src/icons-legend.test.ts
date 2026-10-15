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
 * The legend API does not exist yet, so the bodies are committed with
 * `it.fails` — the suite stays GREEN while the assertions are RED (the repo's
 * documented TDD pattern). The implementation child flips each `it.fails` to
 * `it` on landing.
 *
 * Run through the test skill (`/skill:test`); do not invoke vitest directly.
 */
import { describe, it, expect } from 'vitest';
// The repo-wide guard forbids importing an `icons.js` path directly; import
// the package re-export instead.
import * as icons from '@worklog/shared/icons';

interface LegendEntry {
  category: string;
  glyph: string;
  meaning: string;
}

/**
 * Access the not-yet-implemented legend API without failing compilation. The
 * `it.fails` bodies below assert its post-implementation shape.
 */
const legendApi = icons as unknown as {
  ICON_LEGEND?: ReadonlyArray<LegendEntry>;
  iconLegendGlyphs?: () => string[];
};

/** Categories the legend must cover (parent AC5). */
const REQUIRED_CATEGORIES = [
  'status',
  'stage',
  'priority',
  'epic',
  'risk',
  'effort',
  'audit',
  'producer-review',
  'agent',
  'coverage',
];

describe('icon legend — coverage (WL-0MV85R1V6000IL4E)', () => {
  it.fails('covers every row glyph advertised by the icon source of truth', () => {
    const glyphs = legendApi.iconLegendGlyphs!();
    const legendGlyphs = new Set(legendApi.ICON_LEGEND!.map((e) => e.glyph));

    expect(glyphs.length).toBeGreaterThan(0);
    for (const glyph of glyphs) {
      expect(
        legendGlyphs.has(glyph),
        `legend is missing an entry for glyph ${JSON.stringify(glyph)}`,
      ).toBe(true);
    }
  });

  it.fails('does not invent glyphs the row renderer never emits', () => {
    const glyphs = new Set(legendApi.iconLegendGlyphs!());
    for (const entry of legendApi.ICON_LEGEND!) {
      expect(
        glyphs.has(entry.glyph),
        `legend entry ${JSON.stringify(entry.glyph)} is not a row glyph`,
      ).toBe(true);
    }
  });

  it.fails('covers every required icon category', () => {
    const categories = new Set(legendApi.ICON_LEGEND!.map((e) => e.category));
    for (const required of REQUIRED_CATEGORIES) {
      expect(categories.has(required), `missing legend category ${required}`).toBe(true);
    }
  });

  it.fails('pairs every glyph with a short, non-empty meaning', () => {
    for (const entry of legendApi.ICON_LEGEND!) {
      expect(entry.glyph.length).toBeGreaterThan(0);
      expect(entry.meaning.trim().length).toBeGreaterThan(0);
    }
  });
});
