/**
 * packages/herdr/src/downtime-worker.priority.test.ts — downtime dispatch
 * request priority and serial audit Phase 2
 * (test-first child WL-0MVF3Q0QQ0001I2P, parent WL-0MVE1NZ4J000H5NH, AC3/AC5).
 *
 * The LLM proxy retired its global fast/cheap mode in favour of a per-request
 * `X-Priority` header (`low|medium|high`, default `medium`). Downtime-dispatched
 * panes therefore convey the selected candidate's work-item priority to the
 * launched pi process as `HERDR_REQUEST_PRIORITY` (parent AC3), mapped with the
 * downtime table (fixed by the parent AC — must not be relaxed):
 *
 *   `low` → `low`, `medium` → `medium`, `high` → `high`,
 *   `critical` → `high`, unknown/absent → `medium`.
 *
 * Audit Phase 2 is fully SERIAL — `AUDIT_PHASE2_PARALLELISM` is always `'1'`
 * (producer decision Q2b, parent AC5). The mode-aware `DowntimeSpawnConfig`
 * plumbing (`mode`/`slotBudget`/`freeSlots`/`concurrentDispatchCap`) is
 * removed; free-slot dispatch gating is unchanged and out of scope here.
 *
 * Target surface pinned by these specs (implemented by
 * WL-0MVF3Q1ZB0038IPA and WL-0MVF3Q4X5001FOXV):
 *
 *   buildDowntimeSpawnOptions(cwd, { priority })
 *     `priority` is the selected `DowntimeCandidate.priority` (the raw
 *     work-item priority). The builder maps it through the downtime table and
 *     sets `HERDR_REQUEST_PRIORITY` beside `HERDR_RESOLVED_CWD`.
 *
 *   spawnDowntimePane(script, args, { cwd, priority }, spawnFn)
 *     forwards the selected candidate priority to the injectable spawn
 *     boundary so every downtime tier (audit, pane, implement) carries it.
 *
 * RED WITNESS. The mapping and the serial-Phase-2 contract are not implemented
 * yet, so the specs that pin them are committed under vitest's
 * `it.fails(...)` (expected-failure): the suite stays GREEN while the
 * assertions are RED — the repo's documented TDD pattern (see
 * `packages/herdr/src/downtime-worker.assignee-claim.test.ts`). The
 * implementation children flip each `it.fails` to `it` as the behaviour lands.
 *
 * Run: npx vitest run packages/herdr/src/downtime-worker.priority.test.ts
 */

import { describe, it, expect, vi } from 'vitest';

import {
  buildDowntimeSpawnOptions,
  spawnDowntimePane,
  type DowntimeSpawn,
} from './downtime-worker.js';

/** The proxy's request-priority alphabet (fixed wire contract). */
type RequestPriority = 'low' | 'medium' | 'high';

/** Target options shape of `buildDowntimeSpawnOptions` (declared locally). */
interface DowntimeSpawnOptionsInput {
  /** Selected `DowntimeCandidate.priority` (raw work-item priority). */
  priority?: string | null;
}

type SpawnOptionsArg = Parameters<typeof buildDowntimeSpawnOptions>[1];

/**
 * Call the builder through an explicit target-shape cast so this file
 * type-checks both before (legacy `config` shape) and after (priority shape)
 * the sibling implementation children land.
 */
function spawnOptionsFor(priority?: string | null): DowntimeSpawnOptionsInput {
  return priority === undefined ? {} : { priority };
}

function buildOptions(
  priority?: string | null,
  cwd = '/repo',
): ReturnType<typeof buildDowntimeSpawnOptions> {
  return buildDowntimeSpawnOptions(
    cwd,
    spawnOptionsFor(priority) as SpawnOptionsArg,
  );
}

/**
 * The removed mode-aware plumbing, passed through `unknown` so the spec keeps
 * running (and stays meaningful) once `DowntimeSpawnConfig` is deleted: the
 * behaviour under test is that this input has NO effect.
 */
function legacySpawnConfig(config: Record<string, unknown>): SpawnOptionsArg {
  return { config } as unknown as SpawnOptionsArg;
}

