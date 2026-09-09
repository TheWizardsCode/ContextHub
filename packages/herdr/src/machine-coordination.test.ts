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
