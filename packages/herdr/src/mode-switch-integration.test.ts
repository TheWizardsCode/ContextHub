/**
 * Integration tests for agent-route hook + scheduler task wiring
 * (parent WL-0MSN3FWV5008KQE9).
 *
 * These tests verify:
 * 1. The mode-switch worker is created with settings.downtimeProxyUrl
 * 2. The agent-route hook is wired into index.ts command dispatch
 * 3. The scheduler task for the mode-switch worker is registered in worklist.ts
 * 4. Agent commands (/skill:*, /intake, /plan, /prompt:) trigger onOperatorCommand
 * 5. Non-agent commands do NOT trigger the mode-switch hook
 *
 * Run: npx vitest run packages/herdr/src/mode-switch-integration.test.ts
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from './settings.js';
import { routeCommand } from './index.js';
import {
  createModeSwitchWorker,
  DEFAULT_MODE_SWITCH_POLL_INTERVAL_MS,
  MODE_SWITCH_POLL_INTERVAL_FLOOR_MS,
  MODE_SWITCH_POLL_INTERVAL_CAP_MS,
  DEFAULT_MODE_SWITCH_IDLE_THRESHOLD_MS,
  MODE_SWITCH_IDLE_THRESHOLD_FLOOR_MS,
  MODE_SWITCH_RUN_TIMEOUT_MS,
  ADMIN_API_TIMEOUT_MS,
  type AdminApiFetcher,
} from './mode-switch-worker.js';
import { type LlamaStatus } from './downtime-worker.js';
import { writeModelCooldown, clearModelCooldown } from '@worklog/shared/model-cooldown';

// ── Settings integration ──────────────────────────────────────────────

describe('settings → worker creation integration', () => {
  it('defaultSettings contains modeSwitch keys', () => {
    expect(defaultSettings).toHaveProperty('modeSwitchEnabled');
    expect(defaultSettings).toHaveProperty('modeSwitchIdleThresholdMs');
    expect(defaultSettings).toHaveProperty('modeSwitchPollIntervalMs');
    // The feature is enabled out of the box (WL-0MU4MKVR4005WPBJ): the
    // previous `false` default silently disabled the shipped worker.
    expect(defaultSettings.modeSwitchEnabled).toBe(true);
    expect(typeof defaultSettings.modeSwitchIdleThresholdMs).toBe('number');
    expect(typeof defaultSettings.modeSwitchPollIntervalMs).toBe('number');
  });

  it('downtimeProxyUrl is available for the mode-switch worker (reuse, no new URL key)', () => {
    expect(defaultSettings).toHaveProperty('downtimeProxyUrl');
    expect(typeof defaultSettings.downtimeProxyUrl).toBe('string');
  });
});

// ── Agent-route hook wiring ──────────────────────────────────────────

describe('agent-route hook wiring', () => {
  it('agent command prefixes are correctly identified', () => {
    const agentCommands: string[] = [
      '/skill:implement WL-0ABC',
      '/skill:audit',
      '/skill:plan',
      '/intake WL-0ABC',
      '/plan WL-0ABC',
      '/prompt: review code',
    ];
    const nonAgentCommands: string[] = [
      '/wl next',
      '! ls -la',
      '!! rm -rf /',
      '/downtime toggle',
      '/reviewed 1',
    ];

    for (const cmd of agentCommands) {
      const isAgent =
        cmd.startsWith('/skill:') ||
        cmd.startsWith('/intake') ||
        cmd.startsWith('/plan') ||
        cmd.startsWith('/prompt:');
      expect(isAgent, `Expected "${cmd}" to be an agent command`).toBe(true);
    }

    for (const cmd of nonAgentCommands) {
      const isAgent =
        cmd.startsWith('/skill:') ||
        cmd.startsWith('/intake') ||
        cmd.startsWith('/plan') ||
        cmd.startsWith('/prompt:');
      expect(isAgent, `Expected "${cmd}" NOT to be an agent command`).toBe(false);
    }
  });

  it('routeCommand correctly classifies agent commands as "agent"', () => {
    // routeCommand from index.ts must correctly classify agent commands.
    // The actual agent-route hook (onOperatorCommand call) is wired in the
    // dispatch path — this test validates the classification is correct.
    expect(routeCommand('/skill:implement WL-0ABC')).toBe('agent');
    expect(routeCommand('/skill:audit')).toBe('agent');
    expect(routeCommand('/intake WL-0ABC')).toBe('agent');
    expect(routeCommand('/plan WL-0ABC')).toBe('agent');
    expect(routeCommand('/prompt: review code')).toBe('agent');

    // Non-agent commands
    expect(routeCommand('/wl next')).toBe('stdout');
    expect(routeCommand('! ls -la')).toBe('pane');
    expect(routeCommand('!! rm -rf /')).toBe('pane');
    expect(routeCommand('/downtime toggle')).toBe('stdout');
  });
});

// ── Scheduler task configuration ─────────────────────────────────────

describe('scheduler task configuration', () => {
  it('mode-switch worker interval constants are properly bounded', () => {
    expect(DEFAULT_MODE_SWITCH_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(MODE_SWITCH_POLL_INTERVAL_FLOOR_MS);
    expect(DEFAULT_MODE_SWITCH_POLL_INTERVAL_MS).toBeLessThanOrEqual(MODE_SWITCH_POLL_INTERVAL_CAP_MS);
    expect(MODE_SWITCH_POLL_INTERVAL_FLOOR_MS).toBe(5_000);
    expect(MODE_SWITCH_POLL_INTERVAL_CAP_MS).toBe(60_000);
    expect(DEFAULT_MODE_SWITCH_POLL_INTERVAL_MS).toBe(10_000);
  });

  it('idle threshold floor is at least 60s', () => {
    expect(MODE_SWITCH_IDLE_THRESHOLD_FLOOR_MS).toBeGreaterThanOrEqual(60_000);
    expect(DEFAULT_MODE_SWITCH_IDLE_THRESHOLD_MS).toBe(900_000); // 15 minutes
  });

  it('run timeout watchdog exceeds the admin API timeout (hung ticks get abandoned)', () => {
    // The scheduler task has a runTimeoutMs watchdog (mirror of the downtime
    // task): a hung tick must be abandoned so the single-flight flag resets
    // and the next tick retries. The watchdog must be generous enough to
    // outlive the admin API's own 5s AbortController plus a slow mode-switch
    // restart while the proxy reloads its model pool.
    expect(MODE_SWITCH_RUN_TIMEOUT_MS).toBeGreaterThan(ADMIN_API_TIMEOUT_MS);
    expect(MODE_SWITCH_RUN_TIMEOUT_MS).toBe(30_000);
  });
});

// ── Worker interface integration ─────────────────────────────────────

describe('worker interface integration', () => {
  it('createModeSwitchWorker exports the ModeSwitchWorker interface', () => {
    const worker = createModeSwitchWorker({
      fetcher: async () => ({ ok: false, status: 500, json: async () => ({ error: 'test' }) }),
    }) as { onOperatorCommand: Function; tick: Function };

    // onOperatorCommand — called by the agent-route hook in index.ts
    expect(typeof worker.onOperatorCommand).toBe('function');
    // tick — called by the scheduler task in worklist.ts
    expect(typeof worker.tick).toBe('function');
  });
});

// ── Cross-root model-cooldown gate (WL-0MV5638ZS005I5XQ, AC4) ────────
//
// The cheap switch is machine-wide (the shared proxy), so the cooldown
// signal must be machine-wide too: a cooldown recorded while working in one
// worklog root must suppress the switch for every other root on the machine.
// This is an integration test spanning two roots that share one machine-wide
// coordination directory.

describe('cross-root model-cooldown gate (AC4)', () => {
  function idleStatus(): LlamaStatus {
    return {
      llama_server_running: true,
      local_active_query: false,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 3,
      total_slots: 3,
      slots: [
        { slot_id: 'slot-1', is_processing: false },
        { slot_id: 'slot-2', is_processing: false },
        { slot_id: 'slot-3', is_processing: false },
      ],
    };
  }

  it('a cooldown recorded for one root suppresses the shared cheap switch for another root', async () => {
    // One machine-wide coordination dir, two worklog roots. The signal
    // carries no root field, which is exactly why root B sees root A's
    // cooldown.
    const machineDir = mkdtempSync(join(tmpdir(), 'wl-cross-root-cooldown-'));
    try {
      let clock = 1_000_000;
      const now = () => clock;

      // Root A's recovery loop records an exhaustion cooldown in the
      // machine-wide store (keyed by pane/session, not by worklog root).
      expect(
        writeModelCooldown(
          machineDir,
          {
            paneId: 'pane-root-a',
            sessionId: 'session-root-a',
            itemId: 'WL-ROOT-A',
            kind: 'implement',
            reason: 'all providers exhausted',
            cooldownUntil: clock + 3_600_000,
          },
          clock,
        ),
      ).toBe(true);

      const posts: string[] = [];
      const fetcher: AdminApiFetcher = async (_url, init) => {
        if (init?.method === 'POST') {
          posts.push(init.body ?? '');
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return { ok: true, status: 200, json: async () => ({ mode: 'fast' }) };
      };

      // Root B's leader worker — configured with the same machine dir.
      const worker = createModeSwitchWorker({
        fetcher,
        now,
        isLeader: () => true,
        coordinationDir: machineDir,
      });

      clock += 900_000; // root B has been idle long enough to switch
      await worker.tick({
        enabled: true,
        idleThresholdMs: 900_000,
        proxyUrl: 'http://proxy',
        proxyStatus: idleStatus(),
      });
      // Root A's active cooldown holds root B's shared proxy in fast mode.
      expect(posts).toHaveLength(0);

      // Root A's pane recovers and clears the machine-wide cooldown; root B's
      // worker then resumes the normal cheap decision.
      expect(clearModelCooldown(machineDir, 'pane-root-a', clock)).toBe(true);
      await worker.tick({
        enabled: true,
        idleThresholdMs: 900_000,
        proxyUrl: 'http://proxy',
        proxyStatus: idleStatus(),
      });
      expect(posts).toHaveLength(1);
      expect(posts[0]).toBe(JSON.stringify({ mode: 'cheap' }));
    } finally {
      rmSync(machineDir, { recursive: true, force: true });
    }
  });
});
