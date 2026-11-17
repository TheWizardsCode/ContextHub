/**
 * packages/herdr/src/dispatched-pane-spawn.pin.test.ts — characterisation
 * pins for every dispatched-pane spawn path (WL-0MWHWGN23001KMQW).
 *
 * A behaviour-preserving refactor of dispatched-pane creation is only safe if
 * the CURRENT argv/env/label behaviour is pinned byte-exactly BEFORE any
 * unification child changes code. This suite is that pin: the full option
 * matrix of the three argv builders (AC1), the `send-to-pi.sh` spawn env
 * (AC2), the deliberate builder divergences (AC3) and the pane-label parsers
 * (AC4). Unification children (argv-builder unification, label-parse
 * unification, placement) keep this suite green to prove behaviour
 * preservation.
 *
 * Consolidation note: existing suites already cover pieces
 * (`downtime-worker.pane.test.ts`, `index.args.test.ts`,
 * `pane-close-herdr.test.ts`, `host-dispatch-budget.repair.test.ts`); this
 * file consolidates the FULL pinning surface in one place — it extends, it
 * does not replace those suites.
 *
 * ── AC3 pivot table: deliberate divergences between the three builders ────
 *
 * | Flag | buildDowntimePaneArgs | buildSendToPiArgs | buildRunInPaneArgs |
 * | --- | --- | --- | --- |
 * | focus | always `--no-focus` — no opt-in (attended panes get the focus choice; background dispatch is invisible) | `--focus` when `focus:true`, else `--no-focus` | `--focus` when `focus:true`, else `--no-focus` |
 * | `--cwd` | yes, after the optionals and before `--model` | yes, immediately after the focus flag | yes, immediately after the focus flag |
 * | `--pane-name` | yes; defaults to `buildDowntimePaneTitle(kind, …)` (`Downtime plan` / `Downtime triggered <kind> <title> - <id>`) | yes, optional (script default "Pi Agent") | yes, optional (script default "Command Output") |
 * | `--model` | yes — always (`opts.model` is required for downtime dispatch) | yes, optional | **no** — shell panes have no model |
 * | `--anchor` | yes | yes | yes |
 * | `--pane-id-file` | **no** — downtime never captures the work-item↔pane association | yes — agent commands carrying an item ID | yes — split-confirmation channel for root-pane cleanup |
 * | `--request-priority` | **no** — downtime conveys priority via env (`HERDR_REQUEST_PRIORITY`) only | yes — placed before the final command | **no** |
 * | `--reservation-ticket` | yes — local-reservation fail-open contract (C2) | **no** | **no** |
 * | `--local-preference` | yes — per-turn locality fail-open contract (C4) | **no** | **no** |
 * | terminal token | prompt | prompt (after `--request-priority`) | command |
 *
 * Why: downtime dispatch is unattended background work — it never steals
 * focus, never captures a pane id file, and carries its priority through the
 * spawn env; the reservation ticket and locality preference are
 * downtime-only contracts. `send-to-pi.sh` panes are interactive agent
 * sessions — they take the full interactive flag set (`--model`,
 * `--pane-id-file`, `--request-priority`, focus opt-in) but never a local
 * reservation. `run-in-pane.sh` panes run shell output — no model, no
 * request priority, no reservation; `--pane-id-file` is their split
 * confirmation channel only.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDowntimePaneArgs,
  buildDowntimeSpawnOptions,
  scrubRepositoryOverrides,
  REPOSITORY_OVERRIDE_ENV_VARS,
} from './downtime-worker.js';
import { buildSendToPiArgs, buildRunInPaneArgs } from './index.js';
import {
  isDowntimePaneLabel,
  paneItemIdFromLabel,
  paneKindFromLabel,
} from './pane-label.js';
import { decodeBudgetPaneLabel } from './host-dispatch-budget.repair.js';
import { LOCAL_RESERVATION_TICKET_ENV } from './downtime-worker.constants.js';
import { LOCAL_PREFERENCE_ENV_VAR } from './local-preference.js';
import { REQUEST_PRIORITY_ENV_VAR } from './request-priority.js';

// ── AC1: full byte-exact argv matrix for the three builders ─────────────

describe('AC1 — buildDowntimePaneArgs (downtime-worker.pane.ts)', () => {
  it('baseline: paneName default, --no-focus, --cwd, --model, prompt last', () => {
    expect(
      buildDowntimePaneArgs('plan', 'Run /skill:plan WL-ABC — Some task.', {
        model: 'plan',
        cwd: '/repo',
      }),
    ).toEqual([
      '--pane-name',
      'Downtime plan',
      '--no-focus',
      '--cwd',
      '/repo',
      '--model',
      'plan',
      'Run /skill:plan WL-ABC — Some task.',
    ]);
  });

  it('paneName override replaces the kind-derived default', () => {
    expect(
      buildDowntimePaneArgs('implement', 'p', {
        model: 'code',
        cwd: '/repo',
        paneName: 'My Custom Pane',
      }),
    ).toEqual([
      '--pane-name',
      'My Custom Pane',
      '--no-focus',
      '--cwd',
      '/repo',
      '--model',
      'code',
      'p',
    ]);
  });

  it('itemTitle + itemId produce the full-format title suffix (Downtime triggered <kind> <title> - <id>)', () => {
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

  it('anchor, reservation ticket and local preference are forwarded in order', () => {
    expect(
      buildDowntimePaneArgs('implement', 'p', {
        model: 'code',
        cwd: '/repo',
        anchorId: 'w9:p7',
      }),
    ).toEqual([
      '--pane-name',
      'Downtime implement',
      '--no-focus',
      '--anchor',
      'w9:p7',
      '--cwd',
      '/repo',
      '--model',
      'code',
      'p',
    ]);
    expect(
      buildDowntimePaneArgs('implement', 'p', {
        model: 'code',
        cwd: '/repo',
        reservationTicketId: 'tkt-1',
      }),
    ).toEqual([
      '--pane-name',
      'Downtime implement',
      '--no-focus',
      '--reservation-ticket',
      'tkt-1',
      '--cwd',
      '/repo',
      '--model',
      'code',
      'p',
    ]);
    expect(
      buildDowntimePaneArgs('implement', 'p', {
        model: 'code',
        cwd: '/repo',
        localPreference: 'remote-ok',
      }),
    ).toEqual([
      '--pane-name',
      'Downtime implement',
      '--no-focus',
      '--local-preference',
      'remote-ok',
      '--cwd',
      '/repo',
      '--model',
      'code',
      'p',
    ]);
  });

  it('all optional flags together: byte-exact argv, prompt stays the final token', () => {
    const prompt = '/skill:implement WL-1';
    const args = buildDowntimePaneArgs('implement', prompt, {
      model: 'code',
      cwd: '/repo',
      paneName: 'My Custom Pane',
      anchorId: 'w9:p7',
      reservationTicketId: 'tkt-1',
      localPreference: 'remote-ok',
    });
    expect(args).toEqual([
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
    expect(args[args.length - 1]).toBe(prompt);
  });
});

describe('AC1 — buildSendToPiArgs (index.commands.ts)', () => {
  it('minimal: --no-focus + --cwd + command (no optional flags)', () => {
    expect(buildSendToPiArgs('/skill:implement <id>', '/project')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '/skill:implement <id>',
    ]);
  });

  it('focus opt-in: --focus replaces --no-focus at the head', () => {
    expect(buildSendToPiArgs('/skill:implement WL-1', '/project', undefined, undefined, undefined, true)).toEqual([
      '--focus',
      '--cwd',
      '/project',
      '/skill:implement WL-1',
    ]);
  });

  it('strips the /prompt: routing prefix so pi receives the bare prompt', () => {
    expect(buildSendToPiArgs('/prompt:Review the code', '/project', 'plan')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--model',
      'plan',
      'Review the code',
    ]);
  });

  it('all optional flags together: byte-exact argv, command stays the final token', () => {
    const command = '/skill:implement WL-1';
    const args = buildSendToPiArgs(
      command,
      '/repo',
      'code',
      '/tmp/pane.json',
      'My Pane',
      true,
      'w9:p7',
      'high',
    );
    expect(args).toEqual([
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
    expect(args[args.length - 1]).toBe(command);
  });

  it('--request-priority sits BEFORE the final command (send-to-pi.sh treats post-option argv as the command)', () => {
    const args = buildSendToPiArgs(
      '/prompt:Review the code',
      '/project',
      'plan',
      undefined,
      undefined,
      false,
      undefined,
      'high',
    );
    expect(args).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      '--model',
      'plan',
      '--request-priority',
      'high',
      'Review the code',
    ]);
    expect(args[args.length - 1]).toBe('Review the code');
  });
});

describe('AC1 — buildRunInPaneArgs (index.commands.ts)', () => {
  it('minimal: --no-focus + --cwd + command', () => {
    expect(buildRunInPaneArgs('wl update WL-1 --priority high', '/project')).toEqual([
      '--no-focus',
      '--cwd',
      '/project',
      'wl update WL-1 --priority high',
    ]);
  });

  it('focus opt-in: --focus at the head', () => {
    expect(buildRunInPaneArgs('ls -la', '/project', undefined, true)).toEqual([
      '--focus',
      '--cwd',
      '/project',
      'ls -la',
    ]);
  });

  it('all optional flags together: byte-exact argv, command stays the final token', () => {
    const command = 'wl update WL-1 --priority high';
    const args = buildRunInPaneArgs(command, '/repo', 'Shell: wl update WL-1 WL-1', true, 'w9:p7', '/tmp/pane.json');
    expect(args).toEqual([
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
    expect(args[args.length - 1]).toBe(command);
  });
});

// ── AC3: deliberate divergences — flags each builder must NEVER emit ─────

describe('AC3 — builder flag vocabulary (the pivot table, enforced)', () => {
  it('the downtime builder never emits interactive-only flags (--focus / --pane-id-file / --request-priority)', () => {
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

  it('buildSendToPiArgs never emits downtime-only flags (--reservation-ticket / --local-preference)', () => {
    const args = buildSendToPiArgs('/skill:implement WL-1', '/c', 'code', '/p.json', 'n', true, 'a', 'high');
    for (const forbidden of ['--reservation-ticket', '--local-preference']) {
      expect(args).not.toContain(forbidden);
    }
  });

  it('buildRunInPaneArgs never emits --model / --request-priority / downtime-only flags', () => {
    const args = buildRunInPaneArgs('ls', '/c', 'n', true, 'a', '/p.json');
    for (const forbidden of ['--model', '--request-priority', '--reservation-ticket', '--local-preference']) {
      expect(args).not.toContain(forbidden);
    }
  });
});

// ── AC2: buildDowntimeSpawnOptions env pins ─────────────────────────────

describe('AC2 — buildDowntimeSpawnOptions spawn env', () => {
  it('detached/stdio/cwd shape plus HERDR_RESOLVED_CWD and AUDIT_PHASE2_PARALLELISM=1', () => {
    const options = buildDowntimeSpawnOptions('/repo');
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
    expect(options.cwd).toBe('/repo');
    expect(options.env.HERDR_RESOLVED_CWD).toBe('/repo');
    expect(options.env.AUDIT_PHASE2_PARALLELISM).toBe('1');
  });

  it('maps the candidate priority to HERDR_REQUEST_PRIORITY (downtime table, absent -> medium)', () => {
    expect(buildDowntimeSpawnOptions('/repo', { priority: undefined }).env[REQUEST_PRIORITY_ENV_VAR]).toBe('medium');
    expect(buildDowntimeSpawnOptions('/repo', { priority: null }).env[REQUEST_PRIORITY_ENV_VAR]).toBe('medium');
    expect(buildDowntimeSpawnOptions('/repo', { priority: 'low' }).env[REQUEST_PRIORITY_ENV_VAR]).toBe('low');
    expect(buildDowntimeSpawnOptions('/repo', { priority: 'medium' }).env[REQUEST_PRIORITY_ENV_VAR]).toBe('medium');
    expect(buildDowntimeSpawnOptions('/repo', { priority: 'high' }).env[REQUEST_PRIORITY_ENV_VAR]).toBe('high');
    expect(buildDowntimeSpawnOptions('/repo', { priority: 'critical' }).env[REQUEST_PRIORITY_ENV_VAR]).toBe('high');
    // Unknown values fall back to the proxy default medium (fail-open).
    expect(buildDowntimeSpawnOptions('/repo', { priority: 'urgent' }).env[REQUEST_PRIORITY_ENV_VAR]).toBe('medium');
  });

  it('injects the reservation ticket and local preference env vars when granted', () => {
    const options = buildDowntimeSpawnOptions('/repo', {
      priority: 'high',
      reservationTicketId: 'tkt-1',
      localPreference: 'local-preferred',
    });
    expect(options.env[LOCAL_RESERVATION_TICKET_ENV]).toBe('tkt-1');
    expect(options.env[LOCAL_PREFERENCE_ENV_VAR]).toBe('local-preferred');
    expect(options.env[REQUEST_PRIORITY_ENV_VAR]).toBe('high');
    expect(options.env.HERDR_RESOLVED_CWD).toBe('/repo');
  });

  it('omits the ticket/preference vars when absent (fail-open: byte-identical env)', () => {
    const options = buildDowntimeSpawnOptions('/repo');
    expect(options.env[LOCAL_RESERVATION_TICKET_ENV]).toBeUndefined();
    expect(options.env[LOCAL_PREFERENCE_ENV_VAR]).toBeUndefined();
  });

  it('never inherits launcher-side pane-launch knobs (WL-0MVP643Q4007BZJ8)', () => {
    const saved = new Map<string, string | undefined>();
    for (const key of [LOCAL_PREFERENCE_ENV_VAR, LOCAL_RESERVATION_TICKET_ENV]) {
      saved.set(key, process.env[key]);
      process.env[key] = 'leaked-from-launcher';
    }
    try {
      const options = buildDowntimeSpawnOptions('/repo');
      expect(options.env[LOCAL_PREFERENCE_ENV_VAR]).toBeUndefined();
      expect(options.env[LOCAL_RESERVATION_TICKET_ENV]).toBeUndefined();
    } finally {
      for (const key of [LOCAL_PREFERENCE_ENV_VAR, LOCAL_RESERVATION_TICKET_ENV]) {
        const previous = saved.get(key);
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }
  });

  it('scrubs repository-override git vars from the inherited env (SA-0MUIZSXEY008NGR8)', () => {
    const saved = new Map<string, string | undefined>();
    for (const key of REPOSITORY_OVERRIDE_ENV_VARS) {
      saved.set(key, process.env[key]);
      process.env[key] = `/tmp/leaked/${key}`;
    }
    try {
      const options = buildDowntimeSpawnOptions('/repo');
      for (const key of REPOSITORY_OVERRIDE_ENV_VARS) {
        expect(options.env[key]).toBeUndefined();
      }
      expect(options.env.HERDR_RESOLVED_CWD).toBe('/repo');
    } finally {
      for (const key of REPOSITORY_OVERRIDE_ENV_VARS) {
        const previous = saved.get(key);
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }
  });

  it('scrubRepositoryOverrides removes only override vars and never mutates its input', () => {
    const input = {
      PATH: '/usr/bin',
      GIT_DIR: '/leak/.git',
      GIT_WORK_TREE: '/leak',
      HERDR_ENV: '1',
    };
    const cleaned = scrubRepositoryOverrides(input);
    expect(cleaned).toEqual({ PATH: '/usr/bin', HERDR_ENV: '1' });
    expect(input.GIT_DIR).toBe('/leak/.git');
    expect(input.GIT_WORK_TREE).toBe('/leak');
  });
});

// ── AC4: pane-label parsing — including the regex-validation divergence ──

describe('AC4 — canonical paneItemIdFromLabel (pane-label.ts, validated suffix parse)', () => {
  it('extracts the token after the LAST ` - `, trimmed', () => {
    expect(paneItemIdFromLabel('Downtime triggered implement Some item - WL-ABC')).toBe('WL-ABC');
    expect(paneItemIdFromLabel('Downtime triggered plan A - B - WL-XYZ')).toBe('WL-XYZ');
  });

  it('is regex-validated: a non-id suffix is NOT an id (the settled authoritative shape check)', () => {
    // The former `paneLabelItemId` returned these raw — the validated
    // canonical shape check is now authoritative for every consumer.
    expect(paneItemIdFromLabel('Downtime triggered implement Foo - not-an-id')).toBe('');
    expect(paneItemIdFromLabel('Downtime triggered implement Foo - WL-abc')).toBe('');
    expect(paneItemIdFromLabel('Downtime triggered implement Foo - 123')).toBe('');
  });

  it("returns '' for no separator, empty/whitespace suffix, empty/absent label", () => {
    // The settled single absent-convention ('' — the former null vs '' split
    // is retired, WL-0MWHWH1HV009C46C AC2).
    expect(paneItemIdFromLabel('Downtime intake')).toBe('');
    expect(paneItemIdFromLabel('Downtime triggered implement Foo - ')).toBe('');
    expect(paneItemIdFromLabel('')).toBe('');
    expect(paneItemIdFromLabel(undefined)).toBe('');
  });
});

describe('AC4 — the settled convention: every parser now shares one validated parse (WL-0MWHWH1HV009C46C)', () => {
  it('the dispatcher, the reaper and the budget decode agree everywhere (the former divergence is settled)', () => {
    // Valid suffix: all parsers agree on the id.
    const valid = 'Downtime triggered implement Foo - WL-ABC';
    expect(paneItemIdFromLabel(valid)).toBe('WL-ABC');
    expect(decodeBudgetPaneLabel(valid).itemId).toBe('WL-ABC');

    // Non-conforming suffix: the validated canonical parse wins — the former
    // unvalidated suffix-return (`paneLabelItemId`) and the budget decode's
    // raw-suffix itemId are both retired, so a pane whose label carries a
    // non-id token is treated as having NO item (budget: `no-work-item-id`).
    for (const suffix of ['not-an-id', 'WL-abc', '123']) {
      const label = `Downtime triggered implement Foo - ${suffix}`;
      expect(paneItemIdFromLabel(label)).toBe('');
      expect(decodeBudgetPaneLabel(label).itemId).toBeNull();
    }

    // No suffix: '' (canonical string convention) / null (the budget decode's
    // string|null contract — the same "no id" fact, adapted at the boundary).
    const none = 'Downtime triggered implement Foo';
    expect(paneItemIdFromLabel(none)).toBe('');
    expect(decodeBudgetPaneLabel(none).itemId).toBeNull();
  });

  it('isDowntimePaneLabel is the shared prefix predicate — no bare startsWith outside the canonical module (AC3)', () => {
    expect(isDowntimePaneLabel('Downtime triggered implement Foo - WL-1')).toBe(true);
    expect(isDowntimePaneLabel('Downtime intake')).toBe(true);
    expect(isDowntimePaneLabel('Manually triggered implement Foo - WL-1')).toBe(false);
    expect(isDowntimePaneLabel('')).toBe(false);
    expect(isDowntimePaneLabel(undefined)).toBe(false);
  });
});

describe('AC4 — paneKindFromLabel (case-insensitive keyword scan)', () => {
  it('derives the kind from the launcher keyword for every PANE_KINDS entry', () => {
    expect(paneKindFromLabel('Downtime triggered implement Foo - WL-1')).toBe('implement');
    expect(paneKindFromLabel('Downtime triggered risk-effort Foo - WL-1')).toBe('risk-effort');
    expect(paneKindFromLabel('Downtime triggered intake Foo - WL-1')).toBe('intake');
    expect(paneKindFromLabel('Downtime triggered audit Foo - WL-1')).toBe('audit');
    expect(paneKindFromLabel('Downtime triggered plan Foo - WL-1')).toBe('plan');
  });

  it('scans case-insensitively and tolerates UI decoration', () => {
    expect(paneKindFromLabel('🚫 Downtime triggered plan Foo - WL-1')).toBe('plan');
    expect(paneKindFromLabel('DOWNtime TRIGGERED IMPLEMENT X - WL-1')).toBe('implement');
    expect(paneKindFromLabel('Manually triggered implement Bar - CG-0XYZ')).toBe('implement');
  });

  it('matches on ANY substring occurrence (deliberate loose scan), first kind wins in PANE_KINDS order', () => {
    // `audit` precedes `plan` in PANE_KINDS, so both-keyword labels classify audit.
    expect(paneKindFromLabel('a plan for audits')).toBe('audit');
    // A title embedding the keyword still classifies.
    expect(paneKindFromLabel('Planning the migration schedule')).toBe('plan');
    expect(paneKindFromLabel('Intake form review')).toBe('intake');
  });

  it('returns unknown for unrelated/empty labels (fail-closed)', () => {
    expect(paneKindFromLabel('Work Items')).toBe('unknown');
    expect(paneKindFromLabel('bash')).toBe('unknown');
    expect(paneKindFromLabel('')).toBe('unknown');
  });
});
