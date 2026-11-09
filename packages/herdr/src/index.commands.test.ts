/**
 * packages/herdr/src/index.commands.test.ts — command-prefix stripping and
 * `shortcuts.json` routing tests (work item WL-0MVOA238A0078J2H).
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripCommandPrefix, routeCommand, stripAgentPromptPrefix } from './index.js';
import { setupHostCpuPin, loadShortcutsJson } from './index.fixtures.js';

setupHostCpuPin();

// ---------------------------------------------------------------------------
// stripCommandPrefix tests
// ---------------------------------------------------------------------------

describe('stripCommandPrefix', () => {
  describe('double-bang prefix (!!)', () => {
    it('strips !! from commands starting with !!', () => {
      expect(stripCommandPrefix('!!wl update <id> --priority high')).toBe(
        'wl update <id> --priority high',
      );
    });

    it('strips !! from multi-command sequences', () => {
      expect(
        stripCommandPrefix(
          '!!wl reviewed <id> false && wl audit-set <id> --ready-to-close yes',
        ),
      ).toBe(
        'wl reviewed <id> false && wl audit-set <id> --ready-to-close yes',
      );
    });

    it('strips !! from search command', () => {
      expect(stripCommandPrefix('!!wl search ')).toBe('wl search ');
    });
  });

  describe('single-bang prefix (!)', () => {
    it('strips ! from commands starting with single !', () => {
      expect(stripCommandPrefix('!some shell command')).toBe('some shell command');
    });

    it('leaves !! commands unaffected by the single-bang rule', () => {
      expect(stripCommandPrefix('!!double-bang')).toBe('double-bang');
    });
  });

  describe('no prefix', () => {
    it('leaves agent commands unchanged (/skill:*)', () => {
      expect(stripCommandPrefix('/skill:implement <id>')).toBe(
        '/skill:implement <id>',
      );
    });

    it('leaves agent commands unchanged (/intake)', () => {
      expect(stripCommandPrefix('/intake')).toBe('/intake');
    });

    it('leaves agent commands unchanged (/plan)', () => {
      expect(stripCommandPrefix('/plan <id>')).toBe('/plan <id>');
    });

    it('leaves /prompt: commands unchanged', () => {
      expect(stripCommandPrefix('/prompt:Review this code')).toBe(
        '/prompt:Review this code',
      );
    });

    it('leaves /wl filter commands unchanged', () => {
      expect(stripCommandPrefix('/wl idea')).toBe('/wl idea');
      expect(stripCommandPrefix('/wl review')).toBe('/wl review');
    });

    it('leaves plain commands without bang unchanged', () => {
      expect(stripCommandPrefix('echo hello')).toBe('echo hello');
    });

    it('leaves empty string unchanged', () => {
      expect(stripCommandPrefix('')).toBe('');
    });
  });

  describe('edge cases', () => {
    it('strips !! from !!wl close <id>', () => {
      expect(stripCommandPrefix('!!wl close <id>')).toBe('wl close <id>');
    });

    it('strips !! from !!wl delete <id>', () => {
      expect(stripCommandPrefix('!!wl delete <id>').trim()).toBe('wl delete <id>');
    });

    it('strips !! from !!wl update <id> --status <status> --stage <stage>', () => {
      expect(stripCommandPrefix('!!wl update <id> --status <status> --stage <stage> ')).toBe(
        'wl update <id> --status <status> --stage <stage> ',
      );
      expect(stripCommandPrefix('!!wl update <id> --status <status> --stage <stage>')).toBe(
        'wl update <id> --status <status> --stage <stage>',
      );
    });

    it('strips !! from !!wl update <id> --title ', () => {
      expect(stripCommandPrefix('!!wl update <id> --title ')).toBe(
        'wl update <id> --title ',
      );
    });
  });
});

describe('shortcuts.json command routing', () => {
  const entries = loadShortcutsJson();

  it('routes the a-y audit-approve command to the visible pane (bug fix)', () => {
    const entry = entries.find((e) => e.chord.join(',') === 'a,y');
    expect(entry).toBeDefined();
    expect(entry!.command.startsWith('!!')).toBe(true);
    expect(routeCommand(entry!.command)).toBe('pane');
  });

  it('routes all shell-executed wl commands (!! prefix) to the visible pane', () => {
    const shellEntries = entries.filter((e) => e.command.startsWith('!!'));
    expect(shellEntries.length).toBeGreaterThan(0);
    for (const e of shellEntries) {
      expect(routeCommand(e.command)).toBe('pane');
    }
  });

  it('routes agent commands (/skill:, /intake, /plan) to the agent pane', () => {
    const agentEntries = entries.filter((e) =>
      /^\/skill:|^\/intake|^\/plan/.test(e.command),
    );
    expect(agentEntries.length).toBeGreaterThan(0);
    for (const e of agentEntries) {
      expect(routeCommand(e.command)).toBe('agent');
    }
  });

  it('routes /prompt: entries to the agent pane', () => {
    const promptEntries = entries.filter((e) => e.command.startsWith('/prompt:'));
    expect(promptEntries.length).toBeGreaterThan(0);
    for (const e of promptEntries) {
      expect(routeCommand(e.command)).toBe('agent');
    }
  });

  it('uses a free chord for /prompt: entries (no collision with existing chords)', () => {
    const promptEntries = entries.filter((e) => e.command.startsWith('/prompt:'));
    expect(promptEntries.length).toBeGreaterThan(0);
    const usedChords = new Set(
      entries
        .filter((e) => !e.command.startsWith('/prompt:'))
        .map((e) => e.chord.join(' ')),
    );
    for (const e of promptEntries) {
      expect(usedChords.has(e.chord.join(' '))).toBe(false);
      expect(e.view).toBe('both');
      expect(e.label).toBeTruthy();
    }
  });

  it('keeps /wl stage-filter commands unprefixed', () => {
    const filterEntries = entries.filter((e) => e.command.startsWith('/wl '));
    expect(filterEntries.length).toBeGreaterThan(0);
    for (const e of filterEntries) {
      expect(e.command.startsWith('!!')).toBe(false);
    }
  });

  it('routes the P n blank-session command with focus:true (WL-0MT70LC6B009TL3Q)', () => {
    const _here2 = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(_here2, 'shortcuts.json'), 'utf8');
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    const pn = parsed.find((e) => Array.isArray(e.chord) && e.chord.join(',') === 'P,n');
    expect(pn).toBeDefined();
    expect(pn!.focus).toBe(true);
  });

  it('routes the r i producer-interview command with focus:true (WL-0MURJ0LFH002O95I)', () => {
    const _here2 = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(_here2, 'shortcuts.json'), 'utf8');
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    const ri = parsed.find((e) => Array.isArray(e.chord) && e.chord.join(',') === 'r,i');
    expect(ri).toBeDefined();
    // The interactive interview pane must receive focus immediately.
    expect(ri!.focus).toBe(true);
    // The focus behaviour is documented in the entry's description.
    expect(String(ri!.description)).toMatch(/focus/i);
  });

  it('binds P-p to the free-form prompt, P-a to the audit-gaps prompt, and P-n to a blank session', () => {
    const freePrompt = entries.find((e) => e.chord.join(' ') === 'P p');
    expect(freePrompt).toBeDefined();
    expect(freePrompt!.command).toBe('/prompt:<prompt>');
    expect(freePrompt!.view).toBe('both');
    expect(freePrompt!.model).toBe('plan');
    expect(routeCommand(freePrompt!.command)).toBe('agent');

    const auditPrompt = entries.find((e) => e.chord.join(' ') === 'P a');
    expect(auditPrompt).toBeDefined();
    expect(auditPrompt!.command).toBe(
      '/prompt:What are the audit gaps reported in the most recent audit for <id>',
    );
    expect(auditPrompt!.view).toBe('both');
    expect(auditPrompt!.model).toBe('plan');
    expect(routeCommand(auditPrompt!.command)).toBe('agent');

    const blankSession = entries.find((e) => e.chord.join(' ') === 'P n');
    expect(blankSession).toBeDefined();
    expect(blankSession!.command).toBe('/prompt:');
    expect(blankSession!.view).toBe('both');
    expect(blankSession!.model).toBe('plan');
    // Empty /prompt: carries no placeholders: no command-input form, no
    // work-item claim (AC2/AC3), and it routes to the agent channel.
    expect(blankSession!.command).not.toContain('<id>');
    expect(blankSession!.command).not.toContain('<prompt>');
    expect(routeCommand(blankSession!.command)).toBe('agent');
  });

  it('keeps the single-key p chord bound to plan (P leader does not shadow it)', () => {
    const planEntry = entries.find((e) => e.chord.join(' ') === 'p');
    expect(planEntry).toBeDefined();
    expect(planEntry!.command).toBe('/plan <id>');
    // The uppercase P leader is distinct from the lowercase p plan chord.
    expect(entries.some((e) => e.chord.join(' ') === 'P')).toBe(false);
  });
});

describe('routeCommand', () => {
  describe('agent commands', () => {    it('routes /skill: commands to the agent pane', () => {
      expect(routeCommand('/skill:implement <id>')).toBe('agent');
      expect(routeCommand('/skill:audit <id>')).toBe('agent');
    });

    it('routes /intake and /plan commands to the agent pane', () => {
      expect(routeCommand('/intake')).toBe('agent');
      expect(routeCommand('/intake <id>')).toBe('agent');
      expect(routeCommand('/plan <id>')).toBe('agent');
    });

    it('routes /prompt: commands to the agent pane', () => {
      expect(routeCommand('/prompt:Some prompt text')).toBe('agent');
      expect(routeCommand('/prompt:Review the current work item')).toBe('agent');
      expect(routeCommand('/prompt:')).toBe('agent');
    });
  });

  describe('!! / ! prefixed commands', () => {
    it('routes !!-prefixed wl commands to the visible pane', () => {
      expect(
        routeCommand(
          '!!wl reviewed <id> false && wl audit-set <id> --ready-to-close yes --summary \'Approved by manual review\'',
        ),
      ).toBe('pane');
    });

    it('routes !!-prefixed single commands to the visible pane', () => {
      expect(routeCommand('!!wl update <id> --priority high')).toBe('pane');
      expect(routeCommand('!!wl close <id>')).toBe('pane');
      expect(routeCommand('!!wl delete <id>')).toBe('pane');
    });

    it('routes single-! prefixed commands to the visible pane', () => {
      expect(routeCommand('!wl update <id> --title ')).toBe('pane');
    });
  });

  describe('unprefixed commands', () => {
    it('routes unprefixed commands to stdout (CMD:)', () => {
      expect(
        routeCommand(
          'wl reviewed <id> && wl comment add <id> --body \'<producer_comment>\'',
        ),
      ).toBe('stdout');
      expect(routeCommand('wl search ')).toBe('stdout');
      expect(routeCommand('/wl idea')).toBe('stdout');
    });
  });
});

describe('stripAgentPromptPrefix', () => {
  it('strips the /prompt: prefix, leaving the prompt text', () => {
    expect(stripAgentPromptPrefix('/prompt:Review the current work item')).toBe(
      'Review the current work item',
    );
  });

  it('strips /prompt: leaving an empty string when nothing follows', () => {
    expect(stripAgentPromptPrefix('/prompt:')).toBe('');
  });

  it('leaves non-/prompt: commands unchanged', () => {
    expect(stripAgentPromptPrefix('/skill:implement <id>')).toBe(
      '/skill:implement <id>',
    );
    expect(stripAgentPromptPrefix('/intake <id>')).toBe('/intake <id>');
    expect(stripAgentPromptPrefix('/plan <id>')).toBe('/plan <id>');
    expect(stripAgentPromptPrefix('!!wl close <id>')).toBe('!!wl close <id>');
  });
});
