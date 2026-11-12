/**
 * packages/herdr/src/index.args.test.ts — `buildSendToPiArgs` /
 * `buildRunInPaneArgs` argument-builder tests (work item WL-0MVOA238A0078J2H).
 *
 * Moved verbatim from the monolithic `index.test.ts`; imports the barrel
 * (`./index.js`) so the public-surface contract keeps being tested.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSendToPiArgs, buildRunInPaneArgs } from './index.js';
import { setupHostCpuPin, buildSendToPiArgsWithPriority } from './index.fixtures.js';

setupHostCpuPin();

describe('buildSendToPiArgs', () => {
  // Selection-list agent dispatch must NOT steal focus from the list
  // (WL-0MSHIA53D009DJOT): every agent-pane spawn passes --no-focus so
  // shared/send-to-pi.sh skips its final zoom. The flag is emitted before
  // --cwd, mirroring buildDowntimePaneArgs. The P n shortcut opts in to
  // --focus (WL-0MT70LC6B009TL3Q).
  it('P n (new session) passes --focus so the new pane immediately receives focus', () => {
    expect(buildSendToPiArgs('/prompt:', '/project', 'plan', undefined, undefined, true)).toEqual([
      '--focus',
      '--cwd',
      '/project',
      '--model',
      'plan',
      '',
    ]);
  });

  it('passes --no-focus when focus is false/undefined (current default)', () => {
    // Unfocused agent shortcuts (the vast majority) keep --no-focus.
    expect(buildSendToPiArgs('/prompt:Review the item', '/project', 'plan')).toContain('--no-focus');
    expect(buildSendToPiArgs('/prompt:Review', '/project', 'plan', undefined, undefined, false)).toContain('--no-focus');
    expect(buildSendToPiArgs('/prompt:Review', '/project', 'plan', undefined, undefined, undefined)).toContain('--no-focus');
  });

  it('includes --model <model> for agent commands with a model', () => {
    expect(buildSendToPiArgs('/skill:implement <id>', '/project', 'code')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--model',
      'code',
      '/skill:implement <id>',
    ]);
  });

  it('omits --model when no model is provided (--no-focus retained)', () => {
    expect(buildSendToPiArgs('/skill:implement <id>', '/project')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '/skill:implement <id>',
    ]);
  });

  it('strips the /prompt: prefix and keeps the model', () => {
    expect(buildSendToPiArgs('/prompt:Review the item', '/project', 'author')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--model',
      'author',
      'Review the item',
    ]);
  });

  it('passes an empty prompt arg for a bare /prompt: command (blank session)', () => {
    expect(buildSendToPiArgs('/prompt:', '/project', 'plan')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--model',
      'plan',
      '',
    ]);
  });

  it('passes /plan with the plan model', () => {
    expect(buildSendToPiArgs('/plan <id>', '/project', 'plan')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--model',
      'plan',
      '/plan <id>',
    ]);
  });

  it('forwards a descriptive pane name via --pane-name (WL-0MSJ4E8UA005KG9Y)', () => {
    expect(
      buildSendToPiArgs('/skill:implement WL-1', '/project', 'code', undefined, 'Manually triggered implement Fix the bug - WL-1'),
    ).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--pane-name',
      'Manually triggered implement Fix the bug - WL-1',
      '--model',
      'code',
      '/skill:implement WL-1',
    ]);
  });

  it('omits --pane-name when none is provided', () => {
    expect(buildSendToPiArgs('/skill:audit WL-2', '/project')).not.toContain('--pane-name');
  });
});

// ---------------------------------------------------------------------------
// buildRunInPaneArgs tests (WL-0MSHIA53D009DJOT) — the pane and stdout
// dispatch routes share this helper, so a single unit-test group covers both
// AC2 (!!/! prefixed) and AC3 (plain shell) no-focus behavior.
// ---------------------------------------------------------------------------

describe('buildRunInPaneArgs', () => {
  // Focus opt-in (WL-0MT70LC6B009TL3Q): like buildSendToPiArgs,
  // --focus is passed when focus is true, --no-focus otherwise.
  it('passes --focus + --cwd when focus is true (focused shortcut)', () => {
    expect(buildRunInPaneArgs('wl update WL-1 --priority high', '/project', undefined, true)).toEqual([
      '--focus',
      '--cwd',
      '/project',
      'wl update WL-1 --priority high',
    ]);
  });

  it('passes --no-focus + --cwd before a !!-prefixed command (pane route)', () => {
    expect(buildRunInPaneArgs('wl update <id> --priority high', '/project')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      'wl update <id> --priority high',
    ]);
  });

  it('passes --no-focus + --cwd before a plain shell command (stdout route)', () => {
    expect(buildRunInPaneArgs('ls -la && pwd', '/project')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      'ls -la && pwd',
    ]);
  });

  it('keeps the full command intact after the options', () => {
    const args = buildRunInPaneArgs("echo 'quoted arg' --flag", '/project');
    expect(args.slice(0, 3)).toEqual(['--no-focus', '--cwd', '/project']);
    expect(args[3]).toBe("echo 'quoted arg' --flag");
  });

  it('forwards --pane-name to replace the default "Command Output" (WL-0MSJ4E8UA005KG9Y)', () => {
    expect(buildRunInPaneArgs('wl update WL-1 --priority high', '/project', 'Shell: wl update WL-1 (Fix the bug) WL-1')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--pane-name',
      'Shell: wl update WL-1 (Fix the bug) WL-1',
      'wl update WL-1 --priority high',
    ]);
  });

  it('omits --pane-name when none is provided', () => {
    expect(buildRunInPaneArgs('ls -la', '/project')).not.toContain('--pane-name');
  });
});

describe('buildSendToPiArgs — interactive item-tab anchor (AC1/AC6)', () => {
  it('appends --anchor <paneId> when an anchor is supplied', () => {
    expect(
      buildSendToPiArgs('/skill:implement WL-1', '/project', 'code', undefined, undefined, false, 'w9:p7'),
    ).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--model',
      'code',
      '--anchor',
      'w9:p7',
      '/skill:implement WL-1',
    ]);
  });

  it('forwards --anchor as a head option (value follows, prompt stays last)', () => {
    const args = buildSendToPiArgs(
      '/skill:implement WL-1',
      '/project',
      'code',
      '/tmp/pane.json',
      'Manually triggered implement - WL-1',
      true,
      'w9:p7',
    );
    const at = args.indexOf('--anchor');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(args[at + 1]).toBe('w9:p7');
    expect(args[args.length - 1]).toBe('/skill:implement WL-1');
  });

  it('omits --anchor when it is undefined (no-ID / fail-open fallback)', () => {
    expect(buildSendToPiArgs('/skill:implement WL-1', '/project', 'code')).not.toContain('--anchor');
  });

  it('omits --anchor when it is an empty string', () => {
    expect(
      buildSendToPiArgs('/skill:implement WL-1', '/project', 'code', undefined, undefined, false, ''),
    ).not.toContain('--anchor');
  });
});

describe('buildRunInPaneArgs — interactive item-tab anchor (AC2/AC6)', () => {
  it('appends --anchor <paneId> when an anchor is supplied', () => {
    expect(
      buildRunInPaneArgs('wl update WL-1 --priority high', '/project', undefined, false, 'w9:p7'),
    ).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--anchor',
      'w9:p7',
      'wl update WL-1 --priority high',
    ]);
  });

  it('forwards --anchor as a head option (value follows, command stays last)', () => {
    const args = buildRunInPaneArgs(
      'wl update WL-1 --priority high',
      '/project',
      'Shell: wl update WL-1 WL-1',
      true,
      'w9:p7',
    );
    const at = args.indexOf('--anchor');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(args[at + 1]).toBe('w9:p7');
    expect(args[args.length - 1]).toBe('wl update WL-1 --priority high');
  });

  it('omits --anchor when it is undefined', () => {
    expect(buildRunInPaneArgs('ls -la', '/project')).not.toContain('--anchor');
  });

  it('omits --anchor when it is an empty string', () => {
    expect(buildRunInPaneArgs('ls -la', '/project', undefined, false, '')).not.toContain('--anchor');
  });

  // split-confirmation channel for root-pane cleanup (WL-0MUYI3K8H007MPKF)
  it('forwards --pane-id-file as a head option (command stays last)', () => {
    expect(
      buildRunInPaneArgs(
        'wl update WL-1 --priority high',
        '/project',
        'Shell: wl update WL-1 WL-1',
        false,
        'w9:p7',
        '/tmp/pane.json',
      ),
    ).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--pane-name',
      'Shell: wl update WL-1 WL-1',
      '--anchor',
      'w9:p7',
      '--pane-id-file',
      '/tmp/pane.json',
      'wl update WL-1 --priority high',
    ]);
  });

  it('omits --pane-id-file when absent/empty', () => {
    expect(buildRunInPaneArgs('ls -la', '/project')).not.toContain('--pane-id-file');
    expect(
      buildRunInPaneArgs('ls -la', '/project', undefined, false, undefined, ''),
    ).not.toContain('--pane-id-file');
  });
});

// ---------------------------------------------------------------------------
// Agent-pane association capture (WL-0MSBQUJQX005RAT9)
//
// AC1: when an agent command carrying a work-item ID is dispatched, the
// plugin captures the new pane ID (via --pane-id-file) and records the
// work-item ↔ pane association. AC6: only worklist-spawned agent commands
// are tracked; commands without an ID are not.
// ---------------------------------------------------------------------------

describe('buildSendToPiArgs — pane-id capture flag', () => {
  it('forwards --pane-id-file when provided (with --no-focus)', () => {
    expect(
      buildSendToPiArgs('/skill:implement <id>', '/project', 'code', '/tmp/pane.json'),
    ).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--model',
      'code',
      '--pane-id-file',
      '/tmp/pane.json',
      '/skill:implement <id>',
    ]);
  });

  it('omits --pane-id-file when not provided (backward compatible, --no-focus retained)', () => {
    expect(buildSendToPiArgs('/skill:implement <id>', '/project')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '/skill:implement <id>',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Request-priority threading (test-first WL-0MVF3PYO3000EVJ3, parent
// WL-0MVE1NZ4J000H5NH)
//
// The proxy retired its global fast/cheap mode in favour of a per-request
// `X-Priority` header. Herdr maps the dispatched work item's priority onto a
// request priority and hands it to the launched process as
// `HERDR_REQUEST_PRIORITY` (parent AC2/AC3).
//
// Request-priority threading implemented by WL-0MVF3Q3VL000UNCN: these
// specs are real assertions pinning the `--request-priority` flag and the
// `HERDR_REQUEST_PRIORITY` env on the two dispatch paths.
// ---------------------------------------------------------------------------

describe('buildSendToPiArgs — request priority (WL-0MVF3PYO3000EVJ3 AC4)', () => {
  it('forwards --request-priority <mapped value> so the pane process receives it', () => {
    const args = buildSendToPiArgsWithPriority(
      '/skill:implement WL-1',
      '/project',
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      'high',
    );
    const flagIndex = args.indexOf('--request-priority');
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe('high');
    // The command must stay the final argv token so send-to-pi.sh parses it.
    expect(args[args.length - 1]).toBe('/skill:implement WL-1');
  });

  it('omits --request-priority when no priority is supplied (backward compatible)', () => {
    expect(buildSendToPiArgs('/skill:implement WL-1', '/project')).not.toContain('--request-priority');
  });
});
