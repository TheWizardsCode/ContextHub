/**
 * Lazy per-command registry (F6 — WL-0MVFRRMX3003UPP3).
 *
 * `src/cli-main.ts` used to eagerly import all 30 command modules, so every
 * heavy-path invocation paid for the whole command graph. This module replaces
 * those 30 imports with a name → `() => import('./commands/x.js')` map resolved
 * on demand:
 *
 *   - `wl show <id> --json` loads **only** `src/commands/show.ts`;
 *   - `wl --help`, bare `wl`, `wl help <cmd>` and unknown commands load the
 *     full set (help must list everything);
 *   - if a loader rejects (missing/broken module, i.e. registry resolution
 *     failure) the CLI logs one warning and falls back to eager full
 *     registration, so lazy loading can never make the CLI unusable
 *     (parent AC5 — graceful degradation).
 *
 * Help grouping metadata stays in `cli-main.ts`; this module only owns
 * *loading*. `BUILT_IN_COMMAND_NAMES` is exported so the help formatter can
 * keep distinguishing built-ins from plugin commands without importing them.
 */

import type { PluginContext } from './plugin-types.js';
import { extractCommandFromArgv } from './read-cache-cli.js';

/** A command module's registration function. */
export type CommandModule = { default: (ctx: PluginContext) => void };

/** A lazy loader for one command module. */
export type CommandLoader = () => Promise<CommandModule>;

/**
 * Canonical built-in command names (no aliases), in registration order. This
 * is the set of keys in `COMMAND_LOADERS`.
 */
export const BUILT_IN_COMMAND_NAMES: readonly string[] = [
  'init',
  'status',
  'create',
  'list',
  'show',
  'update',
  'delete',
  'export',
  'import',
  'next',
  'in-progress',
  'sync',
  'github',
  'comment',
  'close',
  'recent',
  'plugins',
  'migrate',
  'dep',
  're-sort',
  'doctor',
  'reviewed',
  'interview',
  'search',
  'unlock',
  'audit',
  'audit-show',
  'audit-set',
  'audit-waive',
  'audit-unwaive',
  // Registration order is preserved from the pre-registry `builtInCommands`
  // array so the grouped help output stays byte-identical.
  'cleanup-worktree',
  'completion',
];

/** Names accepted on the command line beyond the canonical name. */
const COMMAND_ALIASES: Readonly<Record<string, string>> = {
  gh: 'github',
  in_progress: 'in-progress',
};

/**
 * Modules that register more than one command. The loader instance is shared
 * by every name in the group so the module's `register()` runs exactly once
 * (it registers all of its commands itself) — otherwise help (and commander)
 * would see duplicate command entries.
 */
const auditResultLoader: CommandLoader = () => import('./commands/audit-result.js');
const auditWaiveLoader: CommandLoader = () => import('./commands/audit-waive.js');

/**
 * The production loader map: every built-in command name to a dynamic import
 * of its module.
 */
export const COMMAND_LOADERS: Readonly<Record<string, CommandLoader>> = {
  init: () => import('./commands/init.js'),
  status: () => import('./commands/status.js'),
  create: () => import('./commands/create.js'),
  list: () => import('./commands/list.js'),
  show: () => import('./commands/show.js'),
  update: () => import('./commands/update.js'),
  delete: () => import('./commands/delete.js'),
  export: () => import('./commands/export.js'),
  import: () => import('./commands/import.js'),
  next: () => import('./commands/next.js'),
  'in-progress': () => import('./commands/in-progress.js'),
  sync: () => import('./commands/sync.js'),
  github: () => import('./commands/github.js'),
  comment: () => import('./commands/comment.js'),
  close: () => import('./commands/close.js'),
  recent: () => import('./commands/recent.js'),
  plugins: () => import('./commands/plugins.js'),
  migrate: () => import('./commands/migrate.js'),
  dep: () => import('./commands/dep.js'),
  're-sort': () => import('./commands/re-sort.js'),
  doctor: () => import('./commands/doctor.js'),
  reviewed: () => import('./commands/reviewed.js'),
  interview: () => import('./commands/interview.js'),
  search: () => import('./commands/search.js'),
  unlock: () => import('./commands/unlock.js'),
  audit: () => import('./commands/audit.js'),
  'audit-show': auditResultLoader,
  'audit-set': auditResultLoader,
  'audit-waive': auditWaiveLoader,
  'audit-unwaive': auditWaiveLoader,
  'cleanup-worktree': () => import('./commands/cleanup-worktree.js'),
  completion: () => import('./commands/completion.js'),
};

