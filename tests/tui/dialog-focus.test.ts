import { describe, test, expect, vi } from 'vitest';
import createFocusHelpers from '../../src/tui/dialog-focus.js';

describe('dialog focus helpers', () => {
  test('applyFocusStyles sets styles on fields', () => {
    const makeField = () => ({ style: { selected: {}, border: {} } });
    const f1: any = makeField();
    const f2: any = makeField();
    const fields = [f1, f2];
    const mgr = {
      cycle: (_: number) => {},
      getIndex: () => 0,
      focusIndex: (_: number) => {},
    } as any;
    const helpers = createFocusHelpers(fields, mgr);
    helpers.applyFocusStyles(f2);
    expect(f1.style.selected.bg).toBe('blue');
    expect(f2.style.selected.bg).toBe('cyan');
  });

  test('wireFieldNavigation attaches tab handlers for non-textareas', () => {
    const field = { key: vi.fn(), on: vi.fn(), style: { selected: {} } } as any;
    const fields = [field];
    const mgr = { cycle: vi.fn(), getIndex: () => 0 } as any;
    const screen = { focused: null } as any;
    const helpers = createFocusHelpers(fields, mgr);
    helpers.wireFieldNavigation(screen, () => false, () => false);
    expect(field.key).toHaveBeenCalled();
  });
});
