/**
 * Heavy CLI graph (F4 — WL-0MVFRRKKN00544PQ).
 *
 * This module is the *miss* path: every command module, the plugin loader, the
 * SQLite runtime, Commander and the help formatter live here and are loaded
 * only when `src/cli.ts` (the thin fast path) could not serve the invocation
 * from the read cache and the invocation is not `--version`. Keeping this
 * graph out of `src/cli.ts` is what makes warm cache hits cheap
 * (parent AC1 — WL-0MVFNMSRW002FI6B).
 *
 * The fast path owns argv normalisation, the `--worklog-dir` override, the
 * worktree process registration and the cache lookup; it injects the shared
 * `ReadCacheCli` (so cache backfill and write invalidation keep working) and
 * the cache-enabled flag into `main()`.
 */

import { Command } from 'commander';
import { createPluginContext, getVersion } from './cli-utils.js';
import { loadPlugins } from './plugin-loader.js';
import { renderCliMarkdown, resolveMarkdownEnabled } from './cli-output.js';
import { loadConfig } from './config.js';
import { initializeRuntime } from './lib/runtime.js';

// Import built-in command modules
import {
  registerBuiltInCommands,
  BUILT_IN_COMMAND_NAMES,
} from './command-registry.js';
import { setWorklogDirOverride } from './worklog-paths.js';
import {
  shouldCacheReadInvocation,
  isPureReadCommand,
  type ReadCacheCli,
} from './read-cache-cli.js';

export interface CliMainOptions {
  /** Shared read-cache orchestration instance from the fast path. */
  cache: ReadCacheCli;
  /** Whether the read cache is enabled (WL_CACHE_DISABLED unset). */
  cacheEnabled: boolean;
}

/**
 * Build and run the full Commander program (registration, plugins, runtime,
 * help formatting) and dispatch the invocation. Returns once the command has
 * been dispatched; the process then exits normally.
 */
