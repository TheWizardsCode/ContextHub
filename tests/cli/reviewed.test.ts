/**
 * Contract tests for the `wl reviewed` command (restored flag).
 *
 * Test-first contract (item WL-0MVAMS4RO000H3B0, child F1): the
 * `needsProducerReview` flag and the `reviewed` command were removed
 * (WL-0MV85WFYU0071YQ9) and are being restored. These specs are authored
 * against the documented interface:
 *
 *   wl reviewed <id>               → toggles needsProducerReview
 *   wl reviewed <id> true|false    → sets needsProducerReview explicitly
 *
 * RED-pinned: they are wrapped in `it.fails(...)` so the gated suite stays
 * green while the contract is failing. The implementation child (F3, CLI/API
 * surface) flips `it.fails(` → `it(` when `src/commands/reviewed.ts` is
 * restored. The module is loaded dynamically so this file compiles/loads
 * before the module exists.
 */

import { describe, it, expect } from 'vitest';
import { createTestContext } from '../test-utils.js';

/** Resolve `registerReviewed` once the module exists (throws today). */
async function loadRegisterReviewed(): Promise<(ctx: any) => void> {
  const mod: any = await import('../../src/commands/reviewed.js');
  return mod.default;
}

describe('reviewed command', () => {
  it.fails('RED: toggles needsProducerReview when value omitted', async () => {
    const registerReviewed = await loadRegisterReviewed();
    const ctx = createTestContext();
    registerReviewed(ctx as any);
    const id = ctx.utils.createSampleItem();
    let item = ctx.utils.db.get(id);
    expect(Boolean(item.needsProducerReview)).toBe(false);
    await ctx.runCli(['reviewed', id]);
    item = ctx.utils.db.get(id);
    expect(Boolean(item.needsProducerReview)).toBe(true);
  });

  it.fails('RED: sets needsProducerReview when value provided', async () => {
    const registerReviewed = await loadRegisterReviewed();
    const ctx = createTestContext();
    registerReviewed(ctx as any);
    const id = ctx.utils.createSampleItem();
    await ctx.runCli(['reviewed', id, 'true']);
    let item = ctx.utils.db.get(id);
    expect(Boolean(item.needsProducerReview)).toBe(true);
    await ctx.runCli(['reviewed', id, 'false']);
    item = ctx.utils.db.get(id);
    expect(Boolean(item.needsProducerReview)).toBe(false);
  });
});
