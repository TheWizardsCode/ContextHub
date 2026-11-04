/**
 * `wl doctor priority` subcommand.
 *
 * Single responsibility: register the `priority` subcommand, which detects
 * work items whose stored priority is not a canonical value and (with
 * `--apply`) fixes the mappable ones (`P0`-`P3` -> canonical priority).
 * Priority validation and mapping are delegated to
 * `src/validators/priority.ts`; this module only wires the CLI contract
 * (options, JSON/human rendering and the guarded mutation).
 *
 * Extracted from `src/commands/doctor.ts` (WL-0MW084EV700039PT, parent
 * WL-0MVGKH1770008MNU) as a move-only refactor: it imports only concrete
 * sibling modules and never imports from the registrar.
 */

import type { Command } from 'commander';
import type { WorklogDatabase } from '../../database.js';
import { withStoreMutationLock } from '../../mutation-lock.js';
import {
  normalizePriority,
  isValidPriority,
  isMappablePriority,
  CANONICAL_PRIORITIES,
} from '../../validators/priority.js';

/**
 * Narrow context the priority subcommand needs from the CLI registrar — never
 * the full `PluginContext` surface.
 */
export interface PriorityCommandContext {
  /** JSON payload emitter. */
  output: { json: (data: unknown) => void };
  /** Worklog data directory, used to serialise the mutating run. */
  dataPath: string;
  utils: {
    /** Fail loudly when the worklog is not initialised. */
    requireInitialized: () => void;
    /** Open the database, honouring the `--prefix` override. */
    getDatabase: (prefix?: string) => WorklogDatabase;
    /** Whether `--json` output mode was requested. */
    isJsonMode: () => boolean;
  };
}

/** Register the `wl doctor priority` subcommand on the parent `doctor` command. */
export function registerPriorityCommand(doctor: Command, ctx: PriorityCommandContext): void {
  const { output, dataPath, utils } = ctx;

  doctor
    .command('priority')
    .description('Detect and fix invalid priority values in the database')
    .option('--dry-run', 'Show invalid priorities without modifying them')
    .option('--apply', 'Apply priority mapping (P0-P3 -> canonical values)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (opts: { dryRun?: boolean; apply?: boolean; prefix?: string }) => {
      utils.requireInitialized();
      const db = utils.getDatabase(opts.prefix);
      const all = db.getAll();

      const invalid: Array<{ id: string; current: string; mapped?: string }> = [];

      for (const item of all) {
        const p = item.priority;
        if (p && !isValidPriority(p)) {
          const mapped = isMappablePriority(p) ? normalizePriority(p) : undefined;
          invalid.push({ id: item.id, current: p, mapped: mapped ?? undefined });
        }
      }

      if (invalid.length === 0) {
        if (utils.isJsonMode()) {
          output.json({ success: true, invalid: [], fixed: [] });
          return;
        }
        console.log('Doctor priority: no invalid priorities found.');
        return;
      }

      if (opts.dryRun || !opts.apply) {
        if (utils.isJsonMode()) {
          const out: any = { dryRun: true, invalid, count: invalid.length };
          if (!opts.dryRun) out.hint = 'Use --apply to fix invalid priorities';
          output.json(out);
          return;
        }
        console.log(`Doctor priority: found ${invalid.length} work item(s) with invalid priorities.`);
        console.log(`Canonical priority values: ${CANONICAL_PRIORITIES.join(', ')}`);
        console.log(`P* mapping: P0->critical, P1->high, P2->medium, P3->low`);
        console.log('');
        for (const entry of invalid) {
          const hint = entry.mapped ? ` (would map to "${entry.mapped}")` : ' (no mapping available)';
          console.log(` - ${entry.id}: current="${entry.current}"${hint}`);
        }
        if (!opts.dryRun) {
          console.log('');
          console.log('Use --dry-run to preview or --apply to apply the P* mapping.');
        }
        return;
      }

      // --apply: apply mapping for mappable values
      const fixed: Array<{ id: string; from: string; to: string }> = [];
      const unfixable: Array<{ id: string; current: string }> = [];

      withStoreMutationLock(dataPath, () => {
      for (const entry of invalid) {
        if (entry.mapped) {
          try {
            db.update(entry.id, { priority: entry.mapped as any });
            fixed.push({ id: entry.id, from: entry.current, to: entry.mapped });
          } catch (err) {
            unfixable.push({ id: entry.id, current: entry.current });
          }
        } else {
          unfixable.push({ id: entry.id, current: entry.current });
        }
      }
      });

      if (utils.isJsonMode()) {
        output.json({ fixed, unfixable, fixedCount: fixed.length, unfixableCount: unfixable.length });
        return;
      }

      console.log(`Doctor priority: fixed ${fixed.length} item(s).`);
      for (const f of fixed) {
        console.log(` - ${f.id}: "${f.from}" -> "${f.to}"`);
      }
      if (unfixable.length > 0) {
        console.log(`\n${unfixable.length} item(s) with unmappable priorities (requires manual fix):`);
        for (const u of unfixable) {
          console.log(` - ${u.id}: "${u.current}"`);
        }
      }
    });
}
