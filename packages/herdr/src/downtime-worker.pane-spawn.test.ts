/**
 * packages/herdr/src/downtime-worker.pane-spawn.test.ts — characterisation of
 * the real `defaultDowntimeSpawn` boundary.
 *
 * Extracted with the pane module (WL-0MVLIHZBT006B1UI): the pane suite covers
 * the pane spawn surface with an injectable `spawnFn`, but nothing exercised
 * `defaultDowntimeSpawn` — the module's own wiring of `node:child_process`
 * `spawn` through `buildDowntimeSpawnOptions` plus the probe window in
 * `spawnDowntimePane`. These tests pin the exported default boundary end to
 * end WITHOUT mocked seams, using real short-lived child processes
 * (`process.execPath -e 'process.exit(n)'`), so a future refactor that re-wires
 * the default spawn (e.g. a flag, a timeout or an env change) is caught here.
 *
 * Observability contract (WL-0MSLWJ3I70031Z8U AC2): a failed spawn is always
 * reported `{ ok: false }` and is never logged as a successful dispatch.
 *
 * Load-sensitivity note (WL-0MVOTIJ2U000JI44): each test passes a generous
 * `opts.probeMs` (10 s) because the probe window is a *fallback deadline*, not
 * a timing assertion — under host load, real `node` interpreter startup can
 * exceed the 500 ms production default (observed ~0.56 s at load average ~28),
 * so a racing probe would resolve `{ ok: true }` before the child's exit event
 * fired. The 10 s bound keeps the end-to-end boundary characterisation while
 * removing the flaky probe race; the default window itself is pinned by
 * `downtime-worker.pane.test.ts` with an injected spawn boundary.
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultDowntimeSpawn, spawnDowntimePane } from './downtime-worker.js';

describe('defaultDowntimeSpawn (real spawn boundary)', () => {
  it('reports a missing launcher script as { ok: false } via the error handler', async () => {
    const missing = path.join(os.tmpdir(), 'worklog-no-such-send-to-pi.sh');
    const result = await spawnDowntimePane(
      missing,
      [],
      { cwd: os.tmpdir(), probeMs: 10_000 },
      defaultDowntimeSpawn,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // ENOENT surfaces as the spawn `error` event → error trace captured.
      // The message text is Node/libuv-version dependent ("ENOENT" vs
      // "no such file or directory"), so assert the observable contract —
      // a truthy error trace naming the failure — not an OS-specific string.
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/ENOENT|no such file or directory/i);
    }
  });

  it('reports a non-zero launcher exit as { ok: false, exitCode } via the exit handler', async () => {
    const result = await spawnDowntimePane(
      process.execPath,
      ['-e', 'process.exit(3)'],
      { cwd: os.tmpdir(), probeMs: 10_000 },
      defaultDowntimeSpawn,
    );

    expect(result).toEqual({ ok: false, exitCode: 3 });
  });

  it('resolves { ok: true } when the launcher exits zero within the probe window', async () => {
    const result = await spawnDowntimePane(
      process.execPath,
      ['-e', 'process.exit(0)'],
      { cwd: os.tmpdir(), probeMs: 10_000 },
      defaultDowntimeSpawn,
    );

    expect(result).toEqual({ ok: true });
  });
});
