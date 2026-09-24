/**
 * packages/herdr/src/ship-guard-query.test.ts — Regression tests for the
 * production Ship Guard query seam (WL-0MUEK7H39008VVUF, parent
 * WL-0MUD6DDZC007ZSIW).
 *
 * The original defect: `createProductionShipGuardQuery` ran the FULL
 * `wl list --json` payload (≈8.5 MB / 2,299 items) into Node's `execFile`
 * with an 8 MiB `maxBuffer`. `execFile` rejected with
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, the catch swallowed it to
 * `worklogOutput = null`, and the guard failed safe — permanently blocking
 * ship mode with a misleading "Cannot verify pane state" notice.
 *
 * These tests pin the fix:
 *   - the worklog query requests ONLY `id` fields (bounded payload);
 *   - the `maxBuffer` is larger than the payload that used to overflow;
 *   - a >8 MiB IDs payload still parses and evaluates blocking panes;
 *   - the guard reason names WHICH query failed (worklog vs pane list).
 *
 * Run: npx vitest run packages/herdr/src/ship-guard-query.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setExecFileAsync, resetExecFileAsync } from './fetcher.js';
import { createProductionShipGuardQuery } from './worklist.js';
import { runShipGuard } from './ship-guard.js';

/** The maxBuffer the production query previously used (8 MiB). */
const OLD_MAX_BUFFER = 8 * 1024 * 1024;

/** Build a `wl list --json --fields id` style payload of `count` IDs. */
function idsPayload(count: number): string {
  const items: { id: string }[] = [];
  for (let i = 0; i < count; i++) {
    items.push({ id: `WL-${i.toString(36).toUpperCase().padStart(12, '0')}` });
  }
  return JSON.stringify({ success: true, count, workItems: items });
}

/**
 * Build an oversized `wl list --json` payload: real IDs plus an inert padding
 * field so the raw output crosses the old 8 MiB ceiling. The guard's parser
 * ignores unknown fields, so the ID set is still evaluated (proof the parser
 * is not size-limited).
 */
function oversizedIdsPayload(count: number, padBytes: number): string {
  const ids: { id: string; pad?: string }[] = [];
  for (let i = 0; i < count; i++) {
    ids.push({ id: `WL-${i.toString(36).toUpperCase().padStart(12, '0')}` });
  }
  ids[0] = { ...ids[0], pad: 'x'.repeat(padBytes) };
  return JSON.stringify({ success: true, count, workItems: ids });
}

/** Build a `herdr pane list` payload. */
function panePayload(panes: { pane_id: string; label?: string; agent?: string; agent_status?: string }[]): string {
  return JSON.stringify({ result: { panes } });
}

describe('createProductionShipGuardQuery (WL-0MUEK7H39008VVUF)', () => {
  beforeEach(() => {
    resetExecFileAsync();
  });

  afterEach(() => {
    resetExecFileAsync();
  });

  it('requests only the id field from wl (bounded payload)', async () => {
    const calls: { bin: string; args: string[] }[] = [];
    const mock = vi.fn(async (bin: string, args: string[]) => {
      calls.push({ bin, args });
      return { stdout: idsPayload(2), stderr: '' };
    });
    setExecFileAsync(mock as any);

    await createProductionShipGuardQuery()();

    const wlCall = calls.find((c) => c.bin === 'wl');
    expect(wlCall).toBeDefined();
    expect(wlCall!.args).toContain('list');
    expect(wlCall!.args).toContain('--json');
    // The projection that keeps the payload bounded — the core of the fix.
    expect(wlCall!.args).toContain('--fields');
    expect(wlCall!.args).toContain('id');
  });

  it('uses a maxBuffer larger than the payload that used to overflow', async () => {
    let wlMaxBuffer: number | undefined;
    const mock = vi.fn(async (bin: string, _args: string[], opts?: { maxBuffer?: number }) => {
      if (bin === 'wl') wlMaxBuffer = opts?.maxBuffer;
      return { stdout: idsPayload(1), stderr: '' };
    });
    setExecFileAsync(mock as any);

    await createProductionShipGuardQuery()();

    expect(wlMaxBuffer).toBeDefined();
    // Must clear the old 8 MiB ceiling with headroom.
    expect(wlMaxBuffer!).toBeGreaterThan(OLD_MAX_BUFFER);
  });

  it('parses a worklog payload larger than the old 8 MiB maxBuffer and evaluates blocking panes', async () => {
    // ~2,300 items mirrors production; the padding deliberately pushes the
    // raw payload past the old 8 MiB maxBuffer.
    const many = oversizedIdsPayload(2300, OLD_MAX_BUFFER);
    expect(Buffer.byteLength(many, 'utf8')).toBeGreaterThan(OLD_MAX_BUFFER);

    const mock = vi.fn(async (bin: string) => {
      if (bin === 'wl') return { stdout: many, stderr: '' };
      return {
        stdout: panePayload([
          { pane_id: 'p1', label: 'Downtime implement WL-000000000001', agent: 'a1', agent_status: 'working' },
        ]),
        stderr: '',
      };
    });
    setExecFileAsync(mock as any);

    const query = await createProductionShipGuardQuery()();
    expect(query.worklogOutput).not.toBeNull();
    expect(query.paneOutput).not.toBeNull();

    const result = runShipGuard(query.worklogOutput ?? '', query.paneOutput ?? '');
    expect(result.ok).toBe(true);
    expect(result.blockingPanes).toHaveLength(1);
    expect(result.blockingPanes[0].workItemId).toBe('WL-000000000001');
  });

  it('keeps the worklog output when the pane query fails, and reports a pane-list reason', async () => {
    const mock = vi.fn(async (bin: string) => {
      if (bin === 'wl') return { stdout: idsPayload(2), stderr: '' };
      throw new Error('herdr unavailable');
    });
    setExecFileAsync(mock as any);

    const query = await createProductionShipGuardQuery()();
    expect(query.worklogOutput).not.toBeNull();
    expect(query.paneOutput).toBeNull();

    const result = runShipGuard(query.worklogOutput ?? '', query.paneOutput ?? '');
    expect(result.ok).toBe(false);
    // Distinguishes the failing query (AC3).
    expect(result.reason).toContain('pane list unavailable');
    expect(result.reason).not.toContain('worklog list unavailable');
  });

  it('reports a worklog reason (not a pane reason) when only the wl query fails', async () => {
    const mock = vi.fn(async (bin: string) => {
      if (bin === 'wl') throw new Error('wl boom');
      return { stdout: panePayload([]), stderr: '' };
    });
    setExecFileAsync(mock as any);

    const query = await createProductionShipGuardQuery()();
    expect(query.worklogOutput).toBeNull();
    expect(query.paneOutput).not.toBeNull();

    const result = runShipGuard(query.worklogOutput ?? '', query.paneOutput ?? '');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('worklog list unavailable');
    expect(result.reason).not.toContain('pane list unavailable');
  });

  it('targets an explicit worklog root when cwd is provided', async () => {
    const calls: string[][] = [];
    const mock = vi.fn(async (bin: string, args: string[]) => {
      if (bin === 'wl') calls.push(args);
      return { stdout: idsPayload(1), stderr: '' };
    });
    setExecFileAsync(mock as any);

    await createProductionShipGuardQuery('/tmp/project-root')();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--worklog-dir');
    expect(calls[0]).toContain('/tmp/project-root/.worklog');
    expect(calls[0]).toContain('--fields');
  });
});
