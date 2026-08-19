/**
 * packages/herdr/src/downtime-round-robin.ts — Shared round-robin cursor registry
 *
 * Parent: WL-0MSSRED76008LGB6 (Downtime dispatcher: priority-first selection
 * with round-robin tie-break across instances + jittered probes)
 *
 * Provides a shared, durable round-robin cursor for downtime dispatch
 * selection. Fail-open read/write helpers for `.worklog/downtime-round-robin.json`.
 *
 * All operations are fail-open: missing file, unreadable file, or corrupt
 * JSON → default to no rotation (cursor=0).
 *
 * File format: `{ "audit": { "cursor": 0, "version": 1 }, "implement": { ... }, ... }`
 *
 * Fail-closed conventions preserved: the round-robin cursor never weakens
 * the existing dispatched-marker exclusion or the CAS claim.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Constants ───────────────────────────────────────────────────────────

/** Round-robin cursor file name (inside the worklog directory). */
export const ROUND_ROBIN_FILE_NAME = 'downtime-round-robin.json';

/** Jitter fraction range: rng output 0.0 → −50% (0.5×), 1.0 → +50% (1.5×). */
const JITTER_FRACTION_MIN = 0.0;
const JITTER_FRACTION_MAX = 1.0;

/** Nominal jitter center (rng = 0.5 → 0% jitter → exact poll interval). */
export const DEFAULT_JITTER_FRACTION = 0.5;

// ── Types ──────────────────────────────────────────────────────────────

/** A tier name for round-robin grouping. */
export type PriorityTier = 'audit' | 'implement' | 'plan' | 'intake' | string;

/** Internal cursor entry. */
interface CursorEntry {
  cursor: number;
  version: number;
}

/** Full round-robin file content. */
interface RoundRobinFile {
  [tier: string]: CursorEntry;
}

/** RNG function: returns a value in [0, 1]. */
export type RngFn = () => number;

/** Round-robin registry interface. */
export interface RoundRobinRegistry {
  /** Load cursor for a tier. Returns 0 on missing/corrupt file. */
  loadCursor(tier: PriorityTier): number;

  /** Advance cursor: returns next cursor value and persists it. */
  advanceCursor(tier: PriorityTier, groupSize: number): number;

  /** Calculate effective poll interval with jitter. */
  getEffectivePollInterval(baseIntervalMs: number, rngOverride?: RngFn): number;

  /** Close the registry (cleanup resources). */
  close(): void;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Default RNG: Math.random(). */
function defaultRng(): number {
  return Math.random();
}

/** Read and parse the round-robin file. Returns empty object on failure. */
function loadRoundRobinFile(worklogDir: string): RoundRobinFile {
  try {
    const filePath = path.join(worklogDir, ROUND_ROBIN_FILE_NAME);
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.trim()) return {};
    return JSON.parse(content) as RoundRobinFile;
  } catch {
    // Fail-open: missing, unreadable, or corrupt file → empty
    return {};
  }
}

/** Atomically write the round-robin file (write to temp → rename). */
function saveRoundRobinFile(worklogDir: string, data: RoundRobinFile): void {
  try {
    const filePath = path.join(worklogDir, ROUND_ROBIN_FILE_NAME);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Fail-open: write failure is tolerated
  }
}

/** Get the cursor for a tier, creating it if missing. */
function getOrCreateCursor(data: RoundRobinFile, tier: PriorityTier): CursorEntry {
  if (!data[tier]) {
    data[tier] = { cursor: 0, version: 1 };
  }
  return data[tier];
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Create a round-robin registry.
 *
 * @param options - Registry configuration
 * @param options.worklogDir - Path to the worklog directory
 * @param options.rng - RNG function (default: Math.random())
 * @returns A RoundRobinRegistry instance
 */
export function createRoundRobinRegistry(options: {
  worklogDir: string;
  rng?: RngFn;
}): RoundRobinRegistry {
  const { worklogDir, rng = defaultRng } = options;

  // Load current state
  const fileData = loadRoundRobinFile(worklogDir);

  let closed = false;

  return {
    /**
     * Load cursor for a tier.
     * Returns 0 when file is missing, unreadable, or cursor missing.
     */
    loadCursor(tier: PriorityTier): number {
      if (closed) return 0;
      const entry = getOrCreateCursor(fileData, tier);
      return entry.cursor;
    },

    /**
     * Advance cursor for a tier. Returns the index of the selected item (cursor % groupSize).
     * The internal cursor is incremented by 1 and persisted.
     * @param tier - Priority tier (audit/implement/plan/intake)
     * @param groupSize - Number of items in the priority group
     * @returns The index of the selected item (0 to groupSize-1)
     */
    advanceCursor(tier: PriorityTier, groupSize: number): number {
      if (closed) return 0;
      const entry = getOrCreateCursor(fileData, tier);
      const selected = entry.cursor % groupSize;
      entry.cursor += 1;
      entry.version += 1;
      saveRoundRobinFile(worklogDir, fileData);
      return selected;
    },

    /**
     * Calculate effective poll interval with jitter.
     * Jitter is ±50% of the base interval.
     * @param baseIntervalMs - Base poll interval in milliseconds
     * @param rngOverride - Optional RNG override for testing
     * @returns Effective poll interval (clamped to [0.5×, 1.5×] base)
     */
    getEffectivePollInterval(baseIntervalMs: number, rngOverride?: RngFn): number {
      if (closed) return baseIntervalMs;
      const r = (rngOverride ?? rng)();
      // Clamp to [0, 1]
      const clampedRng = Math.max(JITTER_FRACTION_MIN, Math.min(JITTER_FRACTION_MAX, r));
      // Jitter fraction: 0.0 → 0.5×, 0.5 → 1.0×, 1.0 → 1.5×
      const factor = 0.5 + clampedRng;
      return Math.round(baseIntervalMs * factor);
    },

    /** Close the registry. */
    close(): void {
      closed = true;
    },
  };
}
