/**
 * Project commands — inspect the local projects discovered for cross-repo
 * dependencies and clone a missing one (F2 — WL-0MVWEELAW005SDLU; F8 —
 * WL-0MVWEES9J0035SG6).
 *
 * `wl project list` is a thin surface over `discoverProjects()` in
 * `src/cross-repo/project-registry.ts`; the scan itself lives there so every
 * consumer (this command, the foreign-dependency resolver, the TUI and the
 * framework skills) shares one implementation (parent D6).
 *
 * `wl project add` is the remediation side of D4: it clones a missing project
 * into the projects root and records the `prefix → path/gitUrl` mapping in the
 * consumer's `.worklog/config.yaml`. It never reads stdin unless the operator
 * asks for it with `--interactive` (agents cannot answer prompts) and a failed
 * validation or clone leaves no mapping behind.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import type { PluginContext } from '../plugin-types.js';
import { normalizeActionArgs } from './cli-utils.js';
import {
  discoverProjects,
  getProjectsRoot,
  readDeclaredPrefix,
} from '../cross-repo/project-registry.js';
import { recordProjectMapping } from '../config.js';

/** Options accepted by `wl project list`. */
interface ProjectListOptions {
  projectsRoot?: string;
}

/** Options accepted by `wl project add`. */
interface ProjectAddOptions {
  gitUrl?: string;
  path?: string;
  interactive?: boolean;
  projectsRoot?: string;
}

/** Prefixes are ASCII letters and digits, like `wl init` enforces. */
const PREFIX_PATTERN = /^[A-Z0-9]+$/;

