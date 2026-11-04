/**
 * `wl doctor prefix` subcommand.
 *
 * Single responsibility: register the `prefix` subcommand, which previews
 * (default) or applies a project ID-prefix rename. The rename itself — every
 * ID-bearing record, the config prefix and the rename map — is delegated to
 * `src/doctor/prefix-check.ts`; this module only wires the CLI contract
 * (options, confirmation prompt, JSON/human rendering and exit code).
 *
 * Extracted from `src/commands/doctor.ts` (WL-0MW0845IS003VCTK, parent
 * WL-0MVGKH1770008MNU) as a move-only refactor: it imports only concrete
 * sibling modules and never imports from the registrar.
 */

import type { Command } from 'commander';
import type { WorklogDatabase } from '../../database.js';
import {
  runPrefixRename,
  type PrefixRenameRunResult,
} from '../../doctor/prefix-check.js';
import { getConfigPath } from '../../config.js';
import { withStoreMutationLock } from '../../mutation-lock.js';

/**
 * Narrow context the prefix subcommand needs from the CLI registrar — never
 * the full `PluginContext` surface.
 */
export interface PrefixCommandContext {
  /** JSON payload emitter. */
  output: { json: (data: unknown) => void };
  /** Worklog data directory, used to serialise the mutating run. */
  dataPath: string;
  utils: {
    /** Fail loudly when the worklog is not initialised. */
    requireInitialized: () => void;
    /** Read the project config (its `prefix` seeds the rename source). */
    getConfig: () => { prefix?: string } | undefined | null;
    /** Open the database, honouring the `--prefix` override. */
    getDatabase: (prefix?: string) => WorklogDatabase;
    /** Whether `--json` output mode was requested. */
    isJsonMode: () => boolean;
  };
}

/** Register the `wl doctor prefix` subcommand on the parent `doctor` command. */
export function registerPrefixCommand(doctor: Command, ctx: PrefixCommandContext): void {
  const { output, dataPath, utils } = ctx;

  // ── Prefix rename (WL-0MVZ2U4E0003IVSZ, parent WL-0MVM8V79C003XH2J) ──
  doctor
    .command('prefix')
    .description(
      'Preview (default) or apply a project ID-prefix rename: rewrites every ID-bearing record, ' +
      'the config prefix and a rename map',
    )
    .option('--to <prefix>', 'Target ID prefix (ASCII letters and digits only)')
    .option('--apply', 'Request the rename; prompts for confirmation and fails closed without a TTY')
    .option('--confirm', 'Apply the rename without prompting (non-interactive)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (opts: { to?: string; apply?: boolean; confirm?: boolean; prefix?: string }) => {
      utils.requireInitialized();
      const result: PrefixRenameRunResult = await runPrefixRename({
        opts,
        configPrefix: utils.getConfig()?.prefix ?? null,
        dataPath,
        configPath: getConfigPath(),
        isJsonMode: utils.isJsonMode(),
        stdinIsTTY: Boolean(process.stdin.isTTY),
        db: utils.getDatabase(opts.prefix),
        withMutationLock: (fn) => withStoreMutationLock(dataPath, fn),
        prompt: async (question: string) => {
          const readlineMod = await import('node:readline');
          return new Promise<string>((resolve) => {
            const rl = readlineMod.createInterface({ input: process.stdin, output: process.stdout });
            rl.question(question, (answer: string) => {
              rl.close();
              resolve(answer);
            });
          });
        },
      });

      if (utils.isJsonMode()) {
        output.json(result.json);
      } else if (result.error) {
        console.error(`Doctor prefix: ${result.error}`);
      } else {
        for (const line of result.lines) console.log(line);
      }
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    });
}
