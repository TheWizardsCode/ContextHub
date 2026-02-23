#!/usr/bin/env node
/**
 * Command-line interface for the Worklog system - Plugin-based architecture
 */

import { Command } from 'commander';
import { createPluginContext, getVersion } from './cli-utils.js';
import { loadPlugins } from './plugin-loader.js';

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
import tuiCommand from './commands/tui.js';
import migrateCommand from './commands/migrate.js';
import depCommand from './commands/dep.js';
import reSortCommand from './commands/re-sort.js';
import doctorCommand from './commands/doctor.js';
import reviewedCommand from './commands/reviewed.js';
import searchCommand from './commands/search.js';

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
const ALLOWED_FORMATS = new Set(['concise', 'normal', 'full', 'raw']);

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
  .option('-F, --format <format>', 'Human display format (choices: concise|normal|full|raw)')
  .option('-w, --watch [seconds]', 'Rerun the command every N seconds (default: 5)');

// Validate CLI-provided format early before any command action runs
program.hook('preAction', () => {
  const cliFormat = program.opts().format;
  if (cliFormat && !isValidFormat(cliFormat)) {
    console.error(`Invalid --format value: ${cliFormat}`);
    console.error(`Valid formats: ${Array.from(ALLOWED_FORMATS).join(', ')}`);
    process.exit(1);
  }
});

// Create shared plugin context
const ctx = createPluginContext(program);

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
  tuiCommand,
  migrateCommand,
  depCommand,
  reSortCommand,
  doctorCommand,
  reviewedCommand,
  searchCommand,
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
  'tui',
  'migrate',
  'dep',
  're-sort',
  'doctor',
  'reviewed',
  'search',
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

// Customize help output to group commands for readability and ensure global
// options appear on subcommand help as well. Commander applies help
// configuration per-Command instance, so apply the same formatter to the
// program and each registered command recursively.

const formatHelp = (cmd: any, helper: any) => {
  const usage = helper.commandUsage(cmd);
  const description = cmd.description() || '';

  // Build groups and mapping of command name -> group
  const groupsDef: { name: string; names: string[] }[] = [
    { name: 'Issue Management', names: ['create', 'update', 'comment', 'close', 'delete', 'dep', 'reviewed'] },
    { name: 'Status', names: ['in-progress', 'next', 'recent', 'list', 'show', 'search'] },
    { name: 'Team', names: ['sync', 'github', 'import', 'export'] },
    { name: 'Maintenance', names: ['migrate', 're-sort', 'doctor'] },
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

  return out;
};

function applyHelpFormatting(cmd: any) {
  cmd.configureHelp({ formatHelp });
  if (cmd.commands && cmd.commands.length > 0) {
    for (const sub of cmd.commands) applyHelpFormatting(sub);
  }
}

applyHelpFormatting(program);

// Parse command line arguments
program.parse();