/** Ask the operator for the git URL (only with an explicit `--interactive`). */
function promptForGitUrl(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question('Git URL to clone: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Keep a failed `git clone` message readable (last lines of git's output). */
function gitErrorDetail(stderr: string | null, stdout: string | null): string {
  const detail = `${stderr ?? ''}${stdout ?? ''}`.trim();
  if (detail === '') return 'git clone exited non-zero';
  return detail.length > 800 ? `…${detail.slice(-800)}` : detail;
}

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  const projectCommand = program
    .command('project')
    .description('Manage discovered projects used for cross-repo dependencies');

  projectCommand
    .command('list')
    .description('List discovered projects (prefix → path)')
    .option('--projects-root <path>', 'Override the projects root to scan')
    .action((...rawArgs: unknown[]) => {
      const normalized = normalizeActionArgs(rawArgs, ['projectsRoot']);
      const options = normalized.options as ProjectListOptions;

      const result = discoverProjects({ projectsRoot: options.projectsRoot });

      for (const warning of result.warnings) {
        console.warn(chalk.yellow(`Warning: ${warning}`));
      }

      if (utils.isJsonMode()) {
        output.json({
          success: true,
          projectsRoot: result.projectsRoot,
          projects: result.projects.map((project) => ({
            prefix: project.prefix,
            path: project.path,
            ambiguous: project.ambiguous,
          })),
          warnings: result.warnings,
        });
        return;
      }

      console.log(`Projects root: ${result.projectsRoot}`);
      if (result.projects.length === 0) {
        console.log('No projects discovered.');
        return;
      }
      console.log('');
      for (const project of result.projects) {
        const target =
          project.ambiguous || project.path === null
            ? chalk.yellow(`(ambiguous) ${(project.candidates ?? []).join(', ')}`)
            : project.path;
        console.log(`${chalk.cyan(project.prefix)} → ${target}`);
      }
    });

  projectCommand
    .command('add <prefix>')
    .description(
      'Clone a project into the projects root and record its prefix mapping (remediation for an unknown_project error)',
    )
    .option('--git-url <url>', 'Git URL to clone (omit only with --interactive)')
    .option('--path <dir>', 'Clone target directory (default: <projectsRoot>/<prefix>)')
    .option('--interactive', 'Prompt for the git URL when --git-url is omitted')
    .option('--projects-root <path>', 'Override the projects root to clone into')
    .action(async (rawPrefix: string, ...rawArgs: unknown[]) => {
      const normalized = normalizeActionArgs(rawArgs, [
        'gitUrl',
        'path',
        'interactive',
        'projectsRoot',
      ]);
      const options = normalized.options as ProjectAddOptions;
      utils.requireInitialized();

      /** Emit a non-zero machine-readable failure (JSON to stderr, like the CLI convention). */
      const fail = (errorCode: string, message: string, extra: Record<string, unknown> = {}): void => {
        if (utils.isJsonMode()) {
          output.error(message, { success: false, error: message, error_code: errorCode, ...extra });
        } else {
          console.error(chalk.red(`Error: ${message}`));
        }
        process.exitCode = 1;
      };

      const prefix = String(rawPrefix ?? '').trim().toUpperCase();
      if (!PREFIX_PATTERN.test(prefix)) {
        fail(
          'invalid_prefix',
          `Invalid project prefix '${rawPrefix}': prefixes contain only ASCII letters and digits.`,
        );
        return;
      }

      const rootResolution = getProjectsRoot({ projectsRoot: options.projectsRoot });
      const projectsRoot = rootResolution.root;
      if (!utils.isJsonMode()) {
        for (const warning of rootResolution.warnings) {
          console.warn(chalk.yellow(`Warning: ${warning}`));
        }
      }

      let gitUrl = options.gitUrl?.trim();
      if (!gitUrl) {
        if (options.interactive) {
          gitUrl = await promptForGitUrl();
        }
        if (!gitUrl) {
          fail(
            'missing_git_url',
            `Missing --git-url: pass the repository URL to clone, e.g. \`wl project add ${prefix} --git-url <url>\`. ` +
              'No stdin prompt is issued without --interactive.',
            { prefix },
          );
          return;
        }
      }

      const targetPath = options.path
        ? path.resolve(process.cwd(), options.path)
        : path.join(projectsRoot, prefix.toLowerCase());

      let cloned = false;
      if (fs.existsSync(targetPath)) {
        const declaredPrefix = readDeclaredPrefix(targetPath);
        if (declaredPrefix === undefined) {
          fail(
            'invalid_project',
            `${targetPath} already exists but is not a worklog project ` +
              '(its .worklog/config.yaml is missing or declares no prefix).',
            { prefix, path: targetPath },
          );
          return;
        }
        if (declaredPrefix !== prefix) {
          fail(
            'prefix_mismatch',
            `Prefix mismatch: ${targetPath} declares ${declaredPrefix} but ${prefix} was requested. ` +
              'No mapping was recorded.',
            { prefix, declared_prefix: declaredPrefix, path: targetPath },
          );
          return;
        }
      } else {
        // Clone into the projects root (create it when absent, so a first-ever
        // remediation on a fresh machine works without manual setup).
        try {
          fs.mkdirSync(projectsRoot, { recursive: true });
        } catch (error) {
          fail(
            'clone_failed',
            `Could not create the projects root ${projectsRoot}: ` +
              (error instanceof Error ? error.message : String(error)),
            { prefix, projects_root: projectsRoot },
          );
          return;
        }

        // The operator's existing git configuration supplies credentials; the
        // tool never prompts for them.
        const clone = spawnSync('git', ['clone', '--', gitUrl, targetPath], {
          encoding: 'utf-8',
          env: process.env,
        });
        if (clone.error || clone.status !== 0) {
          // A partial clone must not stay behind in the projects root (D4).
          fs.rmSync(targetPath, { recursive: true, force: true });
          fail(
            'clone_failed',
            `git clone ${gitUrl} failed: ${gitErrorDetail(clone.stderr, clone.stdout)}`,
            { prefix, gitUrl },
          );
          return;
        }
        cloned = true;

        const clonedPrefix = readDeclaredPrefix(targetPath);
        if (clonedPrefix !== prefix) {
          // A clone declaring another prefix would pollute discovery under the
          // wrong name; drop it and record nothing (D4).
          fs.rmSync(targetPath, { recursive: true, force: true });
          fail(
            'prefix_mismatch',
            `Prefix mismatch: the cloned repository declares ${clonedPrefix ?? '(none)'} ` +
              `but ${prefix} was requested. The clone was removed and no mapping was recorded.`,
            { prefix, declared_prefix: clonedPrefix ?? null, gitUrl },
          );
          return;
        }
      }

      try {
        recordProjectMapping(prefix, { path: targetPath, gitUrl });
      } catch (error) {
        fail(
          'config_error',
          `Cloned ${prefix} but could not record its mapping in .worklog/config.yaml: ` +
            (error instanceof Error ? error.message : String(error)),
          { prefix, path: targetPath, gitUrl },
        );
        return;
      }

      if (utils.isJsonMode()) {
        output.json({ success: true, prefix, path: targetPath, gitUrl, cloned });
        return;
      }

      if (cloned) {
        console.log(chalk.green(`Cloned ${prefix} from ${gitUrl}`));
      } else {
        console.log(chalk.green(`${prefix} is already present — nothing to clone.`));
      }
      console.log(`Path:    ${targetPath}`);
      console.log(`Mapping: ${prefix} → ${targetPath} recorded in .worklog/config.yaml`);
    });
}
