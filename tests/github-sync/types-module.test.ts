/**
 * tests/github-sync/types-module.test.ts — the extracted declaration leaf stays
 * a leaf.
 *
 * The `src/github-sync/types.ts` module holds only erased `interface`
 * declarations (WL-0MW0JF5YE008LV1R), so importing it must add no runtime
 * surface. That property is what lets the flow modules depend on it without a
 * load-order edge. The rest of the split contract is covered by the guard suite
 * in `tests/github-sync/split-guard.test.ts`.
 */

import { describe, it, expect } from 'vitest';

describe('src/github-sync/types.ts', () => {
  it('exposes no runtime exports (declarations only)', async () => {
    const mod = await import('../../src/github-sync/types.js');
    expect(Object.keys(mod)).toEqual([]);
  });
});
