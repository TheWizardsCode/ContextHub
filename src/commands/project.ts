/**
 * Project commands — inspect the local projects discovered for cross-repo
 * dependencies (F2 — WL-0MVWEELAW005SDLU).
 *
 * `wl project list` is a thin surface over `discoverProjects()` in
 * `src/cross-repo/project-registry.ts`; the scan itself lives there so every
 * consumer (this command, the foreign-dependency resolver, the TUI and the
 * framework skills) shares one implementation (parent D6).
 */

import chalk from 'chalk';
import type { PluginContext } from '../plugin-types.js';
import { normalizeActionArgs } from './cli-utils.js';
import { discoverProjects } from '../cross-repo/project-registry.js';

/** Options accepted by `wl project list`. */
interface ProjectListOptions {
  projectsRoot?: string;
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
}
