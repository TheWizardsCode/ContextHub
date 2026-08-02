/**
 * Unit tests for the Code Freeze marker module (code-freeze.ts).
 *
 * Run: npx vitest run packages/herdr/src/code-freeze.test.ts
 *
 * The marker contract (cross-repo, shared with the SorraAgents ship/implement
 * skills — see SA-0MSBU4OBU005WJNB):
 *   <worklog-dir>/code-freeze.json
 *   { "active": true, "reason": "...", "startedAt": "<ISO>", "pid": <pid> }
 * Presence of a marker with `active: true` means the project is frozen;
 * absence or `active: false` means it is not. Parse errors fail open (OFF).
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODE_FREEZE_MARKER_FILENAME,
  codeFreezeMarkerPath,
  readCodeFreezeState,
  isCodeFreezeActive,
  type CodeFreezeState,
} from './code-freeze.js';
import { setWorklogDir, resetWorklogDir } from './fetcher.js';

// ── Helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'herdr-cf-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  resetWorklogDir();
});

function writeMarker(contents: string): string {
  const p = join(tmpDir, CODE_FREEZE_MARKER_FILENAME);
  writeFileSync(p, contents, 'utf8');
  return p;
}

// ── Marker path resolution ──────────────────────────────────────────────

describe('codeFreezeMarkerPath', () => {
  it('joins the worklog dir with the marker filename', () => {
    expect(codeFreezeMarkerPath('/proj/.worklog')).toBe('/proj/.worklog/code-freeze.json');
  });

  it('falls back to the configured worklog dir when none is passed', () => {
    setWorklogDir('/configured/.worklog');
    expect(codeFreezeMarkerPath()).toBe('/configured/.worklog/code-freeze.json');
  });

  it('returns an empty string when no worklog dir is available', () => {
    resetWorklogDir();
    expect(codeFreezeMarkerPath()).toBe('');
  });
});

// ── Marker parsing (fail-open) ──────────────────────────────────────────

describe('readCodeFreezeState', () => {
  it('parses an active marker', () => {
    writeMarker(JSON.stringify({ active: true, reason: 'ship release', startedAt: '2026-08-02T00:00:00Z', pid: 1234 }));
    const state = readCodeFreezeState(tmpDir);
    expect(state.active).toBe(true);
    expect(state.reason).toBe('ship release');
    expect(state.startedAt).toBe('2026-08-02T00:00:00Z');
    expect(state.pid).toBe(1234);
  });

  it('returns inactive when the marker file is absent', () => {
    const state = readCodeFreezeState(tmpDir);
    expect(state).toEqual({ active: false });
  });

  it('returns inactive when active is false', () => {
    writeMarker(JSON.stringify({ active: false, reason: 'released' }));
    const state = readCodeFreezeState(tmpDir);
    expect(state.active).toBe(false);
  });

  it('returns inactive when active is missing', () => {
    writeMarker(JSON.stringify({ reason: 'oops' }));
    const state = readCodeFreezeState(tmpDir);
    expect(state.active).toBe(false);
  });

  it('returns inactive for corrupt JSON (fail open)', () => {
    writeMarker('{ not json !!!');
    const state = readCodeFreezeState(tmpDir);
    expect(state).toEqual({ active: false });
  });

  it('returns inactive for a non-boolean active value', () => {
    writeMarker(JSON.stringify({ active: 'yes' }));
    const state = readCodeFreezeState(tmpDir);
    expect(state.active).toBe(false);
  });

  it('returns inactive when the marker path is unreadable', () => {
    // Point at a directory so readFileSync throws EISDIR
    const state = readCodeFreezeState(join(tmpDir, '..', 'herdr-cf-does-not-exist'));
    expect(state.active).toBe(false);
  });
});

// ── isCodeFreezeActive ───────────────────────────────────────────────────

describe('isCodeFreezeActive', () => {
  it('is true only for an active marker', () => {
    writeMarker(JSON.stringify({ active: true }));
    expect(isCodeFreezeActive(tmpDir)).toBe(true);
  });

  it('is false when no marker exists', () => {
    expect(isCodeFreezeActive(tmpDir)).toBe(false);
  });

  it('is false for a corrupt marker', () => {
    writeMarker('garbage');
    expect(isCodeFreezeActive(tmpDir)).toBe(false);
  });
});

// ── Type-level sanity ─────────────────────────────────────────────────────

describe('CodeFreezeState type', () => {
  it('has the documented shape', () => {
    const state: CodeFreezeState = { active: true, reason: 'r', startedAt: 't', pid: 1 };
    expect(state.active).toBe(true);
  });
});
