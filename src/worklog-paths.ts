/**
 * Shared path resolution helpers for Worklog
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

function getRepoRoot(): string | null {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return root || null;
  } catch {
    return null;
  }
}

/**
 * Check if the current working directory is a git worktree.
 * A worktree has a .git file (not a directory) that points to the main repo's git directory.
 */
function isGitWorktree(): boolean {
  try {
    const gitPath = path.join(process.cwd(), '.git');
    const stat = fs.statSync(gitPath);
    return stat.isFile();  // .git is a file in a worktree, directory in main repo
  } catch {
    return false;
  }
}

function hasWorklogConfig(worklogDir: string): boolean {
  const configPath = path.join(worklogDir, 'config.yaml');
  const initPath = path.join(worklogDir, 'initialized');
  return fs.existsSync(configPath) || fs.existsSync(initPath);
}

export function resolveWorklogDir(): string {
  const cwd = process.cwd();
  const cwdWorklog = path.join(cwd, '.worklog');
  const repoRoot = getRepoRoot();
  const repoWorklog = repoRoot ? path.join(repoRoot, '.worklog') : null;
  
  // Check if .worklog exists in current directory
  if (fs.existsSync(cwdWorklog)) {
    if (repoWorklog && repoWorklog !== cwdWorklog && fs.existsSync(repoWorklog)) {
      if (!hasWorklogConfig(cwdWorklog) && hasWorklogConfig(repoWorklog)) {
        return repoWorklog;
      }
    }
    return cwdWorklog;
  }

  // If we're in a git worktree, don't look for .worklog in the main repo
  // Each worktree should have its own independent .worklog directory
  if (isGitWorktree()) {
    return cwdWorklog;
  }

  // Not in a worktree, so try to find .worklog in the repo root
  if (repoWorklog && repoRoot && repoRoot !== cwd) {
    if (fs.existsSync(repoWorklog)) {
      return repoWorklog;
    }
  }

  return cwdWorklog;
}
