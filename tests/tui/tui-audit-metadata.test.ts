import { describe, it, expect, vi } from 'vitest';
import { MetadataPaneComponent } from '../../src/tui/components/metadata-pane.js';

function createMockMetadataPane() {
  let capturedContent = '';
  const mockBox = {
    setContent: vi.fn((c: string) => { capturedContent = c; }),
    on: vi.fn(),
    key: vi.fn(),
    focus: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
    removeAllListeners: vi.fn(),
    style: {},
  };
  const mockBlessed = { box: vi.fn(() => mockBox) };
  const mockScreen = { on: vi.fn() };
  const comp = new MetadataPaneComponent({ parent: mockScreen as any, blessed: mockBlessed as any }).create();
  return { comp, getContent: () => capturedContent };
}

describe('MetadataPaneComponent audit display', () => {
  it('displays "Audit Passed:" and Yes when readyToClose is true', () => {
    const { comp, getContent } = createMockMetadataPane();
    const auditResult = {
      readyToClose: true,
      auditedAt: '2026-06-04T22:00:00Z',
      summary: 'All checks passed',
    };

    comp.updateFromItem({
      id: 'WL-123',
      status: 'open',
      auditResult,
    }, 0);

    const content = getContent();
    expect(content).toContain('Audit Passed:');
    expect(content).toContain('Yes');
    expect(content).not.toContain('All checks passed'); // summary should not appear
  });

  it('displays "Audit Passed:" and No when readyToClose is false', () => {
    const { comp, getContent } = createMockMetadataPane();
    const auditResult = {
      readyToClose: false,
      auditedAt: '2026-06-04T22:00:00Z',
      summary: 'One test failed',
    };

    comp.updateFromItem({
      id: 'WL-123',
      status: 'open',
      auditResult,
    }, 0);

    const content = getContent();
    expect(content).toContain('Audit Passed:');
    expect(content).toContain('No');
    expect(content).not.toContain('One test failed');
  });

  it('shows "Audit Passed: Unknown" in orange when auditResult.readyToClose is missing', () => {
    const { comp, getContent } = createMockMetadataPane();
    const auditResult = {
      readyToClose: undefined as unknown as boolean,
      auditedAt: '2026-06-04T22:00:00Z',
      summary: null,
    };

    comp.updateFromItem({
      id: 'WL-123',
      status: 'open',
      auditResult,
    }, 0);

    const content = getContent();
    expect(content).toContain('Audit Passed:');
    expect(content).toContain('Unknown');
    expect(content).toContain('{orange-fg}Unknown{/orange-fg}');
  });

  it('shows "Audit Passed: Unknown" in orange if no auditResult is provided', () => {
    const { comp, getContent } = createMockMetadataPane();
    comp.updateFromItem({
      id: 'WL-123',
      status: 'open',
    }, 0);

    const content = getContent();
    expect(content).toContain('Audit Passed:');
    expect(content).toContain('Unknown');
    expect(content).toContain('{orange-fg}Unknown{/orange-fg}');
  });
});
