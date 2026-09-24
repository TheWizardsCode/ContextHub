/**
 * Plugin startup regression test (WL-0MUFRFLRQ004KNDG).
 *
 * The worklist plugin crashed on initialization with a temporal-dead-zone
 * ReferenceError: `createDowntimeWorker` calls its `config()` callback
 * SYNCHRONOUSLY during construction, and index.ts's callback referenced the
 * `modeSwitchWorker` const that is declared AFTER the downtime worker — so
 * the whole plugin died before the TUI ever rendered.
 *
 * This is an end-to-end guard: it runs the real entry point (the same command
 * herdr's pane manifest uses, `npx tsx src/index.ts`) and asserts it reaches
 * the TUI instead of crashing during wiring.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface StartupResult {
  code: number | null;
  output: string;
}

/** Run the plugin entry point and resolve with its combined output. */
function runPluginStartup(cwd: string, timeoutMs: number): Promise<StartupResult> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd,
      // stdin is closed so the TUI tears down instead of blocking on input.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HERDR_PANE_ID: '' },
    });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => finish(null), timeoutMs);
    function finish(code: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      child.kill('SIGKILL'); // the TUI runs a render loop until killed
      resolve({ code, output });
    }
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
      // Resolve as soon as the outcome is observable: the rendered TUI frame
      // (construction completed) or the init-error prefix (it crashed).
      if (output.includes('Work Items') || /before initialization|Worklog plugin error/.test(output)) {
        finish(null);
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('exit', (code) => finish(code));
    child.on('error', (err) => {
      output += `spawn error: ${String(err)}`;
      finish(null);
    });
  });
}

describe('worklist plugin startup (WL-0MUFRFLRQ004KNDG)', () => {
  it(
    'initializes past worker wiring without the modeSwitchWorker TDZ crash',
    async () => {
      const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
      const { output } = await runPluginStartup(pluginRoot, 30_000);

      // The exact TDZ failure that crashed the plugin at startup.
      expect(output).not.toMatch(/Cannot access 'modeSwitchWorker' before initialization/);
      expect(output).not.toMatch(/before initialization/);
      // Any init failure is surfaced on this prefix; none is allowed.
      expect(output).not.toMatch(/Worklog plugin error/);

      // Reaching the TUI proves construction completed past the downtime
      // worker (where config() runs synchronously) into the render loop.
      expect(output).toContain('Work Items');
    },
    60_000,
  );
});
