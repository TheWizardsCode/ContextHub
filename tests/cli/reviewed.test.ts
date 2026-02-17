import { describe, it, expect } from 'vitest';
import registerReviewed from '../../src/commands/reviewed.js';
import { createTestContext } from '../test-utils.js';

describe('reviewed command', () => {
  it('toggles needsProducerReview when value omitted', async () => {
    const ctx = createTestContext();
    registerReviewed(ctx as any);
    const id = ctx.utils.createSampleItem();
    let item = ctx.utils.db.get(id);
    expect(Boolean(item.needsProducerReview)).toBe(false);
    await ctx.runCli(['reviewed', id]);
    item = ctx.utils.db.get(id);
    expect(Boolean(item.needsProducerReview)).toBe(true);
  });

  it('sets needsProducerReview when value provided', async () => {
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
