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
  writeActiveAuditMarker,
  removeActiveAuditMarker,
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

// ── Host-wide audit serialisation (WL-0MUIVE0YG000UVIA) ────────────────

describe('host-wide active-audit marker', () => {
  it('writeActiveAuditMarker creates the marker and readActiveAuditMarker reads it back', () => {
    expect(writeActiveAuditMarker(testDir, 'inst-a')).toBe(true);
    const marker = readActiveAuditMarker(testDir);
    expect(marker).not.toBeNull();
    expect(marker?.instanceId).toBe('inst-a');
    expect(typeof marker?.dispatchedAt).toBe('string');
    expect(Number.isNaN(Date.parse(marker!.dispatchedAt))).toBe(false);
  });

  it('writeActiveAuditMarker provisions a missing coordination dir (mkdir -p)', () => {
    const nested = join(testDir, 'nested', 'downtime');
    expect(writeActiveAuditMarker(nested, 'inst-a')).toBe(true);
    expect(machineCoordinationDirExists(nested)).toBe(true);
    expect(readActiveAuditMarker(nested)?.instanceId).toBe('inst-a');
  });

  it('readActiveAuditMarker returns null when the marker is absent', () => {
    expect(readActiveAuditMarker(testDir)).toBeNull();
  });

  it('readActiveAuditMarker returns null for malformed JSON (fail-safe)', () => {
    writeFileSync(join(testDir, DOWNTIME_HOST_AUDIT_MARKER_FILE), 'not-json{');
    expect(readActiveAuditMarker(testDir)).toBeNull();
  });

  it('readActiveAuditMarker returns null when instanceId is missing or empty (fail-safe)', () => {
    writeFileSync(
      join(testDir, DOWNTIME_HOST_AUDIT_MARKER_FILE),
      JSON.stringify({ dispatchedAt: new Date().toISOString() }),
    );
    expect(readActiveAuditMarker(testDir)).toBeNull();
    writeFileSync(
      join(testDir, DOWNTIME_HOST_AUDIT_MARKER_FILE),
      JSON.stringify({ instanceId: '', dispatchedAt: new Date().toISOString() }),
    );
    expect(readActiveAuditMarker(testDir)).toBeNull();
  });

  it('readActiveAuditMarker returns null when dispatchedAt is unparseable (fail-safe)', () => {
    writeFileSync(
      join(testDir, DOWNTIME_HOST_AUDIT_MARKER_FILE),
      JSON.stringify({ instanceId: 'inst-a', dispatchedAt: 'not-a-date' }),
    );
    expect(readActiveAuditMarker(testDir)).toBeNull();
  });

  it('isHostAuditActive is true for a fresh marker and false once removed', () => {
    expect(writeActiveAuditMarker(testDir, 'inst-a')).toBe(true);
    expect(isHostAuditActive(testDir)).toBe(true);
    expect(removeActiveAuditMarker(testDir)).toBe(true);
    expect(isHostAuditActive(testDir)).toBe(false);
  });

  it('isHostAuditActive is false for a marker older than the stale window', () => {
    // A crashed audit pane must not block the host forever: a marker older
    // than DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS is treated as released.
    const staleTime = new Date(
      Date.now() - DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS - 60_000,
    ).toISOString();
    writeFileSync(
      join(testDir, DOWNTIME_HOST_AUDIT_MARKER_FILE),
      JSON.stringify({ instanceId: 'inst-a', dispatchedAt: staleTime }),
    );
    expect(isHostAuditActive(testDir)).toBe(false);
  });

  it('isHostAuditActive is true for a marker just inside the stale window', () => {
    // Exactly at the boundary the marker is still active (strict `<` window);
    // one minute inside guarantees the assertion is not flaky.
    const freshTime = new Date(
      Date.now() - DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS + 60_000,
    ).toISOString();
    writeFileSync(
      join(testDir, DOWNTIME_HOST_AUDIT_MARKER_FILE),
      JSON.stringify({ instanceId: 'inst-a', dispatchedAt: freshTime }),
    );
    expect(isHostAuditActive(testDir)).toBe(true);
  });

  it('writeActiveAuditMarker overwrites an existing marker (single-writer)', () => {
    expect(writeActiveAuditMarker(testDir, 'inst-a')).toBe(true);
    expect(writeActiveAuditMarker(testDir, 'inst-b')).toBe(true);
    expect(readActiveAuditMarker(testDir)?.instanceId).toBe('inst-b');
  });

  it('removeActiveAuditMarker returns false when no marker exists (idempotent)', () => {
    expect(removeActiveAuditMarker(testDir)).toBe(false);
  });
});
