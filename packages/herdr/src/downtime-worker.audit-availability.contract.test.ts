/**
 * packages/herdr/src/downtime-worker.audit-availability.contract.test.ts —
 * contract tests for the proxy audit-availability wire read (parent
 * WL-0MW95GBEG005ERHS, child WL-0MWAMS1PW000O3OS).
 *
 * The proxy endpoint does not exist yet (sibling llm item
 * LP-0MW95FYMH006XYNK; probed 2026-11-10 — every `/llama/local/audit*` path
 * answers `404`). These fixtures therefore PIN the client-side contract before
 * the server lands, exactly as the reserve-handshake slice C1 did:
 *
 *   - a usable payload maps to `{ cap, live, available, leases?, reclaimed? }`,
 *   - the alias spellings the proxy has not fixed yet parse to the same typed
 *     result, and additive extra fields are ignored,
 *   - `available` is the proxy's OWN field — never derived from cap/live,
 *   - EVERY unusable payload is `null` (a garbage body can never be read as
 *     "available"),
 *   - no production dispatch path imports the parser yet (no behaviour change).
 *
 * Traceability: each case cites the work-item AC it serves.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  AUDIT_BUDGET_SATURATED_REASON,
  AUDIT_BUDGET_UNKNOWN_REASON,
  parseAuditAvailabilityResponse,
  type AuditAvailability,
} from './downtime-worker.audit-availability.contract.js';
import { AUDIT_AVAILABILITY_PATH } from './downtime-worker.constants.js';
import {
  AUDIT_BUDGET_SATURATED_REASON as BARREL_REASON,
  AUDIT_BUDGET_UNKNOWN_REASON as BARREL_UNKNOWN_REASON,
  parseAuditAvailabilityResponse as barrelParse,
} from './downtime-worker.js';

const here = dirname(fileURLToPath(import.meta.url));

// ── AC1: the provisional path is pinned in the constants module ────────

describe('AUDIT_AVAILABILITY_PATH (AC1)', () => {
  it('pins the documented provisional path', () => {
    expect(AUDIT_AVAILABILITY_PATH).toBe('/llama/local/audit/status');
  });

  it('is re-exported from the downtime-worker barrel', () => {
    // The client child (WL-0MWAMSCOP003R837) imports the constant here.
    expect(AUDIT_AVAILABILITY_PATH).toMatch(/^\/llama\/local\/audit/);
  });
});

// ── AC2–AC4: the table-driven parse contract ──────────────────────────

interface ParseCase {
  /** Case name — states the rule, not the fixture. */
  name: string;
  /** Raw response body. */
  raw: unknown;
  /** Expected typed result (or `null` when unusable). */
  expected: AuditAvailability | null;
}

