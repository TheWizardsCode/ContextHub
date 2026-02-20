/**
 * Regression tests for fresh-install plugin loading.
 *
 * These tests verify that a fresh project (no node_modules) can run `wl`
 * commands without plugin-related errors.  They guard against the bug where
 * the stats plugin imported `chalk`, which could not be resolved relative to
 * the plugin's location in `.worklog/plugins/`.
 *
 * Related work item: WL-0MLU6HA2T0LQNJME
 */

import { describe, it, expect } from 'vitest';
import {
  cliPath,
  execAsync,
  execWithInput,
  enterTempDir,
  leaveTempDir,
} from './cli-helpers.js';
import { initRepo } from './git-helpers.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';

/** Standard init flags that skip interactive prompts. */
const INIT_FLAGS = [
  '--project-name "FreshTest"',
  '--prefix FRESH',
  '--auto-export yes',
  '--auto-sync no',
  '--workflow-inline no',
  '--agents-template skip',
  '--stats-plugin-overwrite no',
].join(' ');

/**
 * Extract the first valid JSON object from mixed stdout.
 *
 * The first-init code path in init.ts prints non-JSON headings (from
 * `initConfig`) before emitting the JSON payload.  This helper finds
 * and parses the first `{...}` JSON object in the output.
 */
function extractJson(raw: string): any {
  const start = raw.indexOf('{');
  if (start < 0) throw new SyntaxError(`No JSON object found in output: ${raw.slice(0, 200)}`);
  // Find matching closing brace (handle nested objects)
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') depth--;
    if (depth === 0) {
      return JSON.parse(raw.slice(start, i + 1));
    }
  }
  throw new SyntaxError(`Unmatched braces in JSON output: ${raw.slice(0, 200)}`);
}

describe('Fresh-install plugin loading', () => {
  /**
   * AC 1 -- `wl init --json` in a temp dir must not emit plugin errors on
   * stderr (no "Failed to load plugin" or "Cannot find package").
   */
  it('wl init --json produces clean stderr (no plugin errors)', async () => {
    const tempState = enterTempDir();
    try {
      await initRepo(tempState.tempDir);

      const { stdout, stderr } = await execAsync(
        `tsx ${cliPath} init --json ${INIT_FLAGS}`,
      );

      // stderr must not mention plugin loading failures
      expect(stderr).not.toMatch(/Failed to load plugin/i);
      expect(stderr).not.toMatch(/Cannot find package/i);
      expect(stderr).not.toMatch(/Cannot find module/i);

      // stdout contains mixed text; extract the JSON payload
      const result = extractJson(stdout);
      expect(result.success).toBe(true);
    } finally {
      leaveTempDir(tempState);
    }
  });

  /**
   * AC 2 -- `wl stats --json` works in a fresh project and returns valid JSON
   * with `success: true`.
   *
   * The `stats` command is provided by a plugin, so we must run the full CLI
   * as a subprocess to ensure the plugin loader is invoked.  We use a separate
   * temp directory with `cwd` to avoid chdir-related issues with other tests.
   */
  it('wl stats --json returns valid JSON after fresh init', async () => {
    const tempDir = createTempDir();
    try {
      await initRepo(tempDir);

      // Init the project (runs as subprocess since it's an init command)
      await execAsync(
        `tsx ${cliPath} init ${INIT_FLAGS}`,
        { cwd: tempDir },
      );

      // Run stats as a subprocess so plugins get loaded.
      // execWithInput always spawns a child process (unlike execAsync which
      // runs non-init commands in-process and would skip plugin loading).
      const { stdout, stderr, exitCode } = await execWithInput(
        `tsx ${cliPath} --json stats`,
        '',
        { cwd: tempDir },
      );

      expect(stderr).not.toMatch(/Failed to load plugin/i);
      expect(stderr).not.toMatch(/Cannot find package/i);
      expect(stderr).not.toMatch(/Cannot find module/i);

      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
    } finally {
      cleanupTempDir(tempDir);
    }
  }, 30000);

  /**
   * AC 3 -- `wl list --json --verbose` after init must not contain plugin
   * errors.  The `--verbose` flag should show plugin diagnostic info via
   * logger.debug, not via error messages.
   *
   * We use `execWithInput` to run as a subprocess so the full plugin loader
   * is exercised.
   */
  it('wl list --json --verbose shows no plugin errors', async () => {
    const tempDir = createTempDir();
    try {
      await initRepo(tempDir);

      await execAsync(
        `tsx ${cliPath} init ${INIT_FLAGS}`,
        { cwd: tempDir },
      );

      const { stderr } = await execWithInput(
        `tsx ${cliPath} --json --verbose list`,
        '',
        { cwd: tempDir },
      );

      expect(stderr).not.toMatch(/Failed to load plugin/i);
      expect(stderr).not.toMatch(/Cannot find package/i);
      expect(stderr).not.toMatch(/Cannot find module/i);
    } finally {
      cleanupTempDir(tempDir);
    }
  }, 30000);

  /**
   * AC 4+5 -- Running `wl init --json` twice (first-init then re-init) must
   * include the `statsPlugin` field in both JSON responses, confirming that
   * both code paths install the stats plugin consistently.
   */
  it('first-init and re-init both include statsPlugin in JSON', async () => {
    const tempState = enterTempDir();
    try {
      await initRepo(tempState.tempDir);

      // First init
      const first = await execAsync(
        `tsx ${cliPath} init --json ${INIT_FLAGS}`,
      );
      const firstResult = extractJson(first.stdout);
      expect(firstResult.success).toBe(true);
      expect(firstResult).toHaveProperty('statsPlugin');

      // Re-init (same flags + overwrite no)
      const second = await execAsync(
        `tsx ${cliPath} init --json ${INIT_FLAGS}`,
      );
      const secondResult = extractJson(second.stdout);
      expect(secondResult.success).toBe(true);
      expect(secondResult).toHaveProperty('statsPlugin');

      // Neither should emit plugin errors
      expect(first.stderr).not.toMatch(/Failed to load plugin/i);
      expect(second.stderr).not.toMatch(/Failed to load plugin/i);
    } finally {
      leaveTempDir(tempState);
    }
  });
});
