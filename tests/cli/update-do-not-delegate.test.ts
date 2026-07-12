import { describe, it, expect } from 'vitest';
import registerUpdate from '../../src/commands/update.js';
import { createTestContext } from '../test-utils.js';

describe('update --do-not-delegate', () => {
  it('adds the tag when true', async () => {
    const ctx = createTestContext();
    registerUpdate(ctx as any);
    // create item
    const id = ctx.utils.createSampleItem({ tags: [] });
    await ctx.runCli(['update', id, '--do-not-delegate', 'true']);
    const item = ctx.utils.db.get(id);
    expect(item.tags).toContain('do-not-delegate');
  });

  it('removes the tag when false', async () => {
    const ctx = createTestContext();
    registerUpdate(ctx as any);
    const id = ctx.utils.createSampleItem({ tags: ['do-not-delegate'] });
    await ctx.runCli(['update', id, '--do-not-delegate', 'false']);
    const item = ctx.utils.db.get(id);
    expect(item.tags).not.toContain('do-not-delegate');
  });
});
