/**
 * Reviewed command - Toggle or set needsProducerReview flag
 */

import type { PluginContext } from '../plugin-types.js';

const TRUTHY = ['true', 'yes', '1'];
const FALSY = ['false', 'no', '0'];

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  program
    .command('reviewed <id> [value]')
    .description('Toggle or set needsProducerReview flag (true|false|yes|no). If value omitted, toggles current state')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((id: string, value: string | undefined, options: { prefix?: string } = {}) => {
      const normalized = (value && typeof value === 'object') ? (value as { prefix?: string }) : options;
      const valueArg = (value && typeof value === 'object') ? undefined : value;
      utils.requireInitialized();
      const db = utils.getDatabase(normalized.prefix);
      const normalizedId = utils.normalizeCliId(id, normalized.prefix) || id;
      const item = db.get(normalizedId.toUpperCase());
      if (!item) {
        output.error(`Work item not found: ${normalizedId}`, { success: false, error: `Work item not found: ${normalizedId}` });
        process.exit(1);
      }

      let nextValue: boolean | undefined;
      if (valueArg === undefined) {
        nextValue = !Boolean(item.needsProducerReview);
      } else {
        const raw = String(valueArg).toLowerCase();
        if (TRUTHY.includes(raw)) nextValue = true;
        else if (FALSY.includes(raw)) nextValue = false;
        else {
          output.error(`Invalid value for reviewed: ${valueArg}`, { success: false, error: 'invalid-arg' });
          process.exit(1);
        }
      }

      const updated = db.update(item.id, { needsProducerReview: nextValue });
      if (!updated) {
        output.error(`Failed to update work item: ${item.id}`, { success: false, error: 'update-failed' });
        process.exit(1);
      }

      if (utils.isJsonMode()) {
        output.json({ success: true, workItem: updated });
      } else {
        const state = nextValue ? 'true' : 'false';
        console.log(`needsProducerReview set to ${state} for ${item.id}`);
      }
    });
}
