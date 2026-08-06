#!/usr/bin/env node
/**
 * Command-line interface for the Worklog system - Plugin-based architecture
 */

import { Command } from 'commander';
import { createPluginContext, getVersion } from './cli-utils.js';
import { loadPlugins } from './plugin-loader.js';
import { renderCliMarkdown, resolveMarkdownEnabled } from './cli-output.js';
import { loadConfig } from './config.js';
import { initializeRuntime } from './lib/runtime.js';

// Import built-in command modules
import initCommand from './commands/init.js';
import statusCommand from './commands/status.js';
import createCommand from './commands/create.js';
import listCommand from './commands/list.js';
import showCommand from './commands/show.js';
import updateCommand from './commands/update.js';
import deleteCommand from './commands/delete.js';
import exportCommand from './commands/export.js';
import importCommand from './commands/import.js';
import nextCommand from './commands/next.js';
import inProgressCommand from './commands/in-progress.js';
import syncCommand from './commands/sync.js';
import githubCommand from './commands/github.js';
import commentCommand from './commands/comment.js';
import closeCommand from './commands/close.js';
import recentCommand from './commands/recent.js';
import pluginsCommand from './commands/plugins.js';
import migrateCommand from './commands/migrate.js';
import depCommand from './commands/dep.js';
import reSortCommand from './commands/re-sort.js';
import doctorCommand from './commands/doctor.js';
import reviewedCommand from './commands/reviewed.js';
import searchCommand from './commands/search.js';
import unlockCommand from './commands/unlock.js';
import auditCommand from './commands/audit.js';
import auditResultCommand from './commands/audit-result.js';
import completionCommand from './commands/completion.js';
import cleanupWorktreeCommand from './commands/cleanup-worktree.js';
import { detectWorktreeFromCwd, registerCurrentProcess } from './process-lifecycle.js';
import { applyWorklogDirOverrideFromArgv, setWorklogDirOverride } from './worklog-paths.js';
import { ReadCacheCli, shouldCacheReadInvocation, extractCommandFromArgv } from './read-cache-cli.js';
import { recordSpawn } from './spawn-counter.js';

