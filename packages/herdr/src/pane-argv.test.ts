/**
 * packages/herdr/src/pane-argv.test.ts — canonical pane-spawn argv builder
 * tests (WL-0MWHWGZI4007D911).
 *
 * The byte-exact behaviour pins live in
 * `dispatched-pane-spawn.pin.test.ts` / `index.args.test.ts` and assert the
 * PUBLIC wrappers (`buildSendToPiArgs` etc. through the barrels). This suite
 * pins the CANONICAL module itself — the options-object API every wrapper
 * delegates to — so a future contributor who calls the canonical builders
 * directly (or adds a new flag here) keeps the same byte-exact contract, and
 * the full-pivot vocabulary (AC3) is enforced at the source.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDowntimePaneArgs,
  buildRunInPaneArgs,
  buildSendToPiArgs,
  type RunInPaneArgsOptions,
  type SendToPiArgsOptions,
} from './pane-argv.js';

describe('pane-argv.ts buildSendToPiArgs (canonical, options object)', () => {
  it('byte-exact full option set: focus, cwd, pane-name, model, pane-id-file, anchor, request-priority, prompt last', () => {
    const command = '/skill:implement WL-1';
    const opts: SendToPiArgsOptions = {
      model: 'code',
      paneIdFile: '/tmp/pane.json',
      paneName: 'My Pane',
      focus: true,
      anchor: 'w9:p7',
      requestPriority: 'high',
    };
    expect(buildSendToPiArgs(command, '/repo', opts)).toEqual([
      '--focus',
      '--cwd',
      '/repo',
      '--pane-name',
      'My Pane',
      '--model',
      'code',
      '--pane-id-file',
      '/tmp/pane.json',
      '--anchor',
      'w9:p7',
      '--request-priority',
      'high',
      command,
    ]);
  });

  it('defaults to --no-focus and strips the /prompt: routing prefix', () => {
    expect(buildSendToPiArgs('/prompt:Review the code', '/project', { model: 'plan' })).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--model',
      'plan',
      'Review the code',
    ]);
  });

  it('exposes the OPTIONAL status for added flags only; every optional stays omitable', () => {
    const opts: SendToPiArgsOptions = {};
    expect(buildSendToPiArgs('cmd', '/c', opts)).toEqual(['--no-focus', '--cwd', '/c', 'cmd']);
    expect(opts.focus).toBeUndefined();
    expect(opts.model).toBeUndefined();
  });

  it('pivot AC3: never assembles downtime-only flags (the vocabulary is per-script)', () => {
    const args = buildSendToPiArgs('/skill:implement WL-1', '/c', {
      model: 'code',
      paneIdFile: '/p.json',
      paneName: 'n',
      focus: true,
      anchor: 'a',
      requestPriority: 'high',
    });
    for (const forbidden of ['--reservation-ticket', '--local-preference']) {
      expect(args).not.toContain(forbidden);
    }
  });
});

describe('pane-argv.ts buildRunInPaneArgs (canonical, options object)', () => {
  it('byte-exact full option set: focus, cwd, pane-name, anchor, pane-id-file, command last', () => {
    const command = 'wl update WL-1 --priority high';
    const opts: RunInPaneArgsOptions = {
      paneName: 'Shell: wl update WL-1 WL-1',
      focus: true,
      anchor: 'w9:p7',
      paneIdFile: '/tmp/pane.json',
    };
    expect(buildRunInPaneArgs(command, '/repo', opts)).toEqual([
      '--focus',
      '--cwd',
      '/repo',
      '--pane-name',
      'Shell: wl update WL-1 WL-1',
      '--anchor',
      'w9:p7',
      '--pane-id-file',
      '/tmp/pane.json',
      command,
    ]);
  });

  it('defaults to --no-focus with the command as the final token', () => {
    expect(buildRunInPaneArgs('ls -la && pwd', '/project')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      'ls -la && pwd',
    ]);
  });

  it('pivot AC3: never assembles --model / --request-priority / downtime-only flags', () => {
    const args = buildRunInPaneArgs('ls', '/c', {
      paneName: 'n',
      focus: true,
      anchor: 'a',
      paneIdFile: '/p.json',
    });
    for (const forbidden of [
      '--model',
      '--request-priority',
      '--reservation-ticket',
      '--local-preference',
    ]) {
      expect(args).not.toContain(forbidden);
    }
  });
});

describe('pane-argv.ts buildDowntimePaneArgs (canonical, options object)', () => {
  it('byte-exact full option set: pane-name, no-focus, anchor, reservation-ticket, local-preference, cwd, model, prompt last', () => {
    const prompt = '/skill:implement WL-1';
    expect(
      buildDowntimePaneArgs('implement', prompt, {
        model: 'code',
        cwd: '/repo',
        paneName: 'My Custom Pane',
        anchorId: 'w9:p7',
        reservationTicketId: 'tkt-1',
        localPreference: 'remote-ok',
      }),
    ).toEqual([
      '--pane-name',
      'My Custom Pane',
      '--no-focus',
      '--anchor',
      'w9:p7',
      '--reservation-ticket',
      'tkt-1',
      '--local-preference',
      'remote-ok',
      '--cwd',
      '/repo',
      '--model',
      'code',
      prompt,
    ]);
  });

  it('uses the kind-derived default pane title (Downtime triggered <kind> <title> - <id>)', () => {
    expect(
      buildDowntimePaneArgs('implement', 'p', {
        model: 'code',
        cwd: '/repo',
        itemTitle: 'Fix the bug',
        itemId: 'WL-1',
      }),
    ).toEqual([
      '--pane-name',
      'Downtime triggered implement Fix the bug - WL-1',
      '--no-focus',
      '--cwd',
      '/repo',
      '--model',
      'code',
      'p',
    ]);
  });

  it('pivot AC3: never emits interactive-only flags (--focus / --pane-id-file / --request-priority)', () => {
    const args = buildDowntimePaneArgs('implement', 'p', {
      model: 'code',
      cwd: '/c',
      paneName: 'n',
      anchorId: 'a',
      reservationTicketId: 't',
      localPreference: 'remote-ok',
    });
    for (const forbidden of ['--focus', '--pane-id-file', '--request-priority']) {
      expect(args).not.toContain(forbidden);
    }
  });
});
