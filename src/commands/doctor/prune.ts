/**
 * `wl doctor prune` subcommand.
 *
 * Single responsibility: register the `prune` subcommand, which hard-deletes
 * soft-deleted work items older than an age threshold (with `--dry-run` to
 * preview), skipping items linked to GitHub whose local state is newer than
 * the last recorded GitHub state so issues are never orphaned. Candidate
 * selection and the guarded deletion live here; this module only owns the
 * CLI contract (options, JSON/human rendering and the mutation lock).
 *
 * Extracted from `src/commands/doctor.ts` (WL-0MW084GHU009FV66, parent
 * WL-0MVGKH1770008MNU) as a move-only refactor: it imports only concrete
 * sibling modules and never imports from the registrar.
 */

import type { Command } from 'commander';
import type { WorklogDatabase } from '../../database.js';
import type { WorkItem } from '../../types.js';
import { withStoreMutationLock } from '../../mutation-lock.js';

/**
 * Narrow context the prune subcommand needs from the CLI registrar — never
 * the full `PluginContext` surface.
 */
export interface PruneCommandContext {
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

/** Register the `wl doctor prune` subcommand on the parent `doctor` command. */
export function registerPruneCommand(doctor: Command, ctx: PruneCommandContext): void {
  const { output, dataPath, utils } = ctx;

  doctor
    .command('prune')
    .description('Prune soft-deleted work items older than a specified age')
    .option('--days <n>', 'Age threshold in days (items with updatedAt older than this will be pruned)', '30')
    .option('--dry-run', 'Show which items would be pruned without deleting them')
    .option('--cascade-children', 'Also hard-delete live children of a pruned parent (destructive; requires explicit opt-in)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (opts: { days?: string; dryRun?: boolean; cascadeChildren?: boolean; prefix?: string }) => {
      utils.requireInitialized();
      try {
        const days = Math.max(0, parseInt(String(opts.days ?? '30'), 10) || 0);
        const db = utils.getDatabase(opts.prefix);

        const now = Date.now();
        const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).getTime();

        const all = db.getAll();
        const candidates = all.filter(i => i.status === 'deleted').filter(i => {
          const ts = i.updatedAt ? Date.parse(i.updatedAt) : Date.parse(i.createdAt);
          return !Number.isNaN(ts) && ts < cutoff;
        });

        // Index children by parent so we can detect candidates that still
        // have live children (cascade-or-refuse, R1).
        const childrenOf = new Map<string, WorkItem[]>();
        for (const item of all) {
          if (item.parentId) {
            const siblings = childrenOf.get(item.parentId) ?? [];
            siblings.push(item);
            childrenOf.set(item.parentId, siblings);
          }
        }
        // A child is "live" when it is not itself deleted — a soft-deleted
        // child is on its own way to prune and does not hold the parent.
        const liveChildrenOf = (id: string): WorkItem[] =>
          (childrenOf.get(id) ?? []).filter(c => c.status !== 'deleted');

        // Skip items that are linked to GitHub and appear to have local changes
        // newer than the last recorded GitHub state. This prevents orphaning
        // GitHub issues by deleting items that have local updates not yet
        // reflected on GitHub.
        const skippedIds: string[] = [];
        const prunable = candidates.filter(i => {
          if (i.githubIssueNumber !== undefined && i.githubIssueNumber !== null) {
            const localTs = i.updatedAt ? Date.parse(i.updatedAt) : Date.parse(i.createdAt);
            const ghTs = i.githubIssueUpdatedAt ? Date.parse(i.githubIssueUpdatedAt) : 0;
            if (!Number.isNaN(localTs) && !Number.isNaN(ghTs) && localTs > ghTs) {
              skippedIds.push(i.id);
              return false;
            }
          }
          return true;
        });

        // Cascade-or-refuse (R1): a candidate that still has live children is
        // refused unless the explicit `--cascade-children` opt-in is present.
        const refusedIds = opts.cascadeChildren
          ? []
          : prunable.filter(i => liveChildrenOf(i.id).length > 0).map(i => i.id);
        const refused = new Set(refusedIds);
        const ids = prunable.filter(i => !refused.has(i.id)).map(c => c.id);

        if (opts.dryRun) {
          if (utils.isJsonMode()) {
            output.json({ dryRun: true, candidates: ids, refusedIds, skippedIds, count: ids.length });
            return;
          }
          console.log(`Prune dry-run: ${ids.length} deleted item(s) older than ${days} day(s)`);
          ids.forEach(id => console.log(` - ${id}`));
          if (refusedIds.length > 0) {
            console.log(`Refused (has live children; use --cascade-children to force): ${refusedIds.length}`);
            refusedIds.forEach(id => console.log(` - ${id}`));
          }
          if (skippedIds.length > 0) {
            console.log('Skipped (linked to GitHub with newer local changes):');
            skippedIds.forEach(id => console.log(` - ${id}`));
          }
          return;
        }

        // Perform deletions against the persistent store. Use internal store
        // deleteWorkItem to perform a hard-delete (removes dependency edges and comments).
        const pruned: string[] = [];
        const storeAny = (db as any).store;
        // Descendants of an item, deepest-first, so cascade prunes children
        // before their parents (matching the shared deleteWorkItem order).
        const descendantsDeepestFirst = (id: string): string[] => {
          const out: string[] = [];
          const depths = new Map<string, number>();
          const depthOf = (itemId: string): number => {
            const cached = depths.get(itemId);
            if (cached !== undefined) return cached;
            const item = all.find(i => i.id === itemId);
            const d = item?.parentId ? depthOf(item.parentId) + 1 : 0;
            depths.set(itemId, d);
            return d;
          };
          const walk = (pid: string): void => {
            for (const child of childrenOf.get(pid) ?? []) {
              walk(child.id);
              out.push(child.id);
            }
          };
          walk(id);
          return out.sort((a, b) => depthOf(b) - depthOf(a));
        };
        const hardDelete = (targetId: string): boolean => {
          if (storeAny && typeof storeAny.deleteWorkItem === 'function') {
            const ok = storeAny.deleteWorkItem(targetId);
            if (ok) {
              // Also remove any lingering dependency edges/comments via store helpers
              try { storeAny.deleteDependencyEdgesForItem(targetId); } catch (_) {}
              pruned.push(targetId);
            }
            return ok;
          }
          return false;
        };
        // Track rows already hard-deleted so a descendant that is itself a
        // prune candidate is not deleted twice (its second deleteWorkItem
        // returns false and would be mis-reported as a failure).
        const deleted = new Set<string>();
        await withStoreMutationLock(dataPath, async () => {
        for (const id of ids) {
          try {
            if (storeAny && typeof storeAny.deleteWorkItem === 'function') {
              // Cascade-or-refuse opt-in: hard-delete children (deepest first)
              // before the parent so no live child is left pointing at a parent
              // that no longer exists.
              const targets = opts.cascadeChildren
                ? [id, ...descendantsDeepestFirst(id)]
                : [id];
              let allOk = true;
              for (const targetId of targets) {
                if (deleted.has(targetId)) continue;
                if (hardDelete(targetId)) {
                  deleted.add(targetId);
                } else {
                  allOk = false;
                }
              }
              if (!allOk) {
                console.error(`Failed to prune (or cascade) ${id}: one or more store deletes returned false`);
              }
            } else if (typeof (db as any).delete === 'function') {
              // Fall back to WorklogDatabase.delete() which marks item as deleted
              const ok = await Promise.resolve((db as any).delete(id));
              if (ok) pruned.push(id);
            } else {
              console.error('Unable to perform prune: persistent store delete method not found');
              break;
            }
          } catch (err) {
            // Continue with other deletions but report error
            console.error(`Failed to prune ${id}: ${(err instanceof Error) ? err.message : String(err)}`);
          }
        }
        // Ephemeral JSONL pattern: SQLite is the runtime source of truth, and
        // the on-disk JSONL is only a transient sync artifact. A hard-delete
        // leaves any lingering JSONL stale; when the prune empties the store,
        // the next open would re-import it and resurrect the pruned rows. Drop
        // the stale artifact while the mutation lock is still held (so a
        // concurrent `wl sync`, which holds the same lock, cannot interleave).
        if (pruned.length > 0) {
          try { db.deleteLocalJsonl(); } catch (_) { /* best-effort */ }
        }
        });

        if (utils.isJsonMode()) {
          output.json({ dryRun: false, prunedIds: pruned, refusedIds, skippedIds, count: pruned.length });
          return;
        }

        console.log(`Pruned ${pruned.length} work item(s).`);
        if (pruned.length > 0) {
          console.log('Pruned IDs:');
          pruned.forEach(id => console.log(` - ${id}`));
        }
        if (refusedIds.length > 0) {
          console.log(`Refused (has live children; use --cascade-children to force): ${refusedIds.length}`);
          refusedIds.forEach(id => console.log(` - ${id}`));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (utils.isJsonMode()) output.json({ success: false, error: message });
        else console.error(`Doctor prune failed: ${message}`);
      }
    });
}
