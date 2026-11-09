/**
 * init paths — repository/project root and template location for `wl init`.
 *
 * Single responsibility: resolve the repository root, project root and git
 * sync defaults, and locate the packaged or repository-local template files
 * that `wl init` provisions. Declares no provisioning logic — the
 * `init.<concern>.ts` modules act on the paths this module returns.
 *
 * Dependency direction: external packages, `init.constants.ts`, `../config.js`
 * and `../sync-defaults.js` only. This module never imports `init.ts` or any
 * other `init.<concern>.ts` module (WL-0MW0KDRAS000V2RL AC3).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { loadConfig } from '../config.js';
import { DEFAULT_GIT_REMOTE, DEFAULT_GIT_BRANCH } from '../sync-defaults.js';
import {
  SCHEDULED_PROMPTS_TEMPLATE_RELATIVE_PATH,
  WORKFLOW_TEMPLATE_RELATIVE_PATH,
  WORKLOG_AGENT_TEMPLATE_RELATIVE_PATH,
  WORKLOG_GITIGNORE_TEMPLATE_RELATIVE_PATH,
} from './init.constants.js';

export function getSyncDefaults(config?: ReturnType<typeof loadConfig>) {
  return {
    gitRemote: config?.syncRemote || DEFAULT_GIT_REMOTE,
    gitBranch: config?.syncBranch || DEFAULT_GIT_BRANCH,
  };
}

export function resolveRepoRoot(): string | null {
  try {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return repoRoot || null;
  } catch {
    return null;
  }
}

export function resolveProjectRoot(): string {
  return resolveRepoRoot() || process.cwd();
}

export function locateAgentTemplate(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(moduleDir, '..', '..');
  const candidate = path.join(packageRoot, WORKLOG_AGENT_TEMPLATE_RELATIVE_PATH);
  if (fs.existsSync(candidate)) return candidate;
  const projectRoot = resolveProjectRoot();
  const repoCandidate = path.join(projectRoot, WORKLOG_AGENT_TEMPLATE_RELATIVE_PATH);
  return fs.existsSync(repoCandidate) ? repoCandidate : null;
}

export function locateExampleStatsPlugin(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(moduleDir, '..', '..');
  const candidate = path.join(packageRoot, 'examples', 'stats-plugin.mjs');
  return fs.existsSync(candidate) ? candidate : null;
}

export function locateWorkflowTemplate(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(moduleDir, '..', '..');
  const candidate = path.join(packageRoot, WORKFLOW_TEMPLATE_RELATIVE_PATH);
  if (fs.existsSync(candidate)) return candidate;
  const projectRoot = resolveProjectRoot();
  const repoCandidate = path.join(projectRoot, WORKFLOW_TEMPLATE_RELATIVE_PATH);
  return fs.existsSync(repoCandidate) ? repoCandidate : null;
}

export function locateGitignoreTemplate(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(moduleDir, '..', '..');
  const candidate = path.join(packageRoot, WORKLOG_GITIGNORE_TEMPLATE_RELATIVE_PATH);
  return fs.existsSync(candidate) ? candidate : null;
}

export function locateScheduledPromptsTemplate(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(moduleDir, '..', '..');
  const candidate = path.join(packageRoot, SCHEDULED_PROMPTS_TEMPLATE_RELATIVE_PATH);
  return fs.existsSync(candidate) ? candidate : null;
}
