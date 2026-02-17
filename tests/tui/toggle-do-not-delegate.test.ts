import { describe, it, expect } from 'vitest';
import { TuiController } from '../../src/tui/controller.js';
import { createTuiTestContext } from '../test-utils.js';

describe('TUI D key toggle do-not-delegate', () => {
  it('shows toast and toggles tag', async () => {
    const ctx = createTuiTestContext();
    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    // start with one item
    const id = ctx.utils.createSampleItem({ tags: [] });
    await controller.start({});
    // simulate keypress 'D'
    ctx.screen.emit('keypress', 'D', { name: 'D' });
    // Expect toast shown and tag added
    expect(ctx.toast.lastMessage()).toMatch(/Do-not-delegate: ON/);
    const item = ctx.utils.db.get(id);
    expect(item.tags).toContain('do-not-delegate');
  });
});

describe('TUI r key toggle needs review', () => {
  it('shows toast and toggles needsProducerReview', async () => {
    const ctx = createTuiTestContext();
    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    const id = ctx.utils.createSampleItem({ tags: [] });
    await controller.start({});
    ctx.screen.emit('keypress', 'r', { name: 'r' });
    expect(ctx.toast.lastMessage()).toMatch(/Needs review: ON/);
    const item = ctx.utils.db.get(id);
    expect(Boolean(item.needsProducerReview)).toBe(true);
  });
});
