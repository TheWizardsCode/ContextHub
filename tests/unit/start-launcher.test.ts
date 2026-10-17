/**
 * tests/unit/start-launcher.test.ts — Pane-launcher diagnostics
 * (WL-0MVAY631M004RZ3Q).
 *
 * herdr starts the Worklog pane via `npx tsx src/start.ts`. That launcher
 * wraps the real plugin entry (index.ts) in a dynamic import so a
 * module-load failure — the ESM "does not provide an export named ..."
 * SyntaxError thrown when the vendored @worklog/shared is stale — is
 * caught and surfaced as an actionable diagnostic instead of the pane
 * exiting silently on startup.
 *
 * Covers: the diagnostic formatter (unit) and the launcher's end-to-end
 * behaviour against a fixture that reproduces the missing-export crash.
 */

import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatStartupError } from '../../packages/herdr/src/start.js';

describe('formatStartupError', () => {
  const missingExport =
    "SyntaxError: The requested module '@worklog/shared/icons' does not provide an export named 'needsProducerReviewIcon'";

  it('explains a missing shared export and points at the rebuild fix', () => {
    const msg = formatStartupError(new Error(missingExport));
    expect(msg).toContain(missingExport);
    // Actionable: names the stale shared code and the fix.
    expect(msg.toLowerCase()).toContain('stale');
    expect(msg).toContain('@worklog/shared');
    expect(msg).toContain('npm run build');
  });

  it('keeps the original message for unrelated startup errors', () => {
    const err = new Error("Cannot access 'modeSwitchWorker' before initialization");
    const msg = formatStartupError(err);
    expect(msg).toContain(err.message);
    expect(msg).toContain('npm run build');
  });

  it('handles non-Error throws without crashing', () => {
    const msg = formatStartupError('boom');
    expect(msg).toContain('boom');
  });
});

interface LauncherResult {
  code: number | null;
  output: string;
}

/** Run `npx tsx src/start.ts` from the herdr package and capture output + exit code. */
function runLauncher(env: Record<string, string>, timeoutMs = 60_000): Promise<LauncherResult> {
  return new Promise((resolve) => {
    // This test lives in tests/unit; the plugin entry lives in packages/herdr.
    const cwd = path.resolve(
      fileURLToPath(new URL('../..', import.meta.url)),
      'packages', 'herdr',
    );
    const child: ChildProcess = spawn('npx', ['tsx', 'src/start.ts'], {
      cwd,
      // stdin closed: the launcher's keep-open wait is TTY-gated, so with
      // no TTY it must exit promptly instead of blocking the test.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let output = '';
    let settled = false;
    const timer = setTimeout(
      () => finish(null),
      timeoutMs,
    );
    function finish(code: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      child.kill('SIGKILL');
      resolve({ code, output });
    }
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('exit', (code) => finish(code));
    child.on('error', () => finish(-1));
  });
}

describe('pane launcher (src/start.ts, end-to-end)', () => {
  it('surfaces a clear diagnostic on a missing shared export instead of dying silently', async () => {
    const { code, output } = await runLauncher({
      WORKLOG_PLUGIN_ENTRY: './__fixtures__/stale-entry.ts',
    });

    // The launcher exits non-zero but the failure is explained.
    expect(code).toBe(1);
    expect(output).toMatch(/does not provide an export named 'needsProducerReviewIcon'/);
    expect(output).toMatch(/npm run build/);
    expect(output.toLowerCase()).toContain('stale');
  }, 60_000);

  it('reports a non-zero exit and diagnostic when the entry module is missing', async () => {
    const { code, output } = await runLauncher({
      WORKLOG_PLUGIN_ENTRY: './__fixtures__/does-not-exist.ts',
    });
    expect(code).toBe(1);
    expect(output).toMatch(/npm run build/);
  }, 60_000);
});
