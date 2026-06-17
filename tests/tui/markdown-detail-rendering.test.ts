import { describe, it, expect, vi } from 'vitest';
import { DetailComponent } from '../../src/tui/components/detail.js';

function createMockDetail() {
  let captured = '';
  const mockBox = {
    setContent: vi.fn((c: string) => { captured = c; }),
    on: vi.fn(),
    key: vi.fn(),
    focus: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
    removeAllListeners: vi.fn(),
    style: {},
  } as any;
  const blessed = { box: vi.fn(() => mockBox) } as any;
  const screen = { on: vi.fn() } as any;
  const comp = new DetailComponent({ parent: screen, blessed }).create();
  return { comp, getContent: () => captured };
}

describe('DetailComponent markdown rendering', () => {
  it('renders markdown headings and bullets in detail content', () => {
    const { comp, getContent } = createMockDetail();
    comp.setContent('## Description\n\n- first\n- second');
    const content = getContent();
    // Post-F2: output uses ANSI/chalk, not blessed-style tags
    expect(content).not.toContain('{white-fg}');
    expect(content).not.toContain('{bold}');
    expect(content).not.toContain('{/');
    expect(content).toContain('Description');
    expect(content).toContain('• first');
    expect(content).toContain('• second');
  });
});
