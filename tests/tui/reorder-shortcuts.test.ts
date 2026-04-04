import { describe, expect, it } from 'vitest';
import { TuiController } from '../../src/tui/controller.js';
import { createTuiTestContext } from '../test-utils.js';

describe('TUI Shift+Arrow reorder shortcuts', () => {
  const setup = async () => {
    const ctx = createTuiTestContext();
    const db = ctx.utils.getDatabase();
    const firstId = ctx.utils.createSampleItem({ tags: [] });
    const secondId = ctx.utils.createSampleItem({ tags: [] });

    db.update(firstId, {
      title: 'First',
      sortIndex: 100,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    });
    db.update(secondId, {
      title: 'Second',
      sortIndex: 200,
      createdAt: '2020-01-02T00:00:00.000Z',
      updatedAt: '2020-01-02T00:00:00.000Z',
    });

    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    await controller.start({});

    return { ctx, firstId, secondId };
  };

  it('moves selected item down then up using Shift+Down and Shift+Up', async () => {
    const { ctx, firstId, secondId } = await setup();
    const db = ctx.utils.getDatabase();

    // Shift+Down (reported as shift modifier on plain down key)
    ctx.screen.emit('keypress', '', { name: 'down', shift: true });
    expect(db.get(firstId).sortIndex).toBe(200);
    expect(db.get(secondId).sortIndex).toBe(100);

    // Shift+Up (reported as S-up key name)
    ctx.screen.emit('keypress', '', { name: 'S-up' });
    expect(db.get(firstId).sortIndex).toBe(100);
    expect(db.get(secondId).sortIndex).toBe(200);
  });

  it('does not move beyond list boundaries', async () => {
    const { ctx, firstId, secondId } = await setup();
    const db = ctx.utils.getDatabase();

    // At top boundary, Shift+Up is a no-op
    ctx.screen.emit('keypress', '', { name: 'up', shift: true });
    expect(db.get(firstId).sortIndex).toBe(100);
    expect(db.get(secondId).sortIndex).toBe(200);

    // Move once to place selected item at bottom
    ctx.screen.emit('keypress', '', { name: 'down', shift: true });
    expect(db.get(firstId).sortIndex).toBe(200);
    expect(db.get(secondId).sortIndex).toBe(100);

    // At bottom boundary, Shift+Down is a no-op
    ctx.screen.emit('keypress', '', { name: 'down', shift: true });
    expect(db.get(firstId).sortIndex).toBe(200);
    expect(db.get(secondId).sortIndex).toBe(100);
  });
});