/** Options for `registerBuiltInCommands` (all optional; tests inject them). */
export interface RegisterCommandsOptions {
  /** Loader map override (default `COMMAND_LOADERS`). */
  loaders?: Readonly<Record<string, CommandLoader>>;
  /** Observer called for every command whose module load is attempted. */
  onLoad?: (name: string) => void;
  /** Sink for the single fallback warning (default `console.error`). */
  warn?: (message: string) => void;
}

/**
 * Build a loader map over an arbitrary load function. Used by tests (fault
 * injection) and by callers that need to instrument loading.
 */
export function createCommandLoaders(
  load: (name: string) => Promise<CommandModule>
): Record<string, CommandLoader> {
  const loaders: Record<string, CommandLoader> = {};
  for (const name of BUILT_IN_COMMAND_NAMES) {
    loaders[name] = () => load(name);
  }
  return loaders;
}

/**
 * Resolve the command the user asked for, canonicalising aliases.
 *
 * Returns `null` for a bare invocation (no command token) or for a token that
 * is not a built-in (unknown command, `help`, plugin commands) — both cases
 * need the full registration set.
 */
export function resolveBuiltInCommand(argv: readonly string[]): string | null {
  const token = extractCommandFromArgv([...argv]);
  if (token === null) return null;
  const canonical = COMMAND_ALIASES[token] ?? token;
  return canonical;
}

/** True when the invocation asks for help (commander `-h` / `--help`). */
function isHelpRequest(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

/**
 * Commands whose *output* enumerates every registered command, so they must
 * run with the full set registered: `wl completion <shell>` generates shell
 * completion from `program.commands`.
 */
const FULL_REGISTRATION_COMMANDS: ReadonlySet<string> = new Set(['completion']);

/**
 * Register built-in commands for this invocation.
 *
 * Single-command invocations load only that command's module. Everything else
 * (bare `wl`, help, unknown command) registers the full set eagerly, because
 * help output and commander's unknown-command handling need every command
 * present. A failing loader triggers exactly one warning and a full eager
 * fallback (parent AC5): the CLI degrades to today's behaviour instead of
 * losing commands.
 */
export async function registerBuiltInCommands(
  ctx: PluginContext,
  argv: readonly string[],
  options: RegisterCommandsOptions = {}
): Promise<void> {
  const loaders = options.loaders ?? COMMAND_LOADERS;
  const onLoad = options.onLoad ?? (() => {});
  const warn = options.warn ?? ((message: string) => console.error(message));

  const registerOne = async (name: string): Promise<boolean> => {
    onLoad(name);
    try {
      const module = await loaders[name]();
      module.default(ctx);
      return true;
    } catch {
      return false;
    }
  };

  const requested = resolveBuiltInCommand(argv);
  const single =
    requested !== null &&
    requested in loaders &&
    !isHelpRequest(argv) &&
    !FULL_REGISTRATION_COMMANDS.has(requested)
      ? requested
      : null;

  let lazyFailed = false;
  if (single !== null) {
    if (await registerOne(single)) return;
    lazyFailed = true;
  }

  // Eager registration: help/bare/unknown invocations, or the fallback path
  // after a failed lazy load. Every other command is attempted so one broken
  // module cannot take the rest of the CLI down with it. Grouped commands
  // share one loader instance, so each module registers exactly once.
  const failed: string[] = [];
  const attempted = new Set<CommandLoader>();
  for (const name of Object.keys(loaders)) {
    if (name === single) continue; // already attempted above
    const loader = loaders[name];
    if (attempted.has(loader)) continue;
    attempted.add(loader);
    if (!(await registerOne(name))) failed.push(name);
  }

  if (lazyFailed || failed.length > 0) {
    const detail = failed.length > 0 ? `; could not load: ${failed.join(', ')}` : '';
    warn(
      `[wl] command registry fallback: ${
        lazyFailed ? `lazy load of '${single}' failed` : 'eager registration incomplete'
      } — registered ${Object.keys(loaders).length - failed.length}/${Object.keys(loaders).length} commands${detail}`
    );
  }
}
