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
  it('displays audit information when present', () => {
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
    expect(content).toContain('Audit:');
    expect(content).toContain('Yes');
    expect(content).toContain('All checks passed');
    // Check for short date format (DD/MM HH:MM)
    // 2026-06-04T22:00:00Z -> 04/06 followed by some time
    // formatShortDateTime uses local time, so we just check for the date part or the general pattern
    expect(content).toMatch(/\d{2}\/\d{2}/);
  });

  it('displays "No" for readyToClose: false', () => {
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
    expect(content).toContain('No');
    expect(content).toContain('One test failed');
  });

  it('handles missing summary gracefully', () => {
    const { comp, getContent } = createMockMetadataPane();
    const auditResult = {
      readyToClose: true,
      auditedAt: '2026-06-04T22:00:00Z',
      summary: null,
    };

    comp.updateFromItem({
      id: 'WL-123',
      status: 'open',
      auditResult,
    }, 0);

    const content = getContent();
    expect(content).toContain('(no summary)');
  });

  it('omits audit section if no auditResult is provided', () => {
    const { comp, getContent } = createMockMetadataPane();
    comp.updateFromItem({
      id: 'WL-123',
      status: 'open',
    }, 0);

    const content = getContent();
    expect(content).not.toContain('Audit:');
  });
});
