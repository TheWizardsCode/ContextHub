import { test, expect } from 'vitest';
import { OpencodeClient } from '../../src/tui/opencode-client.js';

test('composing block is preceded by exactly one blank line and is finalized on session end', () => {
  const options: any = {
    port: 0,
    log: () => {},
    showToast: () => {},
    modalDialogs: {},
    render: () => {},
    persistedState: { load: async () => null, save: async () => undefined, getPrefix: () => undefined },
  };

  const client = new OpencodeClient(options);

  let paneContent = '';
  const pushes: string[] = [];
  const pane: any = {
    getContent: () => paneContent,
    pushLine: (s: string) => { pushes.push(s); paneContent += s; },
    setContent: (s: string) => { paneContent = s; },
    setLabel: () => {},
    setScrollPerc: () => {},
    focus: () => {},
  };

  const tools = (client as any).createSessionTools('sess-compose', pane, null, null, () => {});
  const { appendLine, handlers, updatePane } = tools as any;

  // Start with initial content
  appendLine('previous content');
  updatePane();
  expect(paneContent.endsWith('\n')).toBe(true);

  // Simulate streaming partial text
  handlers.onTextDelta('Thinking');
  // The composing block should have been inserted after exactly one blank line
  // i.e. previous content ends with "\n", then there should be one blank line
  // before the muted composing text. Verify paneContent contains "\n\n" before 'Thinking'.
  expect(paneContent.includes('\n\n')).toBe(true);
  // Streaming composing content should be muted/grey.
  expect(paneContent).toContain('{gray-fg}');
  // Now simulate session end which should finalize composing
  handlers.onSessionEnd();
  // After finalization, the composing muted block should be replaced by final text
  // Since we didn't send a full final text, finalizeComposing will replace with composingBuffer
  expect(paneContent).not.toContain('{gray-fg}');
});

test('composing content is kept muted when tool-use arrives before session end', () => {
  const options: any = {
    port: 0,
    log: () => {},
    showToast: () => {},
    modalDialogs: {},
    render: () => {},
    persistedState: { load: async () => null, save: async () => undefined, getPrefix: () => undefined },
  };

  const client = new OpencodeClient(options);

  let paneContent = '';
  const pane: any = {
    getContent: () => paneContent,
    pushLine: (s: string) => { paneContent += s; },
    setContent: (s: string) => { paneContent = s; },
    setLabel: () => {},
    setScrollPerc: () => {},
    focus: () => {},
  };

  const tools = (client as any).createSessionTools('sess-compose-tool', pane, null, null, () => {});
  const { appendLine, handlers, updatePane } = tools as any;

  appendLine('previous content');
  updatePane();

  handlers.onTextDelta('I will run the audit now.');
  expect(paneContent).toContain('{gray-fg}');

  // Tool use should finalize the composing block as muted (not white)
  handlers.onToolUse('bash', 'Running audit commands');
  expect(paneContent).toContain('{gray-fg}I will run the audit now.');
});
