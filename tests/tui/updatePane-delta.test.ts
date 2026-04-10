import { test, expect } from 'vitest';
import { OpencodeClient } from '../../src/tui/opencode-client.js';

test('updatePane sends only the new delta to pushLine when pane supports pushLine', () => {
  const options: any = {
    port: 0,
    log: () => {},
    showToast: () => {},
    modalDialogs: {},
    render: () => {},
    persistedState: { load: async () => null, save: async () => undefined, getPrefix: () => undefined },
  };

  const client = new OpencodeClient(options);

  const pushes: string[] = [];
  const pane: any = {
    getContent: () => '',
    pushLine: (s: string) => { pushes.push(s); },
    setContent: () => {},
    setLabel: () => {},
    setScrollPerc: () => {},
    focus: () => {},
  };

  const tools = (client as any).createSessionTools('sess-delta', pane, null, null, () => {});
  expect(tools).toBeTruthy();
  const { appendLine, appendText, updatePane } = tools;

  // Append first piece and update pane -> should receive the full first piece
  appendLine('first line');
  updatePane();
  expect(pushes.length).toBe(1);
  expect(pushes[0]).toBe('first line\n');

  // Append second piece and update pane -> should receive only the second piece
  appendLine('second line');
  updatePane();
  expect(pushes.length).toBe(2);
  expect(pushes[1]).toBe('second line\n');
  // Ensure the second push does not repeat the first
  expect(pushes[1]).not.toContain('first line');
});
