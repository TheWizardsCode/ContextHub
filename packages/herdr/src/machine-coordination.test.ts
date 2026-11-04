/**
 * Unit tests for machine-coordination.ts — machine-wide coordination dir resolver
 * (WL-0MTF0KLO10043YAN, F1: Machine coordination dir resolver).
 *
 * Tests cover:
 *  - Env override precedence (~ expansion, absolute paths)
 *  - Default path resolution (~/.herdr/downtime)
 *  - Dir provisioning (mkdir -p) and fail-safe
 *  - Directory existence check
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  getMachineCoordinationDir,
  ensureMachineCoordinationDir,
  machineCoordinationDirExists,
  DEFAULT_MACHINE_COORDINATION_DIR,
  DOWNTIME_HOST_AUDIT_MARKER_FILE,
  DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS,
  readActiveAuditMarker,
  isHostAuditActive,
} from './machine-coordination.js';

// ── Test fixtures ──────────────────────────────────────────────────────

let testDir: string;
const originalEnv = process.env.HERDR_COORDINATION_DIR;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'herdr-machine-coord-'));
  delete process.env.HERDR_COORDINATION_DIR;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  if (originalEnv !== undefined) {
    process.env.HERDR_COORDINATION_DIR = originalEnv;
  } else {
    delete process.env.HERDR_COORDINATION_DIR;
  }
});

// ── getMachineCoordinationDir ──────────────────────────────────────────

describe('getMachineCoordinationDir', () => {
  it('returns env override when set (absolute path)', () => {
    process.env.HERDR_COORDINATION_DIR = testDir;
    expect(getMachineCoordinationDir()).toBe(testDir);
  });

  it('expands ~ in env override', () => {
    process.env.HERDR_COORDINATION_DIR = '~/custom-downtime';
    const home = os.homedir();
    expect(getMachineCoordinationDir()).toBe(join(home, 'custom-downtime'));
  });

  it('uses default when env is empty string', () => {
    process.env.HERDR_COORDINATION_DIR = '';
    const expected = join(os.homedir(), DEFAULT_MACHINE_COORDINATION_DIR);
    expect(getMachineCoordinationDir()).toBe(expected);
  });

  it('uses default when env is unset', () => {
    expect(getMachineCoordinationDir()).toBe(join(os.homedir(), DEFAULT_MACHINE_COORDINATION_DIR));
  });

  it('returns null when both env ~ expansion and default fail (no home)', () => {
    // Force homedir() to throw — we test this by temporarily replacing
    // process.env.HOME with an empty string so os.homedir() fails.
    const savedHome = process.env.HOME;
    process.env.HOME = '';
    expect(getMachineCoordinationDir()).toBe(null);
    process.env.HOME = savedHome;
  });

  it('returns null when env ~ expansion fails (no home)', () => {
    process.env.HERDR_COORDINATION_DIR = '~/custom-downtime';
    const savedHome = process.env.HOME;
    process.env.HOME = '';
    expect(getMachineCoordinationDir()).toBe(null);
    process.env.HOME = savedHome;
  });
});

// ── ensureMachineCoordinationDir ───────────────────────────────────────

describe('ensureMachineCoordinationDir', () => {
  it('creates the directory when it does not exist', () => {
    const newDir = join(testDir, 'new-downtime');
    expect(existsSync(newDir)).toBe(false);
    expect(ensureMachineCoordinationDir(newDir)).toBe(true);
    expect(existsSync(newDir)).toBe(true);
  });

  it('is idempotent (returns true when dir already exists)', () => {
    const newDir = join(testDir, 'new-downtime');
    fs.mkdirSync(newDir);
    expect(ensureMachineCoordinationDir(newDir)).toBe(true);
  });

  it('returns false when dir is null', () => {
    expect(ensureMachineCoordinationDir(null)).toBe(false);
  });

  it('returns false on I/O failure (permission denied)', () => {
    const protectedDir = '/root/protected-herdr-downtime';
    // This will likely fail on a normal user account
    expect(ensureMachineCoordinationDir(protectedDir)).toBe(false);
  });
});

// ── machineCoordinationDirExists ───────────────────────────────────────

describe('machineCoordinationDirExists', () => {
  it('returns true for an existing directory', () => {
    expect(machineCoordinationDirExists(testDir)).toBe(true);
  });

  it('returns false for a non-existent directory', () => {
    expect(machineCoordinationDirExists(join(testDir, 'non-existent'))).toBe(false);
  });

  it('returns false when dir is null', () => {
    expect(machineCoordinationDirExists(null)).toBe(false);
  });

  it('returns false when path is a file, not a directory', () => {
    const file = join(testDir, 'a-file');
    writeFileSync(file, 'data');
    expect(machineCoordinationDirExists(file)).toBe(false);
  });
});

// ── Retired host-wide audit marker — READ-COMPATIBILITY ONLY ───────────
//
// WL-0MVXY0XPF006YUHA F2 AC2 retires the `active-audit` marker in favour of the
// machine-scoped dispatch-budget ledger. The writers are GONE (the marker is
// never created or removed again); the readers remain for ONE release so a
// non-stale marker written by an older instance is still recognised and counted
// as one synthetic audit entry by the ledger (`legacyActiveAuditCount`).

describe('host-wide active-audit marker (retired, read-compatibility only)', () => {
  /** Write a legacy marker file verbatim, as an older instance would. */
  function writeLegacyMarker(marker: unknown): void {
    writeFileSync(
      join(testDir, DOWNTIME_HOST_AUDIT_MARKER_FILE),
      typeof marker === 'string' ? marker : JSON.stringify(marker),
    );
  }

  it('exposes no marker writer: the file can no longer be created or removed (AC2)', async () => {
    const mod = await import('./machine-coordination.js');
    expect('writeActiveAuditMarker' in mod).toBe(false);
    expect('removeActiveAuditMarker' in mod).toBe(false);
  });

  it('readActiveAuditMarker reads a marker written by an older instance', () => {
    writeLegacyMarker({ instanceId: 'inst-a', dispatchedAt: new Date().toISOString() });
    const marker = readActiveAuditMarker(testDir);
    expect(marker).not.toBeNull();
    expect(marker?.instanceId).toBe('inst-a');
    expect(Number.isNaN(Date.parse(marker!.dispatchedAt))).toBe(false);
  });

  it('readActiveAuditMarker returns null when the marker is absent', () => {
    expect(readActiveAuditMarker(testDir)).toBeNull();
  });

  it('readActiveAuditMarker returns null for malformed JSON (fail-safe)', () => {
    writeLegacyMarker('not-json{');
    expect(readActiveAuditMarker(testDir)).toBeNull();
  });

  it('readActiveAuditMarker returns null when instanceId is missing or empty (fail-safe)', () => {
    writeLegacyMarker({ dispatchedAt: new Date().toISOString() });
    expect(readActiveAuditMarker(testDir)).toBeNull();
    writeLegacyMarker({ instanceId: '', dispatchedAt: new Date().toISOString() });
    expect(readActiveAuditMarker(testDir)).toBeNull();
  });

  it('readActiveAuditMarker returns null when dispatchedAt is unparseable (fail-safe)', () => {
    writeLegacyMarker({ instanceId: 'inst-a', dispatchedAt: 'not-a-date' });
    expect(readActiveAuditMarker(testDir)).toBeNull();
  });

  it('isHostAuditActive is true for a fresh marker and false once the file is gone', () => {
    writeLegacyMarker({ instanceId: 'inst-a', dispatchedAt: new Date().toISOString() });
    expect(isHostAuditActive(testDir)).toBe(true);
    rmSync(join(testDir, DOWNTIME_HOST_AUDIT_MARKER_FILE));
    expect(isHostAuditActive(testDir)).toBe(false);
  });

  it('isHostAuditActive is false for a marker older than the stale window', () => {
    // A crashed audit pane must not block the host forever: a marker older
    // than DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS is treated as released.
    const staleTime = new Date(
      Date.now() - DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS - 60_000,
    ).toISOString();
    writeLegacyMarker({ instanceId: 'inst-a', dispatchedAt: staleTime });
    expect(isHostAuditActive(testDir)).toBe(false);
  });

  it('isHostAuditActive is true for a marker just inside the stale window', () => {
    // Exactly at the boundary the marker is still active (strict `<` window);
    // one minute inside guarantees the assertion is not flaky.
    const freshTime = new Date(
      Date.now() - DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS + 60_000,
    ).toISOString();
    writeLegacyMarker({ instanceId: 'inst-a', dispatchedAt: freshTime });
    expect(isHostAuditActive(testDir)).toBe(true);
  });
});
