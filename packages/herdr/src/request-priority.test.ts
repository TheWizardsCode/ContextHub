/**
 * packages/herdr/src/request-priority.test.ts — herdr-side request-priority
 * contract (test-first child WL-0MVF3PYO3000EVJ3, parent WL-0MVE1NZ4J000H5NH).
 *
 * The LLM proxy retired its global fast/cheap mode in favour of a per-request
 * `X-Priority` header (`low|medium|high`, default `medium`). Herdr therefore
 * maps a dispatched work item's priority onto a *request* priority and conveys
 * it to the launched process as `HERDR_REQUEST_PRIORITY` (parent AC2/AC3).
 *
 * This file pins the two mapping tables, which are fixed by the parent ACs and
 * must not be relaxed:
 *
 *   Interactive — `low` → `medium`, `medium`/`high`/`critical` → `high`,
 *                 and no resolvable item (absent/unknown) → `high`.
 *   Downtime    — `low`/`medium`/`high` unchanged, `critical` → `high`,
 *                 unknown/absent → `medium`.
 *
 * Fail-open is mandatory: a lookup failure or timeout must never abort a
 * dispatch — it falls back to the interactive default (`high`).
 *
 * RED WITNESS. `request-priority.ts` does not exist yet, so every spec below
 * asserts the post-implementation behaviour and is committed with
 * `it.fails(...)` — the suite stays GREEN while the assertions are RED (the
 * repo's documented TDD pattern, see
 * `packages/herdr/src/downtime-worker.assignee-claim.test.ts`). The
 * implementation child WL-0MVF3Q3VL000UNCN flips each `it.fails` to `it` once
 * `request-priority.ts` lands. The module is imported dynamically (via a
 * non-literal specifier) so the missing module fails the *test body* rather
 * than breaking the whole file at collection time — that is what lets the
 * expected-failure form work before the module exists.
 *
 * Run: npx vitest run packages/herdr/src/request-priority.test.ts
 */

import { describe, it, expect, vi } from 'vitest';

/** The proxy's request-priority alphabet (fixed wire contract). */
type RequestPriority = 'low' | 'medium' | 'high';

/**
 * Target surface of `request-priority.ts` (declared here rather than imported
 * so this test-first file type-checks and runs before the module exists).
 */
interface RequestPriorityModule {
  /** Interactive dispatch mapping (parent AC2). */
  mapInteractiveRequestPriority(workItemPriority?: string | null): RequestPriority;
  /** Downtime dispatch mapping (parent AC3). */
  mapDowntimeRequestPriority(priority?: string | null): RequestPriority;
  /**
   * Fail-open interactive resolution: look up a work item's priority and map
   * it. No id, a lookup failure or a timeout yields `high` (never throws).
   */
  resolveInteractiveRequestPriority(
    workItemId: string | undefined | null,
    lookup: (id: string) =>
      | string
      | null
      | undefined
      | Promise<string | null | undefined>,
    timeoutMs?: number,
  ): Promise<RequestPriority>;
}

/** Non-literal specifier: keeps `tsc` from resolving the not-yet-created module. */
const MODULE_SPECIFIER = './request-priority.js';

async function loadModule(): Promise<RequestPriorityModule> {
  return (await import(MODULE_SPECIFIER)) as unknown as RequestPriorityModule;
}

// ── Interactive mapping table (parent AC2) ───────────────────────────────

describe('interactive request-priority mapping (WL-0MVF3PYO3000EVJ3 AC1)', () => {
  const cases: Array<[string, RequestPriority]> = [
    ['low', 'medium'],
    ['medium', 'high'],
    ['high', 'high'],
    ['critical', 'high'],
  ];

  for (const [workItemPriority, expected] of cases) {
    it.fails(`maps work-item '${workItemPriority}' to request '${expected}'`, async () => {
      const { mapInteractiveRequestPriority } = await loadModule();
      expect(mapInteractiveRequestPriority(workItemPriority)).toBe(expected);
    });
  }

  it.fails('maps an absent work-item priority to high (interactive default)', async () => {
    const { mapInteractiveRequestPriority } = await loadModule();
    expect(mapInteractiveRequestPriority(undefined)).toBe('high');
    expect(mapInteractiveRequestPriority(null)).toBe('high');
    expect(mapInteractiveRequestPriority('')).toBe('high');
  });

  it.fails('maps an unknown work-item priority to high (fail-safe, not throw)', async () => {
    const { mapInteractiveRequestPriority } = await loadModule();
    expect(mapInteractiveRequestPriority('unrecognised')).toBe('high');
  });
});

// ── Downtime mapping table (parent AC3) ──────────────────────────────────

describe('downtime request-priority mapping (WL-0MVF3PYO3000EVJ3 AC2)', () => {
  const cases: Array<[string, RequestPriority]> = [
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['critical', 'high'],
  ];

  for (const [workItemPriority, expected] of cases) {
    it.fails(`maps work-item '${workItemPriority}' to request '${expected}'`, async () => {
      const { mapDowntimeRequestPriority } = await loadModule();
      expect(mapDowntimeRequestPriority(workItemPriority)).toBe(expected);
    });
  }

  it.fails('maps an unknown/absent priority to medium (downtime default)', async () => {
    const { mapDowntimeRequestPriority } = await loadModule();
    expect(mapDowntimeRequestPriority(undefined)).toBe('medium');
    expect(mapDowntimeRequestPriority(null)).toBe('medium');
    expect(mapDowntimeRequestPriority('')).toBe('medium');
    expect(mapDowntimeRequestPriority('unrecognised')).toBe('medium');
  });
});

// ── Fail-open interactive resolution (parent AC2) ────────────────────────

describe('resolveInteractiveRequestPriority — fail-open resolution (WL-0MVF3PYO3000EVJ3 AC1)', () => {
  it.fails('maps the looked-up work-item priority through the interactive table', async () => {
    const { resolveInteractiveRequestPriority } = await loadModule();
    const lookup = vi.fn(() => 'low');
    await expect(resolveInteractiveRequestPriority('WL-1', lookup)).resolves.toBe('medium');

    const lookupCritical = vi.fn(() => 'critical');
    await expect(resolveInteractiveRequestPriority('WL-2', lookupCritical)).resolves.toBe('high');
  });

  it.fails('defaults to high and never looks up when there is no work-item id', async () => {
    const { resolveInteractiveRequestPriority } = await loadModule();
    const lookup = vi.fn(() => 'low');

    await expect(resolveInteractiveRequestPriority(undefined, lookup)).resolves.toBe('high');
    await expect(resolveInteractiveRequestPriority('', lookup)).resolves.toBe('high');

    expect(lookup).not.toHaveBeenCalled();
  });

  it.fails('defaults to high when the lookup returns nothing', async () => {
    const { resolveInteractiveRequestPriority } = await loadModule();
    await expect(
      resolveInteractiveRequestPriority('WL-1', () => undefined),
    ).resolves.toBe('high');
  });

  it.fails('defaults to high when the lookup fails (throws)', async () => {
    const { resolveInteractiveRequestPriority } = await loadModule();
    await expect(
      resolveInteractiveRequestPriority('WL-1', () => {
        throw new Error('wl show failed');
      }),
    ).resolves.toBe('high');
  });

  it.fails('defaults to high when the lookup times out (dispatch still proceeds)', async () => {
    const { resolveInteractiveRequestPriority } = await loadModule();
    const hangingLookup = () => new Promise<string | undefined>(() => {});
    await expect(
      resolveInteractiveRequestPriority('WL-1', hangingLookup, 10),
    ).resolves.toBe('high');
  });
});
