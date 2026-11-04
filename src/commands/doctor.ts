/**
 * `wl doctor` command — registrar.
 *
 * Validates work items against the configured status/stage rules.
 *
 * Module layout (WL-0MVGKH1770008MNU): this file wires the root `doctor` command
 * definition and delegates every action to a single-concern module under
 * `src/commands/doctor/` — `notices.ts` (shared pending-upgrade/read-cache
 * helpers), `upgrade`, `stage-sync`, `prune`, `cache`, `foreign-items`,
 * `prefix`, `audit-gaps`, `dangling-parents`, `priority`, `file-paths`,
 * `migrate` and `validate` (the root action: findings aggregation, `--fix` and
 * notices). Each module registers itself and is passed a narrow typed context;
 * none imports back from this registrar.
 */

import type { PluginContext } from '../plugin-types.js';
import { registerCacheCommand } from './doctor/cache.js';
import { registerAuditGapsCommand } from './doctor/audit-gaps.js';
import { registerPrefixCommand } from './doctor/prefix.js';
import { registerDanglingParentsCommand } from './doctor/dangling-parents.js';
import { registerPriorityCommand } from './doctor/priority.js';
import { registerPruneCommand } from './doctor/prune.js';
import { registerFilePathsCommand } from './doctor/file-paths.js';
import { registerMigrateCommand } from './doctor/migrate.js';
import { registerForeignItemsCommand } from './doctor/foreign-items.js';
import { registerStageSyncCommand } from './doctor/stage-sync.js';
import { registerUpgradeCommand } from './doctor/upgrade.js';
import { registerValidateCommand } from './doctor/validate.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  const doctor = program
    .command('doctor')
    .description('Validate work items against status/stage config rules')
    .option('--fix', 'Apply safe fixes and prompt for non-safe findings')
    .option('--prefix <prefix>', 'Override the default prefix');

  registerUpgradeCommand(doctor, { output, utils, dataPath: ctx.dataPath });

  registerStageSyncCommand(doctor, { output, utils, dataPath: ctx.dataPath });

  registerPruneCommand(doctor, { output, utils, dataPath: ctx.dataPath });

  registerCacheCommand(doctor, { output, utils });

  registerForeignItemsCommand(doctor, { output, utils, dataPath: ctx.dataPath });

  registerPrefixCommand(doctor, { output, utils, dataPath: ctx.dataPath });

  registerAuditGapsCommand(doctor, { output, utils });

  registerDanglingParentsCommand(doctor, { output, utils, dataPath: ctx.dataPath });

  registerPriorityCommand(doctor, { output, utils, dataPath: ctx.dataPath });

  registerFilePathsCommand(doctor, { output, utils, dataPath: ctx.dataPath });

  registerMigrateCommand(doctor, { output, utils, dataPath: ctx.dataPath });

  registerValidateCommand(doctor, { output, dataPath: ctx.dataPath, utils });
}
