/**
 * tests/herdr/index.test.ts — Direct tests for the entry-point agent-routing
 * glue in packages/herdr/src/index.ts (WL-0MSD48ZFC0043AO3).
 *
 * The model feature (shortcut `model` field → `pi --model <pattern>`) is
 * covered at both ends of the chain by existing tests:
 *   - dispatch → onCommand: tests/herdr/shortcuts.test.ts (processChordInput,
 *     executeResolvedCommand, dispatchChordCommand)
 *   - bash harness flag forwarding: tests/herdr/send-to-pi.test.ts and
 *     packages/herdr/shared/tests/test_scripts.sh
 *
 * This file fills the gap at the connecting step: `buildSendToPiArgs` (the
 * argument vector passed to the send-to-pi.sh spawn) and `routeCommand`
 * (the agent/pane/stdout routing decision).
 */

import { describe, it, expect } from 'vitest';
import { buildSendToPiArgs, routeCommand, stripAgentPromptPrefix, stripCommandPrefix } from '../../packages/herdr/src/index.js';

// ── buildSendToPiArgs ─────────────────────────────────────────────────

describe('buildSendToPiArgs', () => {
  it('forwards --cwd and the command when no model is provided', () => {
    expect(buildSendToPiArgs('/skill:audit WL-123', '/tmp/proj')).toEqual([
      '--no-focus',
      '--cwd',
      '/tmp/proj',
      '/skill:audit WL-123',
    ]);
  });

  it('appends --model <pattern> after --cwd when a model is provided', () => {
    expect(buildSendToPiArgs('/skill:implement WL-123', '/tmp/proj', 'code')).toEqual([
      '--no-focus',
      '--cwd',
      '/tmp/proj',
      '--model',
      'code',
      '/skill:implement WL-123',
    ]);
  });

  it('omits the --model flag when model is undefined', () => {
    const args = buildSendToPiArgs('/intake WL-123', '/tmp/proj', undefined);
    expect(args).not.toContain('--model');
  });

  it('omits the --model flag when model is an empty string', () => {
    const args = buildSendToPiArgs('/plan WL-123', '/tmp/proj', '');
    expect(args).not.toContain('--model');
  });

  it('strips the /prompt: routing prefix so pi receives the bare prompt', () => {
    expect(buildSendToPiArgs('/prompt:Review the current work item', '/tmp/proj', 'author')).toEqual([
      '--no-focus',
      '--cwd',
      '/tmp/proj',
      '--model',
      'author',
      'Review the current work item',
    ]);
  });

  it('passes non-/prompt: commands through unchanged', () => {
    const args = buildSendToPiArgs('/skill:audit WL-123', '/tmp/proj', 'plan');
    expect(args[args.length - 1]).toBe('/skill:audit WL-123');
  });
});

// ── routeCommand ──────────────────────────────────────────────────────

describe('routeCommand', () => {
  it('routes /skill: commands to the agent channel', () => {
    expect(routeCommand('/skill:audit WL-123')).toBe('agent');
    expect(routeCommand('/skill:implement WL-123')).toBe('agent');
  });

  it('routes /intake and /plan commands to the agent channel', () => {
    expect(routeCommand('/intake WL-123')).toBe('agent');
    expect(routeCommand('/plan WL-123')).toBe('agent');
  });

  it('routes /prompt: free-form prompts to the agent channel', () => {
    expect(routeCommand('/prompt:Review the current work item')).toBe('agent');
  });

  it('routes !! and ! shell commands to the pane channel', () => {
    expect(routeCommand('!!wl close WL-123')).toBe('pane');
    expect(routeCommand('!wl update WL-123 --priority high')).toBe('pane');
  });

  it('routes everything else to the stdout fallback', () => {
    expect(routeCommand('wl search test')).toBe('stdout');
    expect(routeCommand('ls -la')).toBe('stdout');
  });

  it('routes a !-prefixed command to the pane channel even when it looks agent-like', () => {
    // isAgentCommand requires the command to START with /skill:, /intake,
    // /plan or /prompt: — a leading `!` makes it a shell command, so it
    // goes to the pane route.
    expect(routeCommand('!/skill:audit WL-123')).toBe('pane');
  });
});

// ── prefix helpers used by the routing glue ───────────────────────────

describe('stripCommandPrefix', () => {
  it('strips the !! prefix', () => {
    expect(stripCommandPrefix('!!wl close WL-123')).toBe('wl close WL-123');
  });

  it('strips the single ! prefix', () => {
    expect(stripCommandPrefix('!wl update WL-123')).toBe('wl update WL-123');
  });

  it('leaves unprefixed commands unchanged', () => {
    expect(stripCommandPrefix('wl search test')).toBe('wl search test');
  });
});

describe('stripAgentPromptPrefix', () => {
  it('strips the /prompt: prefix', () => {
    expect(stripAgentPromptPrefix('/prompt:Review this')).toBe('Review this');
  });

  it('leaves non-/prompt: commands unchanged', () => {
    expect(stripAgentPromptPrefix('/skill:audit WL-123')).toBe('/skill:audit WL-123');
  });
});
