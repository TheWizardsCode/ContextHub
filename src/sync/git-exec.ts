/**
 * src/sync/git-exec.ts — git subprocess plumbing for the sync module.
 *
 * Concern: how sync invokes git — the sanitised child environment (GIT_DIR /
 * GIT_WORK_TREE / GIT_INDEX_FILE cleared so `wl sync` spawned from a hook
 * cannot redirect commands to the caller's worktree), the tracked exec
 * wrappers and the unbounded stdout capture for large JSONL blobs.
 *
 * Moved verbatim from `src/sync.ts` (WL-0MVP9PCOU004L8HN, child 2 of 6 of the
 * WL-0MVGKGMU400631VZ `src/sync.ts` decomposition). These helpers were
 * module-local in the barrel; they are exported from here for internal use
 * only and are NOT added to the `src/sync.ts` public surface.
 */

import * as childProcess from 'child_process';
import { contextExec, type TrackedExecResult } from '../process-lifecycle.js';

/**
 * Git exports GIT_DIR (and GIT_WORK_TREE / GIT_INDEX_FILE) when it invokes
 * hooks, and `wl sync` spawned from a hook inherits them. A leaked GIT_DIR
 * redirects `git -C <path> ...` commands to the CALLER's worktree (its
 * index/HEAD/refs) instead of the repository named on the command line —
 * which produced destructive "Sync work items and comments" commits on
 * worktree branches (WL-0MS99Y6R40028Q9G). Every git command in this module
 * therefore runs with those variables cleared, matching git's own behavior
 * of unsetting them for hook child processes.
 */
export function sanitizeGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  delete clean.GIT_DIR;
  delete clean.GIT_WORK_TREE;
  delete clean.GIT_INDEX_FILE;
  return clean;
}

export async function gitExecAsync(
  command: string,
  options?: { cwd?: string }
): Promise<TrackedExecResult> {
  return contextExec(command, { ...options, env: sanitizeGitEnv(process.env) });
}

export const execAsync = gitExecAsync;

// git show of large JSONL can exceed Node's exec() maxBuffer.
// Use spawn to stream the output when reading remote content.
export async function execGitCaptureStdout(args: string[], options?: { cwd?: string }): Promise<string> {
  return await new Promise((resolve, reject) => {
    // On Windows, shell: true is required so spawn can resolve .cmd/.bat
    // wrappers. Pass args as a single command string to avoid the
    // DEP0190 deprecation warning about unescaped args with shell=true.
    const useShell = process.platform === 'win32';
    const childEnv = sanitizeGitEnv(process.env);
    const child = useShell
      ? childProcess.spawn(`git ${args.map(a => escapeShellArg(a)).join(' ')}`, [], {
          cwd: options?.cwd,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
        })
      : childProcess.spawn('git', args, {
          cwd: options?.cwd,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(out);
      reject(new Error(err.trim() || `git ${args.join(' ')} failed with code ${code}`));
    });
  });
}

/**
 * Escape a string for safe use in shell commands
 */
export function escapeShellArg(arg: string): string {
  if (process.platform === 'win32') {
    // Windows cmd.exe uses double quotes; escape internal double quotes
    return '"' + arg.replace(/"/g, '\\"') + '"';
  }
  // Unix: use single quotes and escape any single quotes within the string
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
