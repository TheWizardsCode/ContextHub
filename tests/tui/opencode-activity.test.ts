import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpencodeClient } from '../../src/tui/opencode-client.js';

describe('OpencodeClient activity indicators', () => {
  const makeClient = () => new OpencodeClient({
    port: 1234,
    log: () => {},
    showToast: () => {},
    modalDialogs: { selectList: async () => null, editTextarea: async () => null, confirmTextbox: async () => true },
    render: () => {},
    persistedState: { load: async () => ({}), save: async () => {}, getPrefix: () => undefined },
    httpImpl: {} as any,
    spawnImpl: () => { throw new Error('not used'); },
  } as any);

  let client: OpencodeClient;

  beforeEach(() => {
    client = makeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates pane label for streaming text', () => {
    const paneContent: { value: string } = { value: '' };
    const pane = {
      getContent: () => paneContent.value,
      setContent: (s: string) => { paneContent.value = s; },
      setLabel: vi.fn(),
      setScrollPerc: vi.fn(),
    } as any;

    const tools = (client as any).createSessionTools('s1', pane, null, null, () => {});
    tools.handlers.onTextDelta('hello');

    expect((pane.setLabel as any).mock.calls.length).toBeGreaterThan(0);
    const label = (pane.setLabel as any).mock.calls.slice(-1)[0][0] as string;
    expect(label).toContain('Writing response');
  });

  it('shows inline file op message and activity for write tool', () => {
    const paneContent: { value: string } = { value: '' };
    const pane = {
      getContent: () => paneContent.value,
      setContent: (s: string) => { paneContent.value = s; },
      setLabel: vi.fn(),
      setScrollPerc: vi.fn(),
    } as any;

    const tools = (client as any).createSessionTools('s2', pane, null, null, () => {});
    tools.handlers.onToolUse('write', 'src/test.ts');

    expect((pane.setLabel as any).mock.calls.length).toBeGreaterThan(0);
    const label = (pane.setLabel as any).mock.calls.slice(-1)[0][0] as string;
    expect(label).toContain('Using tool: write');
    expect(paneContent.value).toContain('Write: src/test.ts');
  });

  it('sets processing result activity and clears after delay', async () => {
    vi.useFakeTimers();
    const paneContent: { value: string } = { value: '' };
    const pane = {
      getContent: () => paneContent.value,
      setContent: (s: string) => { paneContent.value = s; },
      setLabel: vi.fn(),
      setScrollPerc: vi.fn(),
    } as any;

    const tools = (client as any).createSessionTools('s3', pane, null, null, () => {});
    tools.handlers.onToolResult('ok\nline2');

    // immediate label set
    expect((pane.setLabel as any).mock.calls.length).toBeGreaterThan(0);
    const label = (pane.setLabel as any).mock.calls.slice(-1)[0][0] as string;
    expect(label).toContain('Processing result');

    // advance timers to trigger clear timeout (600ms in implementation)
    vi.advanceTimersByTime(700);

    // after timeout the code attempts to set label to neutral — ensure it's been called again
    const calls = (pane.setLabel as any).mock.calls;
    const lastLabel = calls[calls.length - 1][0] as string;
    expect(lastLabel).toContain('opencode');
  });
});
