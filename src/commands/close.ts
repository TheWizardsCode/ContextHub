/**
 * Close command - Close one or more work items and record a close reason
 */

import type { PluginContext } from '../plugin-types.js';
import type { CloseOptions } from '../cli-types.js';
import { submitToOpenBrain } from '../openbrain.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;
  
  program
    .command('close')
    .description('Close one or more work items and record a close reason as a comment')
    .argument('<ids...>', 'Work item id(s) to close')
    .option('-r, --reason <reason>', 'Reason for closing (stored as a comment)', '')
    .option('-a, --author <author>', 'Author name for the close comment', 'worklog')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((ids: string[], options: CloseOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const isJsonMode = utils.isJsonMode();

      const results: Array<{ id: string; success: boolean; error?: string }> = [];

      for (const rawId of ids) {
        const normalizedId = utils.normalizeCliId(rawId, options.prefix) || rawId;
        const id = normalizedId.toUpperCase();
        const item = db.get(id);
        if (!item) {
          results.push({ id, success: false, error: 'Work item not found' });
          continue;
        }

        if (options.reason && options.reason.trim() !== '') {
          try {
            const comment = db.createComment({
              workItemId: id,
              author: options.author || 'worklog',
              comment: `Closed with reason: ${options.reason}`,
              references: []
            });
            if (!comment) {
              results.push({ id, success: false, error: 'Failed to create comment' });
              continue;
            }
          } catch (err) {
            results.push({ id, success: false, error: `Failed to create comment: ${(err as Error).message}` });
            continue;
          }
        }

        try {
          const updated = db.update(id, { status: 'completed' });
          if (!updated) {
            results.push({ id, success: false, error: 'Failed to update status' });
            continue;
          }
          results.push({ id, success: true });

          // Fire-and-forget: submit a summary to OpenBrain if enabled.
          const config = utils.getConfig();
          if (config?.openBrainEnabled) {
            submitToOpenBrain(updated).catch(() => {
              // Errors are already logged inside submitToOpenBrain; swallow here
              // so the close command is never blocked or aborted.
            });
          }
        } catch (err) {
          results.push({ id, success: false, error: (err as Error).message });
        }
      }

      if (isJsonMode) {
        output.json({ success: results.every(r => r.success), results });
      } else {
        for (const r of results) {
          if (r.success) {
            console.log(`Closed ${r.id}`);
          } else {
            console.error(`Failed to close ${r.id}: ${r.error}`);
          }
        }
      }
      if (!results.every(r => r.success)) process.exit(1);
    });
}
