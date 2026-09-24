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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODE_FREEZE_MARKER_FILENAME,
  codeFreezeMarkerPath,
  readCodeFreezeState,
  readCodeFreezeStatus,
  readCodeFreezeStatusForRoot,
  isCodeFreezeActive,
  writeCodeFreezeMarker,
  clearCodeFreezeMarker,
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

// ── Tri-state read (WL-0MSQ0RPQP00636JY) ─────────────────────────────
// The downtime dispatcher must distinguish "not frozen" from "cannot tell":
// an ambiguous marker (unreadable file, corrupt JSON, wrong shape) is
// treated as frozen (fail-closed) so no implement/audit work starts during
// a release. `readCodeFreezeState` / `isCodeFreezeActive` keep their
// fail-open semantics for browsing — only the new tri-state read changes.

describe('readCodeFreezeStatus (tri-state)', () => {
  it('is frozen for an active marker', () => {
    writeMarker(JSON.stringify({ active: true, reason: 'ship release' }));
    expect(readCodeFreezeStatus(tmpDir)).toBe('frozen');
  });

  it('is not-frozen when the marker file is absent', () => {
    expect(readCodeFreezeStatus(tmpDir)).toBe('not-frozen');
  });

  it('is not-frozen when active is false', () => {
    writeMarker(JSON.stringify({ active: false, reason: 'released' }));
    expect(readCodeFreezeStatus(tmpDir)).toBe('not-frozen');
  });

  it('is ambiguous for corrupt JSON (fail-closed)', () => {
    writeMarker('{ not json !!!');
    expect(readCodeFreezeStatus(tmpDir)).toBe('ambiguous');
  });

  it('is ambiguous when the marker path is unreadable (e.g. a directory)', () => {
    const markerAsDir = join(tmpDir, CODE_FREEZE_MARKER_FILENAME);
    mkdirSync(markerAsDir); // marker path exists as a dir → readFileSync throws EISDIR
    expect(readCodeFreezeStatus(tmpDir)).toBe('ambiguous');
  });

  it('is ambiguous for a non-object marker (array / string / number)', () => {
    writeMarker('[1, 2, 3]');
    expect(readCodeFreezeStatus(tmpDir)).toBe('ambiguous');
    writeMarker('"hello"');
    expect(readCodeFreezeStatus(tmpDir)).toBe('ambiguous');
    writeMarker('42');
    expect(readCodeFreezeStatus(tmpDir)).toBe('ambiguous');
  });

  it('is ambiguous when active is missing (wrong shape)', () => {
    writeMarker(JSON.stringify({ reason: 'oops' }));
    expect(readCodeFreezeStatus(tmpDir)).toBe('ambiguous');
  });

  it('is ambiguous when active is not a boolean (wrong shape)', () => {
    writeMarker(JSON.stringify({ active: 'yes' }));
    expect(readCodeFreezeStatus(tmpDir)).toBe('ambiguous');
    writeMarker(JSON.stringify({ active: null }));
    expect(readCodeFreezeStatus(tmpDir)).toBe('ambiguous');
  });
});

describe('readCodeFreezeStatusForRoot', () => {
  it('resolves the marker under <root>/.worklog', () => {
    mkdirSync(join(tmpDir, '.worklog'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.worklog', CODE_FREEZE_MARKER_FILENAME),
      JSON.stringify({ active: true, reason: 'ship release' }),
      'utf8',
    );
    expect(readCodeFreezeStatusForRoot(tmpDir)).toBe('frozen');
  });

  it('is not-frozen when the root has no marker', () => {
    expect(readCodeFreezeStatusForRoot(join(tmpDir, 'no-marker-root'))).toBe('not-frozen');
  });
});

// ── writeCodeFreezeMarker (WL-0MUDEGBGO00609RV) ─────────────────────

describe('writeCodeFreezeMarker', () => {
  it('writes an active marker with the documented shape', () => {
    const path = writeCodeFreezeMarker({ worklogDir: tmpDir, reason: 'ship release' });
    expect(path).toBe(join(tmpDir, CODE_FREEZE_MARKER_FILENAME));
    const state = readCodeFreezeState(tmpDir);
    expect(state.active).toBe(true);
    expect(state.reason).toBe('ship release');
    expect(typeof state.startedAt).toBe('string');
    expect(Number.isNaN(new Date(state.startedAt!).getTime())).toBe(false);
    expect(state.pid).toBe(process.pid);
  });

  it('honours explicit pid and startedAt overrides (deterministic tests)', () => {
    writeCodeFreezeMarker({
      worklogDir: tmpDir,
      reason: 'test',
      pid: 4242,
      startedAt: '2026-01-02T03:04:05.000Z',
    });
    const state = readCodeFreezeState(tmpDir);
    expect(state.pid).toBe(4242);
    expect(state.startedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('produces a marker the tri-state read reports as frozen', () => {
    writeCodeFreezeMarker({ worklogDir: tmpDir, reason: 'ship' });
    expect(readCodeFreezeStatus(tmpDir)).toBe('frozen');
    expect(isCodeFreezeActive(tmpDir)).toBe(true);
  });

  it('is atomic: no leftover temp files after a successful write', () => {
    writeCodeFreezeMarker({ worklogDir: tmpDir });
    const leftovers = readdirSync(tmpDir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('overwrites an existing marker (idempotent)', () => {
    writeCodeFreezeMarker({ worklogDir: tmpDir, reason: 'first' });
    writeCodeFreezeMarker({ worklogDir: tmpDir, reason: 'second' });
    expect(readCodeFreezeState(tmpDir).reason).toBe('second');
  });

  it('returns null when the worklog directory is not writable (fail-closed)', () => {
    const missing = join(tmpDir, 'does-not-exist');
    expect(writeCodeFreezeMarker({ worklogDir: missing })).toBeNull();
  });

  it('returns null when no worklog dir is available', () => {
    resetWorklogDir();
    expect(writeCodeFreezeMarker()).toBeNull();
  });
});

// ── clearCodeFreezeMarker (WL-0MUDEGBGO00609RV) ──────────────────────

describe('clearCodeFreezeMarker', () => {
  it('removes an existing marker', () => {
    writeCodeFreezeMarker({ worklogDir: tmpDir, reason: 'ship' });
    expect(isCodeFreezeActive(tmpDir)).toBe(true);
    expect(clearCodeFreezeMarker(tmpDir)).toBe(true);
    expect(isCodeFreezeActive(tmpDir)).toBe(false);
    expect(existsSync(join(tmpDir, CODE_FREEZE_MARKER_FILENAME))).toBe(false);
  });

  it('silently succeeds when the marker does not exist (idempotent)', () => {
    expect(clearCodeFreezeMarker(tmpDir)).toBe(true);
    expect(clearCodeFreezeMarker(tmpDir)).toBe(true);
  });

  it('returns true when no worklog dir is available', () => {
    resetWorklogDir();
    expect(clearCodeFreezeMarker()).toBe(true);
  });

  it('round-trips: write then clear leaves the project not-frozen', () => {
    writeCodeFreezeMarker({ worklogDir: tmpDir });
    expect(readCodeFreezeStatus(tmpDir)).toBe('frozen');
    clearCodeFreezeMarker(tmpDir);
    expect(readCodeFreezeStatus(tmpDir)).toBe('not-frozen');
  });
});

// ── Type-level sanity ─────────────────────────────────────────────────

describe('CodeFreezeState type', () => {
  it('has the documented shape', () => {
    const state: CodeFreezeState = { active: true, reason: 'r', startedAt: 't', pid: 1 };
    expect(state.active).toBe(true);
  });
});