export async function main({ cache, cacheEnabled }: CliMainOptions): Promise<void> {
  // Allowed formats for validation
  const ALLOWED_FORMATS = new Set(['concise', 'summary', 'normal', 'full', 'raw', 'markdown', 'text', 'plain', 'auto']);

  function isValidFormat(fmt: any): boolean {
    if (!fmt || typeof fmt !== 'string') return false;
    return ALLOWED_FORMATS.has(fmt.toLowerCase());
  }

  // Create commander program
  const program = new Command();

  program
    .name('worklog')
    .description('CLI for Worklog - an issue tracker for agents')
    .version(getVersion())
    .option('--json', 'Output in JSON format (machine-readable)')
    .option('--verbose', 'Show verbose output including debug messages')
    .option('-F, --format <format>', 'Human display format (choices: full|summary|concise|normal|raw|markdown|plain|text|auto)')
    .option('-w, --watch [seconds]', 'Rerun the command every N seconds (default: 5)')
    .option('--worklog-dir <path>', 'Explicit path to .worklog directory (bypasses automatic directory resolution)');

  // Validate CLI-provided format early before any command action runs
  program.hook('preAction', () => {
    const opts = program.opts();

    // Apply --worklog-dir override if provided
    if (opts.worklogDir) {
      setWorklogDirOverride(opts.worklogDir);
    } else {
      setWorklogDirOverride(undefined);
    }

    const cliFormat = opts.format;
    if (cliFormat && !isValidFormat(cliFormat)) {
      console.error(`Invalid --format value: ${cliFormat}`);
      console.error(`Valid formats: ${Array.from(ALLOWED_FORMATS).join(', ')}`);
      process.exit(1);
    }

    // Propagate the global --verbose flag into WL_VERBOSE so code paths that
    // detect verbosity via process.env or that run outside Commander can pick
    // it up. Use string '1' for truthy.
    try {
      const opts = program.opts();
      if (opts && opts.verbose) {
        process.env.WL_VERBOSE = '1';
      } else if (process.env.WL_VERBOSE) {
        // If user did not request verbose for this run, avoid leaking an
        // existing environment setting by leaving it untouched only when it was
        // explicitly set; prefer clearing to ensure --verbose controls runtime.
        delete process.env.WL_VERBOSE;
      }
    } catch (_e) {
      // Ignore errors — verbosity is best-effort
    }
  });

  // Create shared plugin context
  const ctx = createPluginContext(program);

  // Backfill: capture the JSON payload each command emits via output.json so
  // the next identical invocation can be served from cache. Wrapped once; the
  // wrapper is a no-op unless a cacheable read armed a backfill.
  {
    const origJson = ctx.output.json;
    ctx.output.json = (data: any) => {
      if (cacheEnabled) {
        try {
          cache.onJsonOutput(data);
        } catch {
          // The cache must never break the CLI.
        }
      }
      origJson(data);
    };
  }

  // Write commands (and non-cacheable reads, e.g. search --rebuild-index)
  // invalidate the cache for the worklog dir before their action mutates the
  // DB, so no stale result can be served after a write.
  program.hook('preAction', (thisCommand, actionCommand) => {
    if (!cacheEnabled) return;
    const command = actionCommand.name();
    // Cacheable reads never invalidate; pure reads (the consolidated
    // `worklist` bundle) must not either — they are not writes
    // (WL-0MVI0HX58009JJRF).
    if (
      shouldCacheReadInvocation(command, process.argv.slice(2)) ||
      isPureReadCommand(command)
    ) return;
    // `wl doctor cache` maintains the cache directory itself (F8/F9 —
    // WL-0MVFRRGGC001IQK1): bumping the state counter here would create a
    // counter for the current worklog dir just so it can be pruned again.
    if (command === 'cache' && actionCommand.parent?.name() === 'doctor') return;
    try {
      cache.invalidateOnWrite();
    } catch {
      // Best-effort.
    }
  });

  // If watch mode was requested we already handled spawning a watcher
  // earlier; commander should still expose the option on help, but the
  // watcher logic is implemented outside of the command registration so
  // normal command code doesn't need to change.

  // Built-in command names drive the help grouping only; the modules load
  // lazily through the registry (F6 — WL-0MVFRRMX3003UPP3), so a single-command
  // invocation imports only its own command.
  const builtInCommandNames = new Set(BUILT_IN_COMMAND_NAMES);

  // Register only the requested command when the invocation names one; help,
  // bare `wl` and unknown commands register the full set. A failing loader
  // warns once and falls back to eager registration (parent AC5).
  await registerBuiltInCommands(ctx, process.argv.slice(2));

  // Load external plugins (quietly - verbose will be handled per-command if needed)
  try {
    await loadPlugins(ctx, { verbose: false });
  } catch (error) {
    // Silently continue with built-in commands only
  }

  // Initialize the background task runtime so that background operations
  // (e.g. auto-sync, metrics collection) can be launched during the session
  // and are awaited on shutdown.  We pass silent:true because the default
  // beforeExit handler writes debug-level messages ("[runtime] Received
  // beforeExit…") to stderr, which pollutes JSON output consumed by scripts
  // and agents (see WL-0MRJ2R8LJ003LA8V).
  initializeRuntime({ silent: true });

  // Customize help output to group commands for readability and ensure global
  // options appear on subcommand help as well. Commander applies help
  // configuration per-Command instance, so apply the same formatter to the
  // program and each registered command recursively.

  const formatHelp = (cmd: any, helper: any) => {
    const usage = helper.commandUsage(cmd);
    const description = cmd.description() || '';

    // Determine if we should render help text through the markdown renderer.
    // Use the shared precedence resolver for CLI > config > auto-detect.
    const programOpts = program.opts();
    const config = loadConfig();
    const resolved = resolveMarkdownEnabled({
      format: programOpts.format,
      cliFormatMarkdown: config?.cliFormatMarkdown,
    });
    // resolved is: true → render, false → plain, undefined → auto-detect from TTY
    const shouldRenderHelp = resolved === true ? true : resolved === false ? false : process.stdout.isTTY === true;

    // Build groups and mapping of command name -> group
    const groupsDef: { name: string; names: string[] }[] = [
      { name: 'Issue Management', names: ['create', 'update', 'comment', 'close', 'delete', 'dep', 'reviewed', 'audit'] },
      { name: 'Status', names: ['in-progress', 'next', 'worklist', 'recent', 'list', 'show', 'search'] },
      { name: 'Team', names: ['sync', 'github', 'import', 'export'] },
      { name: 'Maintenance', names: ['migrate', 're-sort', 'doctor', 'unlock'] },
      { name: 'Plugins', names: [] },
    ];

    const visible = helper.visibleCommands(cmd) as any[];

    const groups: Map<string, any[]> = new Map();
    for (const g of groupsDef) groups.set(g.name, []);
    groups.set('Other', []);

    let helpCommand: any | null = null;
    for (const c of visible) {
      const name = c.name();
      if (name === 'help') {
        helpCommand = c;
        continue;
      }
      if (name === 'plugins' || !builtInCommandNames.has(name)) {
        groups.get('Plugins')!.push(c);
        continue;
      }

      const matched = groupsDef.find(g => g.names.includes(name));
      if (matched) {
        groups.get(matched.name)!.push(c);
      } else {
        groups.get('Other')!.push(c);
      }
    }

    if (helpCommand) {
      groups.get('Other')!.push(helpCommand);
    }

    // Compose help text
    let out = '';
    out += `Usage: ${usage}\n\n`;
    if (description) out += `${description}\n\n`;

    for (const [groupName, cmds] of groups) {
      if (!cmds || cmds.length === 0) continue;
      out += `${groupName}:\n`;
      const terms = cmds.map((c: any) => helper.subcommandTerm(c));
      const pad = Math.max(...terms.map((t: string) => t.length)) + 2;
      for (const c of cmds) {
        const term = helper.subcommandTerm(c);
        const desc = c.description();
        out += `  ${term.padEnd(pad)} ${desc}\n`;
      }
      out += '\n';
    }

    // Global + command-specific options
    const cmdOptions = helper.visibleOptions ? helper.visibleOptions(cmd) : [];
    const globalOptions = program.options || [];

    const seen = new Set<string>();
    const options: any[] = [];
    for (const o of [...globalOptions, ...cmdOptions]) {
      const key = o.flags || o.long || JSON.stringify(o);
      if (!seen.has(key)) {
        seen.add(key);
        options.push(o);
      }
    }

    if (options.length > 0) {
      out += 'Options:\n';
      const terms = options.map((o: any) => (helper.optionTerm ? helper.optionTerm(o) : o.flags));
      const padOptions = Math.max(...terms.map((t: string) => t.length)) + 2;
      for (let i = 0; i < options.length; i++) {
        const o = options[i];
        const term = terms[i];
        const desc = o.description || '';
        out += `  ${term.padEnd(padOptions)} ${desc}\n`;
      }
      out += '\n';
    }

    // Render help text through the markdown renderer when in a TTY or when
    // --format markdown is explicitly requested. This formats inline code,
    // headers, and lists in a readable way.
    if (shouldRenderHelp) {
      return renderCliMarkdown(out, { formatAsMarkdown: true });
    }

    return out;
  };

  function applyHelpFormatting(cmd: any) {
    cmd.configureHelp({ formatHelp });
    if (cmd.commands && cmd.commands.length > 0) {
      for (const sub of cmd.commands) applyHelpFormatting(sub);
    }
  }

  applyHelpFormatting(program);

  // Dispatch. A served cache hit / `--version` never reaches this point: the
  // thin fast path exits before importing this module.
  program.parse();
}

/** Entry point used by the thin fast path (`src/cli.ts`). */
export default main;
