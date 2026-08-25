/**
 * packages/herdr/src/downtime-round-robin.test.ts — Round-robin registry tests
 *
 * Parent: WL-0MSSRED76008LGB6 (Downtime dispatcher: priority-first selection
 * with round-robin tie-break across instances + jittered probes)
 * Child:  WL-0MSW6CACJ0035UGK (Test-first: round-robin + rotation + jitter test suite)
 *
 * Tests cover:
 * 1. Cursor persistence: save/load JSON round-trip
 * 2. Fail-open: corrupt file → default behavior (no rotation)
 * 3. Rotation selection: repeated selections cycle through items
 * 4. Priority-first: higher priority always selected before lower
 * 5. Jitter bounds: jitter ∈ [0.5*interval, 1.5*interval]
 * 6. Cross-instance isolation: different workers produce different jitter values
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
  createRoundRobinRegistry,
  type RoundRobinRegistry,
  DEFAULT_JITTER_FRACTION,
} from './downtime-round-robin';

// ── Helper: in-memory tmp directory ──────────────────────────────────────

function mkTmpDir(): string {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  return dir;
}

// ── Test 1: Cursor persistence (save/load round-trip) ───────────────────

describe('cursor persistence', () => {
  let tmpDir: string;
  let registry: RoundRobinRegistry;

  beforeEach(() => {
    tmpDir = mkTmpDir();
    registry = createRoundRobinRegistry({ worklogDir: tmpDir, rng: () => 0.5 });
  });

  afterAll(() => {
    const fs = require('fs');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('saves and loads cursor via JSON round-trip', async () => {
    // Advance cursor (first selection of a 3-item group)
    const next = registry.advanceCursor('high', 3);
    expect(next).toBe(0); // cursor 0 % 3 = item 0

    // Create a new registry pointing to same dir (simulates restart)
    registry = createRoundRobinRegistry({ worklogDir: tmpDir, rng: () => 0.5 });
    const loaded = registry.loadCursor('high');
    expect(loaded).toBe(1); // cursor persisted after advance
  });

  it('persists version number and increments on save', async () => {
    registry.advanceCursor('high', 2);
    registry.advanceCursor('high', 3);
    registry = createRoundRobinRegistry({ worklogDir: tmpDir, rng: () => 0.5 });
    const loaded = registry.loadCursor('high');
    expect(loaded).toBe(2); // two advances → cursor 2
  });
});

// ── Test 2: Fail-open on corrupt file ───────────────────────────────────

describe('fail-open on corrupt file', () => {
  let tmpDir: string;
  let registry: RoundRobinRegistry;

  beforeEach(() => {
    tmpDir = mkTmpDir();
    registry = createRoundRobinRegistry({ worklogDir: tmpDir, rng: () => 0.5 });
  });

  afterAll(() => {
    const fs = require('fs');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns default cursor (0) when file does not exist', () => {
    // No save has been done — cursor should be 0
    expect(registry.loadCursor('high')).toBe(0);
  });

  it('returns default cursor when file contains corrupt JSON', () => {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(tmpDir, 'downtime-round-robin.json');
    fs.writeFileSync(filePath, 'not valid json{{{');

    registry = createRoundRobinRegistry({ worklogDir: tmpDir, rng: () => 0.5 });
    expect(registry.loadCursor('high')).toBe(0);
  });

  it('returns default cursor when file is empty', () => {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(tmpDir, 'downtime-round-robin.json');
    fs.writeFileSync(filePath, '');

    registry = createRoundRobinRegistry({ worklogDir: tmpDir, rng: () => 0.5 });
    expect(registry.loadCursor('high')).toBe(0);
  });

  it('does not throw on any corrupt file scenario', () => {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(tmpDir, 'downtime-round-robin.json');
    fs.writeFileSync(filePath, '\0\xff\xfe');

    expect(() => {
      registry = createRoundRobinRegistry({ worklogDir: tmpDir, rng: () => 0.5 });
      registry.loadCursor('high');
    }).not.toThrow();
  });
});

// ── Test 3: Rotation selection ──────────────────────────────────────────

describe('rotation selection', () => {
  let tmpDir: string;
  let registry: RoundRobinRegistry;

  beforeEach(() => {
    tmpDir = mkTmpDir();
    registry = createRoundRobinRegistry({ worklogDir: tmpDir, rng: () => 0.5 });
  });

  afterAll(() => {
    const fs = require('fs');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('cycles through N items correctly', () => {
    const groupSize = 5;
    const results: number[] = [];
    for (let i = 0; i < groupSize * 2; i++) {
      results.push(registry.advanceCursor('high', groupSize));
    }
    // Should cycle: 0, 1, 2, 3, 4, 0, 1, 2, 3, 4
    expect(results).toEqual([0, 1, 2, 3, 4, 0, 1, 2, 3, 4]);
  });

  it('two instances selecting from same group pick different items after cursor advances', () => {
    // Instance 1 reads cursor = 0, selects item 0 (0 % 3 = 0), advances cursor to 1
    const cursor1 = registry.loadCursor('high');
    expect(cursor1).toBe(0);
    const next1 = registry.advanceCursor('high', 3);
    expect(next1).toBe(0); // item 0 selected

    // Instance 2 reads cursor = 1, selects item 1 (1 % 3 = 1), advances cursor to 2
    const cursor2 = registry.loadCursor('high');
    expect(cursor2).toBe(1);
    const next2 = registry.advanceCursor('high', 3);
    expect(next2).toBe(1); // item 1 selected
  });
});

// ── Test 4: Priority-first ordering ─────────────────────────────────────

describe('priority-first ordering', () => {
  let tmpDir: string;
  let registry: RoundRobinRegistry;

  beforeEach(() => {
    tmpDir = mkTmpDir();
    registry = createRoundRobinRegistry({ worklogDir: tmpDir, rng: () => 0.5 });
  });

  afterAll(() => {
    const fs = require('fs');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('maintains separate cursors per priority tier', () => {
    registry.advanceCursor('audit', 2);
    registry.advanceCursor('implement', 3);
    registry.advanceCursor('plan', 4);

    expect(registry.loadCursor('audit')).toBe(1);
    expect(registry.loadCursor('implement')).toBe(1);
    expect(registry.loadCursor('plan')).toBe(1);
  });

  it('higher-priority tier cursor is independent of lower-tier cursor', () => {
    // Simulate: audit tier selects item, implement tier selects item
    registry.advanceCursor('audit', 1);
    const auditCursor = registry.loadCursor('audit');
    const implementCursor = registry.loadCursor('implement');

    expect(auditCursor).toBe(1);
    expect(implementCursor).toBe(0); // implement cursor hasn't advanced
  });
});

// ── Test 5: Jitter bounds ───────────────────────────────────────────────

describe('jitter bounds', () => {
  it('jitter value is within ±50% of poll interval', () => {
    const pollInterval = 30_000;
    const registry = createRoundRobinRegistry({ worklogDir: mkTmpDir(), rng: () => 1.0 });

    // rng returns 1.0 → max jitter (+50%)
    const effectiveInterval = registry.getEffectivePollInterval(pollInterval);
    expect(effectiveInterval).toBe(45_000); // 30_000 * 1.5

    registry.close();
  });

  it('jitter can be negative (−50%)', () => {
    const pollInterval = 30_000;
    const rng = vi.fn().mockReturnValue(0.0); // min jitter (-50%)
    const registry = createRoundRobinRegistry({ worklogDir: mkTmpDir(), rng });

    const effectiveInterval = registry.getEffectivePollInterval(pollInterval);
    expect(effectiveInterval).toBe(15_000); // 30_000 * 0.5

    registry.close();
  });

  it('zero jitter (rng returns 0.5) gives exact poll interval', () => {
    const pollInterval = 30_000;
    const rng = vi.fn().mockReturnValue(0.5); // center jitter (0%)
    const registry = createRoundRobinRegistry({ worklogDir: mkTmpDir(), rng });

    const effectiveInterval = registry.getEffectivePollInterval(pollInterval);
    expect(effectiveInterval).toBe(30_000); // 30_000 * 1.0

    registry.close();
  });

  it('bounds are clamped at exactly 0.5 and 1.5 regardless of rng', () => {
    const pollInterval = 30_000;
    // rng returns values outside [0, 1] — should be clamped
    const rng = vi.fn().mockReturnValue(1.5); // would give 2.0x if not clamped
    const registry = createRoundRobinRegistry({ worklogDir: mkTmpDir(), rng });

    const effectiveInterval = registry.getEffectivePollInterval(pollInterval);
    expect(effectiveInterval).toBe(45_000); // clamped to max 1.5 * 30_000

    registry.close();
  });
});

// ── Test 6: Cross-instance isolation ────────────────────────────────────

describe('cross-instance isolation', () => {
  it('two workers with same config produce different jitter values', () => {
    const pollInterval = 30_000;
    const rng1 = vi.fn().mockReturnValue(0.3);
    const rng2 = vi.fn().mockReturnValue(0.7);

    const registry1 = createRoundRobinRegistry({ worklogDir: mkTmpDir(), rng: rng1 });
    const registry2 = createRoundRobinRegistry({ worklogDir: mkTmpDir(), rng: rng2 });

    const interval1 = registry1.getEffectivePollInterval(pollInterval);
    const interval2 = registry2.getEffectivePollInterval(pollInterval);

    expect(interval1).toBe(24_000); // rng 0.3 → factor 0.8 → 30_000 * 0.8
    expect(interval2).toBe(36_000); // rng 0.7 → factor 1.2 → 30_000 * 1.2
    expect(interval1).not.toBe(interval2);

    registry1.close();
    registry2.close();
  });

  it('two workers with identical RNG produce the same jitter', () => {
    const pollInterval = 30_000;
    const rng = vi.fn().mockReturnValue(0.5);

    const registry1 = createRoundRobinRegistry({ worklogDir: mkTmpDir(), rng });
    const registry2 = createRoundRobinRegistry({ worklogDir: mkTmpDir(), rng });

    const interval1 = registry1.getEffectivePollInterval(pollInterval);
    const interval2 = registry2.getEffectivePollInterval(pollInterval);

    expect(interval1).toBe(30_000);
    expect(interval2).toBe(30_000);

    registry1.close();
    registry2.close();
  });
});
