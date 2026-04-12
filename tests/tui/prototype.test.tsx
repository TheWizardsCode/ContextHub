import React from 'react';
import {render} from 'ink-testing-library';
import App from '../../src/tui/prototype/App';
import {describe, it, expect} from 'vitest';

describe('tui prototype', () => {
  it('renders list and detail and handles dialog in headless mode', async () => {
    const {lastFrame, stdin, cleanup} = render(React.createElement(App, {headless: true}));

    // headless mode should open dialog briefly then close — ensure main layout renders
    expect(lastFrame()).toContain('Items');
    expect(lastFrame()).toContain('First item');
    expect(lastFrame()).toContain('Detail for first item');

    // simulate keypress to open dialog
    stdin.write('o');
    // dialog prompt text should appear
    expect(lastFrame()).toContain('Enter text');

    // press escape to close
    stdin.write('\x1b');
    // dialog should be gone
    expect(lastFrame()).not.toContain('Enter text');

    cleanup();
  });
});