// Watch flag parsing - supports -w, -wN, --watch, --watch=N
function parseWatchFlag(argv: string[]) {
  const out = argv.slice();
  let enabled = false;
  let seconds = 5;

  for (let i = 2; i < out.length; i++) {
    const v = out[i];
    if (v === '-w' || v === '--watch') {
      enabled = true;
      if (i + 1 < out.length && !out[i + 1].startsWith('-')) {
        const parsed = parseInt(out[i + 1], 10);
        if (!Number.isNaN(parsed) && parsed > 0) seconds = parsed;
        out.splice(i, 2);
      } else {
        out.splice(i, 1);
      }
      break;
    }
    if (v.startsWith('--watch=')) {
      enabled = true;
      const parsed = parseInt(v.split('=', 2)[1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) seconds = parsed;
      out.splice(i, 1);
      break;
    }
    if (v.startsWith('-w') && v.length > 2) {
      const parsed = parseInt(v.slice(2), 10);
      enabled = true;
      if (!Number.isNaN(parsed) && parsed > 0) seconds = parsed;
      out.splice(i, 1);
      break;
    }
  }

  return { enabled, seconds, argvWithoutWatch: out };
}

const _parsedWatch = parseWatchFlag(process.argv);
if (_parsedWatch.enabled) {
  const freq = _parsedWatch.seconds;
  // Use the cleaned argv (includes node and script) and spawn the same
  // command (node <script> <args...>) but with the watch flag removed.
  const spawnArgs = _parsedWatch.argvWithoutWatch.slice(1);
  const bannerCommand = _parsedWatch.argvWithoutWatch.slice(2).join(' ') || '(no command)';

  const formatWatchTimestamp = (date: Date) => {
    const parts = date.toString().split(' ');
    if (parts.length >= 5) {
      return `${parts[0]} ${parts[1]} ${parts[2]} ${parts[4]} ${parts[3]}`;
    }
    return date.toString();
  };


  let shuttingDown = false;
  let childProcess: any = null;
  const shutdownHandler = () => {
    shuttingDown = true;
    try { process.stdout.write('\x1b[?25h'); } catch (_) {}
    if (!childProcess) {
      process.exit(0);
    }
    if (childProcess && !childProcess.killed) {
      try { childProcess.kill('SIGINT'); } catch (_) {}
      const forceExit = setTimeout(() => process.exit(0), 500);
      try { childProcess.once('exit', () => { clearTimeout(forceExit); process.exit(0); }); } catch (_) {}
    }
  };
  process.on('SIGINT', shutdownHandler);
  process.on('SIGTERM', shutdownHandler);

  // top-level await is allowed in this module — run an async loop and await it
  await (async () => {
    let first = true;
    while (!shuttingDown) {
      if (!first) {
        try { process.stdout.write('\x1b[?25l\x1b[H\x1b[2J'); } catch (_) {}
      }
      first = false;

      const timestamp = formatWatchTimestamp(new Date());
      const leftText = `Every ${freq.toFixed(1)}s: ${bannerCommand}`;
      let banner = `${leftText}  ${timestamp}`;
      const cols = process.stdout.columns || 0;
      if (cols > 0) {
        const minGap = 2;
        const maxLeft = Math.max(0, cols - timestamp.length - minGap);
        const trimmedLeft = leftText.length > maxLeft ? leftText.slice(0, maxLeft) : leftText;
        const gap = Math.max(minGap, cols - timestamp.length - trimmedLeft.length);
        banner = `${trimmedLeft}${' '.repeat(gap)}${timestamp}`;
      }
      try { process.stdout.write(`\x1b[90m${banner}\x1b[0m\n`); } catch (_) {}

      // Spawn using the node executable so the script runs with the same
      // runtime regardless of how it was invoked (shebang, tsx, npm script).
      const spawnArgs = _parsedWatch.argvWithoutWatch.slice(1);

      try {
        const cp = await import('child_process');
        // Preserve any execArgv used to launch this process (e.g. --loader or -r flags
        // from tsx). Prepend them so the child runs with the same Node flags.
        const nodeArgs = [...process.execArgv, ...spawnArgs];
        // `cp` is the namespace object for the child_process module; use its spawn function
        childProcess = cp.spawn(process.execPath, nodeArgs, { stdio: 'inherit' });
      } catch (err: any) {
        childProcess = null;
      }

      await new Promise<void>(resolve => {
        if (!childProcess) return resolve();
        childProcess.on('exit', () => {
          childProcess = null;
          resolve();
        });
        childProcess.on('error', () => {
          childProcess = null;
          resolve();
        });
      });

      if (shuttingDown) break;

      await new Promise(r => setTimeout(r, freq * 1000));
      try { process.stdout.write('\x1b[?25h'); } catch (_) {}
    }
  })();
  // After loop exits, just return so the watcher process ends
  process.exit(0);
}

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
  // it up (e.g. background submitToOpenBrain). Use string '1' for truthy.
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

// Apply the --worklog-dir override from argv BEFORE creating the plugin
// context, so ctx.dataPath (and every -f/--file default derived from it)
// reflects the override. The preAction hook below re-applies/clears the
// override from commander's parsed options, but by then ctx.dataPath has
// already been computed — resolving it from the process cwd instead would
// let `wl sync --worklog-dir <proj>/.worklog` fetch the cwd repo's remote
// ref while writing to <proj>'s database (WL-0MSAH26DD001XXST).
applyWorklogDirOverrideFromArgv(process.argv.slice(2));

// Create shared plugin context
const ctx = createPluginContext(program);

// ── Read-cache wiring (F2 — WL-0MSGAEC5N006W5QA) ─────────────────────────
// Serve repeat JSON read queries (list/next/show/search/status) from the
// shared on-disk cache so herdr panes / pi-agent polling don't re-query the
// SQLite DB for byte-identical invocations. Env-gated config:
//   WL_CACHE_DISABLED=1     — bypass the cache entirely (baseline behaviour)
//   WL_CACHE_TTL_MS=<n>     — override the TTL safety net (tests/ops)
//   WL_CACHE_DIR=<path>     — override the cache dir (see read-cache.ts)
//   WL_SPAWN_COUNT_FILE     — spawn instrumentation (see spawn-counter.ts)
const readCacheEnabled = process.env.WL_CACHE_DISABLED !== '1';
const _cacheTtl = parseInt(process.env.WL_CACHE_TTL_MS ?? '', 10);
const readCacheCli = new ReadCacheCli({
  ttlMs: Number.isFinite(_cacheTtl) && _cacheTtl > 0 ? _cacheTtl : undefined,
});

// Backfill: capture the JSON payload each command emits via output.json so
// the next identical invocation can be served from cache. Wrapped once; the
// wrapper is a no-op unless a cacheable read armed a backfill.
{
  const origJson = ctx.output.json;
  ctx.output.json = (data: any) => {
    if (readCacheEnabled) {
      try {
        readCacheCli.onJsonOutput(data);
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
  if (!readCacheEnabled) return;
  const command = actionCommand.name();
  if (shouldCacheReadInvocation(command, process.argv.slice(2))) return;
  try {
    readCacheCli.invalidateOnWrite();
  } catch {
    // Best-effort.
  }
});

// If watch mode was requested we already handled spawning a watcher
// earlier; commander should still expose the option on help, but the
// watcher logic is implemented outside of the command registration so
// normal command code doesn't need to change.

// Register built-in commands
const builtInCommands = [
  initCommand,
  statusCommand,
  createCommand,
  listCommand,
  showCommand,
  updateCommand,
  deleteCommand,
  exportCommand,
  importCommand,
  nextCommand,
  inProgressCommand,
  syncCommand,
  githubCommand,
  commentCommand,
  closeCommand,
  recentCommand,
  pluginsCommand,
  migrateCommand,
  depCommand,
  reSortCommand,
  doctorCommand,
  reviewedCommand,
  searchCommand,
  unlockCommand,
  auditCommand,
  auditResultCommand,
  cleanupWorktreeCommand,
  completionCommand,
  // onboard command removed
];

const builtInCommandNames = new Set([
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
  'search',
  'unlock',
  'audit',
  'audit-show',
  'audit-set',
  'completion',
  'cleanup-worktree',
  // 'onboard' removed
]);

// Register each built-in command
for (const registerFn of builtInCommands) {
  try {
    registerFn(ctx);
  } catch (error) {
    console.error(`Failed to register built-in command: ${error}`);
    process.exit(1);
  }
}

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
    { name: 'Status', names: ['in-progress', 'next', 'recent', 'list', 'show', 'search'] },
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

// If the CLI is running inside a ContextHub-managed worktree, register our
// PID with the process lifecycle module so it can be cleaned up when the
// worktree is removed.
const worktreePath = detectWorktreeFromCwd();
if (worktreePath) {
  registerCurrentProcess(worktreePath);
}

// Read-cache serve: for a cacheable read invocation, try the cache BEFORE
// commander dispatches. On a hit, print the cached payload (byte-identical
// to output.json formatting) and exit without ever calling `program.parse()`
// — so no action runs and no DB is opened. The write+callback exit guarantees
// piped stdout is flushed before the process terminates. When the cache is
// disabled (baseline), cacheable reads still record a work spawn so the
// spawn-reduction metric has a denominator.
let cacheServed = false;
const cacheArgv = process.argv.slice(2);
const cacheCommand = extractCommandFromArgv(cacheArgv);
if (cacheCommand !== null && shouldCacheReadInvocation(cacheCommand, cacheArgv)) {
  if (readCacheEnabled) {
    const { served, value } = readCacheCli.lookup(cacheCommand, cacheArgv);
    if (served) {
      cacheServed = true;
      const text = `${JSON.stringify(value, null, 2)}\n`;
      process.stdout.write(text, () => process.exit(0));
      // Safety net if the flush callback never fires.
      setTimeout(() => process.exit(0), 2000).unref();
    }
  } else {
    recordSpawn('read-work'); // baseline: every read does DB work
  }
}

// Parse command line arguments (skipped entirely when served from cache).
if (!cacheServed) {
  program.parse();
}