const CASES: readonly ParseCase[] = [
  // ── AC2: a usable payload maps to the typed result ──────────────────
  {
    name: 'grant: cap/live/available map verbatim',
    raw: { cap: 2, live: 0, available: true },
    expected: { cap: 2, live: 0, available: true },
  },
  {
    name: 'saturated: the proxy verdict and its refusal token are preserved',
    raw: { cap: 1, live: 1, available: false, reason: AUDIT_BUDGET_SATURATED_REASON },
    expected: { cap: 1, live: 1, available: false, reason: AUDIT_BUDGET_SATURATED_REASON },
  },
  {
    name: 'detail: live leases carry their expiry and a reclaimed count is preserved',
    raw: {
      cap: 3,
      live: 2,
      available: false,
      reclaimed: 1,
      leases: [
        { id: 'lease-a', expires_at: 1_760_000_000_000 },
        { lease_id: 'lease-b', expires_at_ms: 1_760_000_060_000 },
        { owner: 'pane-1', expiry: '2026-11-10T12:00:00.000Z' },
      ],
    },
    expected: {
      cap: 3,
      live: 2,
      available: false,
      reclaimed: 1,
      leases: [
        { id: 'lease-a', expiresAt: 1_760_000_000_000 },
        { id: 'lease-b', expiresAt: 1_760_000_060_000 },
        { id: 'pane-1', expiresAt: Date.parse('2026-11-10T12:00:00.000Z') },
      ],
    },
  },
  {
    name: 'absent lease array leaves leases undefined',
    raw: { cap: 2, live: 1, available: true, leases: undefined },
    expected: { cap: 2, live: 1, available: true },
  },
  {
    name: 'empty lease array is carried as an empty array',
    raw: { cap: 2, live: 0, available: true, leases: [] },
    expected: { cap: 2, live: 0, available: true, leases: [] },
  },
  {
    name: 'reason is open vocabulary (an unrecognised token is preserved)',
    raw: { cap: 1, live: 1, available: false, reason: 'queue-full' },
    expected: { cap: 1, live: 1, available: false, reason: 'queue-full' },
  },

  // ── AC3: documented aliases map to the SAME typed result ────────────
  {
    name: 'alias: cap/max, live/in_flight, available/can_admit',
    raw: { max: 4, in_flight: 1, can_admit: true },
    expected: { cap: 4, live: 1, available: true },
  },
  {
    name: 'alias: cap/max_audit, live/live_leases, available/available',
    raw: { max_audit: 4, live_leases: 1, available: true },
    expected: { cap: 4, live: 1, available: true },
  },
  {
    name: 'alias: refusal_reason is read when reason is absent',
    raw: { cap: 1, live: 1, available: false, refusal_reason: AUDIT_BUDGET_SATURATED_REASON },
    expected: { cap: 1, live: 1, available: false, reason: AUDIT_BUDGET_SATURATED_REASON },
  },
  {
    name: 'additive evolution: an unrecognised extra field is ignored',
    raw: { cap: 2, live: 0, available: true, gpu_utilisation: 0.4, schema: 'v2' },
    expected: { cap: 2, live: 0, available: true },
  },

  // ── AC2: available is the proxy's field, never derived locally ──────
  {
    name: 'available=true is honoured even when live === cap',
    raw: { cap: 1, live: 1, available: true },
    expected: { cap: 1, live: 1, available: true },
  },
  {
    name: 'available=false is honoured even when live < cap',
    raw: { cap: 5, live: 0, available: false },
    expected: { cap: 5, live: 0, available: false },
  },

  // ── AC4: every unusable payload is null ─────────────────────────────
  { name: 'unusable: null body', raw: null, expected: null },
  { name: 'unusable: array body', raw: [], expected: null },
  { name: 'unusable: string body', raw: 'ok', expected: null },
  { name: 'unusable: number body', raw: 42, expected: null },
  { name: 'unusable: missing cap', raw: { live: 0, available: true }, expected: null },
  { name: 'unusable: missing live', raw: { cap: 1, available: true }, expected: null },
  { name: 'unusable: missing availability verdict', raw: { cap: 1, live: 0 }, expected: null },
  {
    name: 'unusable: non-finite cap',
    raw: { cap: Number.POSITIVE_INFINITY, live: 0, available: true },
    expected: null,
  },
  {
    name: 'unusable: NaN live',
    raw: { cap: 1, live: Number.NaN, available: true },
    expected: null,
  },
  { name: 'unusable: negative cap', raw: { cap: -1, live: 0, available: true }, expected: null },
  { name: 'unusable: negative live', raw: { cap: 1, live: -1, available: true }, expected: null },
  {
    name: 'unusable: non-boolean availability verdict',
    raw: { cap: 1, live: 0, available: 'yes' },
    expected: null,
  },
  {
    name: 'unusable: leases is not an array',
    raw: { cap: 1, live: 0, available: true, leases: {} },
    expected: null,
  },
  {
    name: 'unusable: leases is null',
    raw: { cap: 1, live: 0, available: true, leases: null },
    expected: null,
  },
  {
    name: 'unusable: a non-object lease entry',
    raw: { cap: 1, live: 0, available: true, leases: ['lease-a'] },
    expected: null,
  },
  {
    name: 'unusable: a lease with no usable expiry',
    raw: { cap: 1, live: 0, available: true, leases: [{ id: 'lease-a' }] },
    expected: null,
  },
  {
    name: 'unusable: negative reclaimed count',
    raw: { cap: 1, live: 0, available: true, reclaimed: -1 },
    expected: null,
  },
  {
    name: 'unusable: non-finite reclaimed count',
    raw: { cap: 1, live: 0, available: true, reclaimed: Number.NaN },
    expected: null,
  },
];