// ── Downtime request-priority mapping (parent AC3) ───────────────────────

describe('downtime request-priority env (WL-0MVF3Q0QQ0001I2P AC1)', () => {
  const cases: Array<[string, RequestPriority]> = [
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['critical', 'high'],
  ];

  for (const [candidatePriority, expected] of cases) {
    it.fails(
      `maps candidate priority '${candidatePriority}' to request priority '${expected}'`,
      () => {
        const options = buildOptions(candidatePriority);
        expect(options.env.HERDR_REQUEST_PRIORITY).toBe(expected);
      },
    );
  }

  it.fails('maps an unknown/absent candidate priority to medium (downtime default)', () => {
    expect(buildOptions(undefined).env.HERDR_REQUEST_PRIORITY).toBe('medium');
    expect(buildOptions(null).env.HERDR_REQUEST_PRIORITY).toBe('medium');
    expect(buildOptions('').env.HERDR_REQUEST_PRIORITY).toBe('medium');
    expect(buildOptions('unrecognised').env.HERDR_REQUEST_PRIORITY).toBe('medium');
  });

  it('keeps the resolved cwd alongside the request priority', () => {
    // Regression guard for the env beside which the priority is added: the
    // pane must still open in the right project root.
    const options = buildOptions('low', '/some/repo');
    expect(options).toEqual(
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        cwd: '/some/repo',
      }),
    );
    expect(options.env.HERDR_RESOLVED_CWD).toBe('/some/repo');
  });
});

// ── Priority plumbing to the spawn boundary (parent AC3) ─────────────────

describe('downtime spawn boundary receives the candidate priority (WL-0MVF3Q0QQ0001I2P AC1)', () => {
  it('forwards the selected candidate priority to the injected spawn', async () => {
    const handle = {
      unref: vi.fn(),
      once: vi.fn((event: string, listener: (arg: unknown) => void) => {
        if (event === 'exit') listener(0);
      }),
    };
    const spawnFn = vi.fn(() => handle) as unknown as DowntimeSpawn;
    const opts = {
      cwd: '/repo',
      priority: 'critical',
    } as unknown as Parameters<typeof spawnDowntimePane>[2];

    await spawnDowntimePane('/path/to/send-to-pi.sh', [], opts, spawnFn);

    expect(spawnFn).toHaveBeenCalledWith('/path/to/send-to-pi.sh', [], opts);
  });
});

// ── Serial audit Phase 2 (parent AC5) ────────────────────────────────────

describe('serial audit Phase 2 (WL-0MVF3Q0QQ0001I2P AC2)', () => {
  it('is always "1" with no configuration', () => {
    expect(buildDowntimeSpawnOptions('/repo').env.AUDIT_PHASE2_PARALLELISM).toBe('1');
    expect(buildOptions('critical').env.AUDIT_PHASE2_PARALLELISM).toBe('1');
  });

  it.fails(
    'ignores the removed mode-aware plumbing (cheap mode with free slots stays serial)',
    () => {
      // Before AC5 the cheap-mode/free-slot combination selected '2'. The
      // producer decision fixes Phase 2 at '1' regardless of any such input.
      const legacyInputs: Array<Record<string, unknown>> = [
        // The historic '2' case: cheap mode, both slots genuinely free,
        // single-flight dispatch.
        { mode: 'cheap', slotBudget: 2, freeSlots: 2, concurrentDispatchCap: 1 },
        { mode: 'cheap', slotBudget: 2, freeSlots: 2, concurrentDispatchCap: 0 },
        { mode: 'cheap', slotBudget: 3, freeSlots: 3, concurrentDispatchCap: 1 },
        { mode: 'fast', slotBudget: 3, freeSlots: 3, concurrentDispatchCap: 1 },
      ];

      for (const config of legacyInputs) {
        const options = buildDowntimeSpawnOptions('/repo', legacySpawnConfig(config));
        expect(options.env.AUDIT_PHASE2_PARALLELISM).toBe('1');
      }
    },
  );
});
