/**
 * Unit tests for packages/shared/src/model-cooldown.ts — the versioned,
 * machine-wide model-cooldown contract (WL-0MV563825002R9Y1).
 *
 * The module is the single source of truth for the on-disk cooldown signal
 * shared by the TUI recovery loop (writer) and the herdr dispatcher /
 * mode-switch worker (readers). These tests pin the contract:
 *
 *  - round trip: write → read → clear;
 *  - tolerance: unknown fields ignored, malformed entries skipped;
 *  - expiry: past `cooldownUntil` entries are inactive and pruned on write;
 *  - fail-closed reads: a missing file is `[]`, an unreadable/corrupt file is
 *    `null` (distinguished), and neither throws;
 *  - dir resolution: `HERDR_COORDINATION_DIR` override, `~` expansion and the
 *    default (`~/.herdr/downtime`).
 *
 * Run: npx vitest run packages/shared/src/model-cooldown.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  resolveMachineCoordinationDir,
  readModelCooldowns,
  writeModelCooldown,
  clearModelCooldown,
  MODEL_COOLDOWN_FILE,
  MODEL_COOLDOWN_SCHEMA_VERSION,
  DEFAULT_MACHINE_COORDINATION_DIR,
  type ModelCooldownEntry,
} from './model-cooldown.js';

// ── Fixtures ───────────────────────────────────────────────────────────

let dir: string;
const NOW = 1_700_000_000_000;

const originalEnv = process.env.HERDR_COORDINATION_DIR;

function rawFile(): string {
  return join(dir, MODEL_COOLDOWN_FILE);
}

function writeRaw(payload: unknown): void {
  writeFileSync(rawFile(), typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
}

function activeInput(overrides: Record<string, unknown> = {}): ModelCooldownEntry {
  return {
    paneId: 'pane-1',
    sessionId: 'session-1',
    itemId: 'WL-0MV563825002R9Y1',
    kind: 'implement',
    reason: 'all providers exhausted',
    createdAt: NOW,
    cooldownUntil: NOW + 30_000,
    ...overrides,
  } as ModelCooldownEntry;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'model-cooldown-'));
  delete process.env.HERDR_COORDINATION_DIR;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalEnv !== undefined) {
    process.env.HERDR_COORDINATION_DIR = originalEnv;
  } else {
    delete process.env.HERDR_COORDINATION_DIR;
  }
});

// ── resolveMachineCoordinationDir ──────────────────────────────────────

describe('resolveMachineCoordinationDir', () => {
  it('returns the absolute HERDR_COORDINATION_DIR override when set', () => {
    process.env.HERDR_COORDINATION_DIR = dir;
    expect(resolveMachineCoordinationDir()).toBe(dir);
  });

  it('expands a leading ~ in the override', () => {
    process.env.HERDR_COORDINATION_DIR = '~/custom-downtime';
    expect(resolveMachineCoordinationDir()).toBe(join(os.homedir(), 'custom-downtime'));
  });

  it('uses the ~/.herdr/downtime default when the override is unset', () => {
    expect(resolveMachineCoordinationDir()).toBe(
      join(os.homedir(), DEFAULT_MACHINE_COORDINATION_DIR),
    );
  });

  it('uses the default when the override is an empty string', () => {
    process.env.HERDR_COORDINATION_DIR = '';
    expect(resolveMachineCoordinationDir()).toBe(
      join(os.homedir(), DEFAULT_MACHINE_COORDINATION_DIR),
    );
  });

  it('returns null when neither the override nor the default resolve', () => {
    const savedHome = process.env.HOME;
    process.env.HOME = '';
    try {
      expect(resolveMachineCoordinationDir()).toBeNull();
    } finally {
      process.env.HOME = savedHome;
    }
  });
});

// ── Round trip ─────────────────────────────────────────────────────────

describe('write / read / clear round trip', () => {
  it('writes, reads back and clears a record by session id', () => {
    const entry = activeInput();
    expect(writeModelCooldown(dir, entry, NOW)).toBe(true);

    const read = readModelCooldowns(dir, NOW);
    expect(read).not.toBeNull();
    expect(read).toEqual([entry]);

    expect(clearModelCooldown(dir, 'session-1', NOW)).toBe(true);
    expect(readModelCooldowns(dir, NOW)).toEqual([]);
  });

  it('persists a versioned, machine-readable document', () => {
    writeModelCooldown(dir, activeInput(), NOW);
    const doc = JSON.parse(readFileSync(rawFile(), 'utf8'));
    expect(doc.schemaVersion).toBe(MODEL_COOLDOWN_SCHEMA_VERSION);
    expect(Array.isArray(doc.cooldowns)).toBe(true);
    expect(doc.cooldowns).toHaveLength(1);
    expect(doc.cooldowns[0].cooldownUntil).toBe(NOW + 30_000);
    expect(doc.cooldowns[0].paneId).toBe('pane-1');
    expect(doc.cooldowns[0].sessionId).toBe('session-1');
  });

  it('clears by pane id as well as session id', () => {
    writeModelCooldown(dir, activeInput({ paneId: 'pane-A', sessionId: 'sess-A' }), NOW);
    writeModelCooldown(dir, activeInput({ paneId: 'pane-B', sessionId: 'sess-B' }), NOW);

    expect(clearModelCooldown(dir, 'pane-A', NOW)).toBe(true);
    expect(readModelCooldowns(dir, NOW)?.map((e) => e.paneId)).toEqual(['pane-B']);
  });
});

// ── Tolerance ──────────────────────────────────────────────────────────

describe('tolerant reads', () => {
  it('ignores unknown fields on an otherwise valid entry', () => {
    writeRaw({
      schemaVersion: 1,
      cooldowns: [
        { paneId: 'p1', sessionId: 's1', cooldownUntil: NOW + 1000, unknownField: 'ignored' },
      ],
    });

    const entries = readModelCooldowns(dir, NOW);
    expect(entries).toHaveLength(1);
    expect(entries?.[0].paneId).toBe('p1');
    expect(entries?.[0]).not.toHaveProperty('unknownField');
  });

  it('skips malformed entries (missing cooldownUntil) without throwing', () => {
    writeRaw({
      schemaVersion: 1,
      cooldowns: [
        { paneId: 'no-until' },
        null,
        42,
        'string',
        { sessionId: 's-valid', cooldownUntil: NOW + 5 },
      ],
    });

    const entries = readModelCooldowns(dir, NOW);
    expect(entries).toHaveLength(1);
    expect(entries?.[0].sessionId).toBe('s-valid');
  });

  it('treats a non-array cooldowns field as a corrupt read (null, no throw)', () => {
    writeRaw({ schemaVersion: 1, cooldowns: 'not-an-array' });
    expect(() => readModelCooldowns(dir, NOW)).not.toThrow();
    expect(readModelCooldowns(dir, NOW)).toBeNull();
  });

  it('treats a missing schemaVersion as readable (forward tolerant)', () => {
    writeRaw({ cooldowns: [{ cooldownUntil: NOW + 1000 }] });
    expect(readModelCooldowns(dir, NOW)).toHaveLength(1);
  });
});

// ── Expiry ─────────────────────────────────────────────────────────────

describe('expiry', () => {
  it('filters expired entries out of reads', () => {
    writeRaw({
      schemaVersion: 1,
      cooldowns: [
        { paneId: 'expired', cooldownUntil: NOW - 1 },
        { paneId: 'active', cooldownUntil: NOW + 1 },
      ],
    });

    expect(readModelCooldowns(dir, NOW)?.map((e) => e.paneId)).toEqual(['active']);
  });

  it('does not treat an entry whose cooldownUntil equals now as active', () => {
    writeRaw({ schemaVersion: 1, cooldowns: [{ paneId: 'boundary', cooldownUntil: NOW }] });
    expect(readModelCooldowns(dir, NOW)).toEqual([]);
  });

  it('prunes expired entries on the next write', () => {
    writeRaw({
      schemaVersion: 1,
      cooldowns: [
        { paneId: 'expired', sessionId: 'expired-s', cooldownUntil: NOW - 5 },
        { paneId: 'active', sessionId: 'active-s', cooldownUntil: NOW + 100 },
      ],
    });

    expect(
      writeModelCooldown(dir, activeInput({ paneId: 'new', sessionId: 'new-s' }), NOW),
    ).toBe(true);

    const doc = JSON.parse(readFileSync(rawFile(), 'utf8'));
    const ids = doc.cooldowns.map((e: { paneId: string }) => e.paneId).sort();
    expect(ids).toEqual(['active', 'new']);
  });
});

// ── Fail-closed reads ──────────────────────────────────────────────────

describe('missing vs unreadable/corrupt reads', () => {
  it('returns [] when the file is missing', () => {
    expect(readModelCooldowns(dir, NOW)).toEqual([]);
  });

  it('returns [] when the coordination directory does not exist yet', () => {
    expect(readModelCooldowns(join(dir, 'not-created'), NOW)).toEqual([]);
  });

  it('distinguishes absent vs empty: a valid document with no active entries is [] (not null)', () => {
    writeRaw({ schemaVersion: 1, cooldowns: [] });
    expect(readModelCooldowns(dir, NOW)).toEqual([]);
  });

  it('distinguishes empty vs expired: a document whose only entry has expired is [] (not null)', () => {
    writeRaw({ schemaVersion: 1, cooldowns: [{ paneId: 'past', cooldownUntil: NOW - 1 }] });
    expect(readModelCooldowns(dir, NOW)).toEqual([]);
  });

  it('returns null when the file is not valid JSON', () => {
    writeRaw('{ this is not json');
    expect(readModelCooldowns(dir, NOW)).toBeNull();
  });

  it('returns null when the file cannot be read as a file', () => {
    // A directory at the cooldown path makes readFileSync throw EISDIR,
    // deterministically exercising the unreadable branch (root-safe).
    mkdirSync(rawFile());
    expect(readModelCooldowns(dir, NOW)).toBeNull();
  });

  it('returns null when the coordination dir is unresolvable (null)', () => {
    expect(readModelCooldowns(null, NOW)).toBeNull();
  });
});

// ── writeModelCooldown ─────────────────────────────────────────────────

describe('writeModelCooldown upsert and safety', () => {
  it('replaces an existing entry with the same pane id', () => {
    writeModelCooldown(dir, activeInput({ cooldownUntil: NOW + 10 }), NOW);
    writeModelCooldown(dir, activeInput({ cooldownUntil: NOW + 20 }), NOW);

    const entries = readModelCooldowns(dir, NOW);
    expect(entries).toHaveLength(1);
    expect(entries?.[0].cooldownUntil).toBe(NOW + 20);
  });

  it('replaces an existing entry with the same session id', () => {
    writeModelCooldown(dir, activeInput({ paneId: 'p1', sessionId: 'same' }), NOW);
    writeModelCooldown(dir, activeInput({ paneId: 'p2', sessionId: 'same' }), NOW);

    const entries = readModelCooldowns(dir, NOW);
    expect(entries).toHaveLength(1);
    expect(entries?.[0].paneId).toBe('p2');
  });

  it('preserves unrelated entries on upsert', () => {
    writeModelCooldown(dir, activeInput({ paneId: 'a', sessionId: 'a' }), NOW);
    writeModelCooldown(dir, activeInput({ paneId: 'b', sessionId: 'b' }), NOW);
    writeModelCooldown(dir, activeInput({ paneId: 'a', sessionId: 'a', cooldownUntil: NOW + 99 }), NOW);

    const entries = readModelCooldowns(dir, NOW);
    expect(entries).toHaveLength(2);
    expect(entries?.find((e) => e.paneId === 'a')?.cooldownUntil).toBe(NOW + 99);
  });

  it('defaults createdAt to now when omitted', () => {
    writeModelCooldown(dir, { paneId: 'p', sessionId: 's', cooldownUntil: NOW + 5 }, NOW);
    expect(readModelCooldowns(dir, NOW)?.[0].createdAt).toBe(NOW);
  });

  it('returns false when the coordination dir is null', () => {
    expect(writeModelCooldown(null, activeInput(), NOW)).toBe(false);
  });

  it('returns false (never throws) when the directory cannot be created', () => {
    // A regular file where the directory should be → mkdir fails.
    const filePath = join(dir, 'blocker');
    writeFileSync(filePath, 'x');
    expect(() => writeModelCooldown(join(filePath, 'sub'), activeInput(), NOW)).not.toThrow();
    expect(writeModelCooldown(join(filePath, 'sub'), activeInput(), NOW)).toBe(false);
  });

  it('returns false for an entry with a non-finite cooldownUntil', () => {
    expect(writeModelCooldown(dir, activeInput({ cooldownUntil: Number.NaN }), NOW)).toBe(false);
  });
});

// ── clearModelCooldown ─────────────────────────────────────────────────

describe('clearModelCooldown safety', () => {
  it('is a no-op for a missing file', () => {
    expect(clearModelCooldown(dir, 'session-1', NOW)).toBe(false);
  });

  it('is a no-op for an unreadable/corrupt file', () => {
    writeRaw('not json');
    expect(clearModelCooldown(dir, 'session-1', NOW)).toBe(false);
  });

  it('returns false when the key matches nothing', () => {
    writeModelCooldown(dir, activeInput(), NOW);
    expect(clearModelCooldown(dir, 'unknown-key', NOW)).toBe(false);
  });

  it('returns false when the coordination dir is null', () => {
    expect(clearModelCooldown(null, 'session-1', NOW)).toBe(false);
  });

  it('preserves entries with a different key', () => {
    writeModelCooldown(dir, activeInput({ paneId: 'a', sessionId: 'a' }), NOW);
    writeModelCooldown(dir, activeInput({ paneId: 'b', sessionId: 'b' }), NOW);
    expect(clearModelCooldown(dir, 'a', NOW)).toBe(true);
    expect(readModelCooldowns(dir, NOW)?.map((e) => e.paneId)).toEqual(['b']);
  });
});