describe('parseAuditAvailabilityResponse (AC2–AC4)', () => {
  it.each(CASES)('$name', ({ raw, expected }) => {
    expect(parseAuditAvailabilityResponse(raw, 200)).toEqual(expected);
  });

  it.each([0, 199, 300, 404, 500])('unusable: non-2xx status %i', (status) => {
    expect(
      parseAuditAvailabilityResponse({ cap: 1, live: 0, available: true }, status),
    ).toBeNull();
  });

  it('never throws on a non-JSON object body', () => {
    // `typeof` guards keep the reader total for every value JSON can produce;
    // a non-JSON object (a Date) is simply unusable, never a thrown error.
    expect(() => parseAuditAvailabilityResponse(new Date(), 200)).not.toThrow();
    expect(parseAuditAvailabilityResponse(new Date(), 200)).toBeNull();
  });
});

// ── AC1/AC5: barrel wiring and no production dispatch consumer yet ────

describe('barrel wiring and contract pinning (AC1, AC5)', () => {
  it('re-exports the token and the parser from the downtime-worker barrel', () => {
    expect(BARREL_REASON).toBe(AUDIT_BUDGET_SATURATED_REASON);
    expect(BARREL_UNKNOWN_REASON).toBe(AUDIT_BUDGET_UNKNOWN_REASON);
    expect(barrelParse({ cap: 1, live: 0, available: true }, 200)).toEqual({
      cap: 1,
      live: 0,
      available: true,
    });
  });

  it('pins the audit refusal vocabulary to the proxy literal spellings (parent AC2)', () => {
    // One spelling shared with the proxy: a dispatcher admission and a proxy
    // refusal can never disagree because a local renaming drifted.
    expect(AUDIT_BUDGET_SATURATED_REASON).toBe('audit-budget-saturated');
    expect(AUDIT_BUDGET_UNKNOWN_REASON).toBe('audit-budget-unknown');
  });

  const CONTRACT_MODULE = 'downtime-worker.audit-availability.contract';
  /**
   * Files allowed to reference the contract module / its path constant. The
   * CLIENT is the contract's documented first consumer
   * (WL-0MWAMSCOP003R837); the audit gate (WL-0MWAMSDNW000SL0E) is the next.
   * The gate consumes the client and the tokens through the BARREL, so it
   * needs no direct-contract entry here — an accidental direct dispatch-path
   * consumer still fails.
   */
  const ALLOWED = new Set([
    `${CONTRACT_MODULE}.ts`,
    `${CONTRACT_MODULE}.test.ts`,
    'downtime-worker.ts', // the barrel re-export
    'downtime-worker.constants.ts', // declares AUDIT_AVAILABILITY_PATH
    'downtime-worker.audit-availability.ts', // the client (first consumer)
  ]);

  function productionSources(): string[] {
    return readdirSync(here)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .filter((name) => !ALLOWED.has(name));
  }

  it('is imported only by the pinned readers, not by a production dispatch module yet', () => {
    const importers = productionSources().filter((name) =>
      readFileSync(join(here, name), 'utf8').includes(`./${CONTRACT_MODULE}.js`),
    );
    expect(importers).toEqual([]);
  });

  it('has no production reader of AUDIT_AVAILABILITY_PATH outside the pinned client', () => {
    const readers = productionSources().filter((name) =>
      readFileSync(join(here, name), 'utf8').includes('AUDIT_AVAILABILITY_PATH'),
    );
    expect(readers).toEqual([]);
  });
});
