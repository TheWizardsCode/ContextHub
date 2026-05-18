import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressReporter } from '../../src/progress.js';

describe('ProgressReporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1).getTime());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits human-friendly lines to outStream in human mode', () => {
    let out = '';
    const outStream = { write: (s: string) => { out += s; }, isTTY: true } as any;
    const rep = new ProgressReporter({ mode: 'human', rateMs: 1000, outStream });

    rep.render({ phase: 'import', current: 1, total: 4 });
    expect(out).toContain('Import: 1/4');

    // complete event should include newline
    rep.render({ phase: 'import', current: 4, total: 4 });
    expect(out.endsWith('\n')).toBe(true);
  });

  it('emits JSON lines to jsonStream in json mode', () => {
    let buf = '';
    const jsonStream = { write: (s: string) => { buf += s; } } as any;
    const rep = new ProgressReporter({ mode: 'json', rateMs: 1000, jsonStream });

    rep.render({ phase: 'comments', current: 2, total: 5, note: 'fetching' });
    expect(buf.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(buf.trim());
    expect(parsed).toMatchObject({ type: 'progress', phase: 'comments', current: 2, total: 5 });
    expect(parsed.note).toBe('fetching');
  });

  it('rate-limits emissions per phase', () => {
    let out = '';
    const outStream = { write: (s: string) => { out += s; }, isTTY: true } as any;
    const rep = new ProgressReporter({ mode: 'human', rateMs: 1000, outStream });

    rep.render({ phase: 'import', current: 1, total: 3 });
    // immediate second tick should be suppressed
    rep.render({ phase: 'import', current: 2, total: 3 });
    expect(out.includes('1/3')).toBe(true);
    expect(out.includes('2/3')).toBe(false);

    // advance time beyond rateMs
    vi.setSystemTime(Date.now() + 1200);
    rep.render({ phase: 'import', current: 2, total: 3 });
    expect(out.includes('2/3')).toBe(true);
  });

  it('emits heartbeat in human mode after inactivity', () => {
    let out = '';
    const outStream = { write: (s: string) => { out += s; }, isTTY: true } as any;
    const rep = new ProgressReporter({ mode: 'human', rateMs: 1000, outStream });

    rep.render({ phase: 'import', current: 4, total: 4, note: 'queue=0 active=0 retries=0 errors=0' });
    rep.startHeartbeat({ intervalMs: 5000, notePrefix: 'heartbeat (post-import)' });

    vi.advanceTimersByTime(5000);

    expect(out).toContain('heartbeat (post-import): no updates for 5s');
    rep.stopHeartbeat();
  });

  it('does not emit heartbeat in json mode', () => {
    let buf = '';
    const jsonStream = { write: (s: string) => { buf += s; } } as any;
    const rep = new ProgressReporter({ mode: 'json', rateMs: 1000, jsonStream });

    rep.render({ phase: 'import', current: 2, total: 2 });
    rep.startHeartbeat({ intervalMs: 5000, notePrefix: 'heartbeat (post-import)' });

    vi.advanceTimersByTime(5000);

    const lines = buf.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    rep.stopHeartbeat();
  });
});
