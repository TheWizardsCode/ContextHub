/**
 * Unit tests for the extracted `wl doctor cache` registration seam
 * (`src/commands/doctor/cache.ts`, WL-0MW08496O009JJTU).
 *
 * `tests/cli/doctor-cache.test.ts` covers the subcommand end-to-end through the
 * real CLI (unchanged by the extraction); this file pins the extracted module's
 * own contract: it registers the same command surface on the parent `doctor`
 * command and reaches its output through the narrow injected context, never the
 * registrar or the full `PluginContext`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import * as path from 'path';
import { registerCacheCommand } from '../src/commands/doctor/cache.js';
import { createTempDir, cleanupTempDir } from './test-utils.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function buildProgram(jsonMode: boolean, onJson: (data: unknown) => void): Command {
  const program = new Command();
  const doctor = program.command('doctor');
  registerCacheCommand(doctor, {
    output: { json: onJson },
    utils: { isJsonMode: () => jsonMode },
  });
  return program;
}

describe('registerCacheCommand', () => {
  let tempDir: string;
  let cacheDir: string;
  let previousCacheDir: string | undefined;

  beforeEach(() => {
    tempDir = createTempDir();
    cacheDir = path.join(tempDir, 'cache');
    previousCacheDir = process.env.WL_CACHE_DIR;
    process.env.WL_CACHE_DIR = cacheDir;
    process.exitCode = 0;
  });

  afterEach(() => {
    if (previousCacheDir === undefined) delete process.env.WL_CACHE_DIR;
    else process.env.WL_CACHE_DIR = previousCacheDir;
    process.exitCode = 0;
    cleanupTempDir(tempDir);
  });

  it('registers the cache subcommand with unchanged flags and description', () => {
    const doctor = new Command();
    registerCacheCommand(doctor, {
      output: { json: () => {} },
      utils: { isJsonMode: () => false },
    });

    const cache = doctor.commands.find((c) => c.name() === 'cache');
    expect(cache).toBeDefined();
    expect(cache!.description()).toBe(
      'Report and prune the bounded read-cache state directory (<cache-dir>/state)',
    );
    expect(cache!.options.map((o) => o.flags)).toEqual([
      '--prune',
      '--dry-run',
      '--max-files <n>',
      '--ttl-days <n>',
    ]);
  });

  it('emits the report through the injected --json context using the isolated cache dir', async () => {
    let payload: any;
    const program = buildProgram(true, (data) => {
      payload = data;
    });

    await program.parseAsync(['node', 'wl', 'doctor', 'cache', '--dry-run']);

    expect(payload.success).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(payload.filesScanned).toBe(0);
    expect(payload.maxFiles).toBe(1000);
    expect(payload.ttlMs).toBe(7 * DAY_MS);
    expect(payload.stateDir).toBe(path.join(cacheDir, 'state'));
  });

  it('rejects an invalid option value through the injected context and exits non-zero', async () => {
    let payload: any;
    const program = buildProgram(true, (data) => {
      payload = data;
    });

    await program.parseAsync(['node', 'wl', 'doctor', 'cache', '--max-files', 'abc']);

    expect(payload.success).toBe(false);
    expect(payload.error).toContain('--max-files');
    expect(process.exitCode).toBe(1);
  });
});
