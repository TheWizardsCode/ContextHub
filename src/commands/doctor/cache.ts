/**
 * `wl doctor cache` subcommand.
 *
 * Single responsibility: register the `cache` subcommand, which reports and
 * optionally prunes the bounded read-cache state directory
 * (`<cache-dir>/state`). Cache maintenance is intentionally worklog-independent
 * (no `requireInitialized()`), so a stale cache can be reclaimed from anywhere.
 *
 * Extracted from `src/commands/doctor.ts` (WL-0MW08496O009JJTU, parent
 * WL-0MVGKH1770008MNU) as a move-only refactor: it imports only concrete
 * sibling modules and never imports from the registrar.
 */

import type { Command } from 'commander';
import { DAY_MS, formatCacheBytes } from './notices.js';
import {
  pruneStateDir,
  resolveCacheDir,
  DEFAULT_STATE_MAX_FILES,
  DEFAULT_STATE_TTL_MS,
} from '../../read-cache.js';

/**
 * Narrow context the cache subcommand needs from the CLI registrar — never the
 * full `PluginContext` surface.
 */
export interface CacheCommandContext {
  /** JSON payload emitter. */
  output: { json: (data: unknown) => void };
  /** Whether `--json` output mode was requested. */
  utils: { isJsonMode: () => boolean };
}

/** Register the `wl doctor cache` subcommand on the parent `doctor` command. */
export function registerCacheCommand(doctor: Command, ctx: CacheCommandContext): void {
  const { output, utils } = ctx;

  doctor
    .command('cache')
    .description('Report and prune the bounded read-cache state directory (<cache-dir>/state)')
    .option('--prune', 'Remove stale counters and enforce the file bound (default: report only)')
    .option('--dry-run', 'Report only — never delete anything (default)')
    .option('--max-files <n>', `Max per-worklog-dir counters to keep (default ${DEFAULT_STATE_MAX_FILES})`)
    .option('--ttl-days <n>', `Remove counters untouched for this many days (default ${DEFAULT_STATE_TTL_MS / 86_400_000})`)
    .action((opts: { prune?: boolean; dryRun?: boolean; maxFiles?: string; ttlDays?: string }) => {
      // Cache maintenance is worklog-independent: no `requireInitialized()`,
      // so a stale cache can be reclaimed from anywhere.
      const fail = (message: string): void => {
        if (utils.isJsonMode()) output.json({ success: false, error: message });
        else console.error(`Doctor cache failed: ${message}`);
        process.exitCode = 1;
      };

      const maxFiles = Number(String(opts.maxFiles ?? DEFAULT_STATE_MAX_FILES));
      const ttlDays = Number(String(opts.ttlDays ?? DEFAULT_STATE_TTL_MS / DAY_MS));
      if (!Number.isInteger(maxFiles) || maxFiles < 0) {
        fail(`--max-files must be a non-negative integer (got "${opts.maxFiles ?? ''}")`);
        return;
      }
      if (!Number.isFinite(ttlDays) || ttlDays < 0) {
        fail(`--ttl-days must be a non-negative number (got "${opts.ttlDays ?? ''}")`);
        return;
      }

      try {
        // `--prune` applies; `--dry-run` always wins when both are given.
        const dryRun = opts.prune !== true || opts.dryRun === true;
        const ttlMs = Math.floor(ttlDays * DAY_MS);
        const result = pruneStateDir(resolveCacheDir(), {
          maxFiles,
          ttlMs,
          dryRun,
          invalidateEntries: !dryRun,
        });

        if (utils.isJsonMode()) {
          output.json({ success: true, ...result, maxFiles, ttlMs });
          return;
        }

        console.log(`Read-cache state: ${result.stateDir}`);
        console.log(` - counters: ${result.filesScanned} (${formatCacheBytes(result.totalBytes)})`);
        console.log(` - stale by TTL: ${result.staleByTtl}`);
        console.log(` - over bound: ${result.overBound}`);
        console.log(` - bound: ${maxFiles} file(s), TTL ${ttlDays} day(s)`);
        if (result.dryRun) {
          console.log(
            `Dry run: would remove ${result.removed} counter(s), reclaiming ${formatCacheBytes(result.bytesReclaimed)}.`
          );
          if (result.removed > 0) console.log('Run `wl doctor cache --prune` to reclaim the space.');
        } else {
          console.log(
            `Removed ${result.removed} counter(s), reclaimed ${formatCacheBytes(result.bytesReclaimed)} (remaining: ${result.remaining}).`
          );
          if (result.invalidatedEntries > 0) {
            console.log(`Dropped ${result.invalidatedEntries} cache entr(y/ies) belonging to pruned counters.`);
          }
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });
}
