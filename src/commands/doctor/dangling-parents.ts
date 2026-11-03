/**
 * `wl doctor dangling-parents` subcommand.
 *
 * Single responsibility: register the `dangling-parents` subcommand, which
 * detects items whose `parentId` references a non-existent work item (e.g.
 * `WL-NULL` artifacts) and optionally detaches them by setting `parentId` to
 * `null`. Detection itself is delegated to `src/doctor/parent-check.ts`; this
 * module only wires the CLI contract (options, JSON/human rendering and the
 * guarded mutation).
 *
 * Extracted from `src/commands/doctor.ts` (WL-0MW084C6I007TVYZ, parent
 * WL-0MVGKH1770008MNU) as a move-only refactor: it imports only concrete
 * sibling modules and never imports from the registrar.
 */

import type { Command } from 'commander';
import type { WorklogDatabase } from '../../database.js';
import { validateParentReferences } from '../../doctor/parent-check.js';
import { withStoreMutationLock } from '../../mutation-lock.js';

/**
 * Narrow context the dangling-parents subcommand needs from the CLI
 * registrar — never the full `PluginContext` surface.
 */
export interface DanglingParentsCommandContext {
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

/** Register the `wl doctor dangling-parents` subcommand on the parent `doctor` command. */
export function registerDanglingParentsCommand(
  doctor: Command,
  ctx: DanglingParentsCommandContext,
): void {
  const { output, dataPath, utils } = ctx;

  // ── Dangling parent references (WL-0MUJM2LV1000IHKR) ────────────────
  doctor
    .command('dangling-parents')
    .description(
      'Detect items whose parentId references a non-existent work item '
        + '(e.g. WL-NULL artifacts from --parent null without fix) and '
        + 'optionally fix them by setting parentId to null.',
    )
    .option('--dry-run', 'Show dangling references without modifying them')
    .option('--apply', 'Fix dangling parentId by setting it to null')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((opts: { dryRun?: boolean; apply?: boolean; prefix?: string }) => {
      utils.requireInitialized();
      const db = utils.getDatabase(opts.prefix);
      const all = db.getAll();
      const byId = new Map(all.map(item => [item.id, item]));

      const dangling = validateParentReferences(all).map(finding => ({
        id: finding.itemId,
        title: byId.get(finding.itemId)?.title || '',
        parentId: String((finding.context as { parentId?: unknown }).parentId ?? ''),
      }));

      if (dangling.length === 0) {
        if (utils.isJsonMode()) {
          output.json({ success: true, items: [], fixed: [] });
          return;
        }
        console.log('Doctor dangling-parents: no dangling parent references found.');
        return;
      }

      // Default is dry-run; --apply is required to change anything.
      if (opts.dryRun || !opts.apply) {
        if (utils.isJsonMode()) {
          const out: any = { dryRun: true, items: dangling, count: dangling.length };
          if (!opts.dryRun) {
            out.hint = 'Use --apply to fix by setting parentId to null';
          }
          output.json(out);
          return;
        }
        console.log(
          `Doctor dangling-parents: found ${dangling.length} work item(s) with dangling parent references.`,
        );
        for (const d of dangling) {
          console.log(`  - ${d.id}: "${d.title}" (parentId = ${d.parentId})`);
        }
        if (!opts.dryRun) {
          console.log('');
          console.log('Use --dry-run to preview or --apply to fix by setting parentId to null.');
        }
        return;
      }

      // --apply: detach every dangling item.
      const fixed: Array<{ id: string; parentId: string }> = [];
      withStoreMutationLock(dataPath, () => {
      for (const d of dangling) {
        db.update(d.id, { parentId: null });
        fixed.push({ id: d.id, parentId: d.parentId });
      }
      });
      if (utils.isJsonMode()) {
        output.json({ success: true, fixed });
        return;
      }
      console.log(
        `Doctor dangling-parents: fixed ${fixed.length} item(s) - parentId set to null.`,
      );
    });
}
