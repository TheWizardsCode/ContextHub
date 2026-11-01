/**
 * packages/herdr/src/herdr-bin.ts — Resolve the herdr CLI binary path.
 *
 * WHY (WL-0MVXRZL9H001GQ7A): herdr derives HERDR_BIN_PATH from its own
 * `/proc/self/exe` and injects it into every pane environment and plugin
 * action. After an in-place upgrade (`herdr update`) the running server still
 * holds the OLD binary inode, so the injected value is the stale path with a
 * ` (deleted)` suffix — e.g. `/home/me/.local/bin/herdr (deleted)`. Spawning
 * that literal string can never work, so every plugin action and every herdr
 * call made from the worklist pane failed while the server was stale.
 *
 * The resolver is the single source of truth for the herdr CLI path:
 *   1. no `HERDR_BIN_PATH`           → `herdr` (let the OS resolve PATH)
 *   2. strip a stale ` (deleted)` suffix
 *   3. use the configured path when it is an existing executable file
 *   4. otherwise fall back to `herdr` found on `PATH`
 *   5. otherwise return the (stripped) configured path so the caller's
 *      "not found" diagnostics name what was actually attempted
 *
 * It never throws — callers keep their existing error handling for the
 * genuinely-missing case. The shell counterpart is `../shared/herdr-bin.sh`.
 */

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Linux appends this to `/proc/self/exe` once the inode was replaced. */
const DELETED_SUFFIX = ' (deleted)';

/** Name used when nothing else resolves; also resolved through `PATH`. */
export const DEFAULT_HERDR_BIN = 'herdr';

/**
 * Remove a trailing ` (deleted)` marker added by the OS for a replaced
 * inode. Any other text (including a legitimate space) is preserved.
 */
export function stripDeletedSuffix(value: string): string {
  return value.endsWith(DELETED_SUFFIX)
    ? value.slice(0, -DELETED_SUFFIX.length)
    : value;
}

/** True when `candidate` names an existing, executable regular file. */
function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First executable `herdr` (or `herdr.exe` on Windows) on `PATH`. */
function herdrOnPath(pathValue: string | undefined): string | undefined {
  if (!pathValue) return undefined;
  const names =
    process.platform === 'win32'
      ? [`${DEFAULT_HERDR_BIN}.exe`, DEFAULT_HERDR_BIN]
      : [DEFAULT_HERDR_BIN];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Resolve the herdr CLI path for a call site.
 *
 * @param env Environment to read (defaults to `process.env`; injectable so
 *   tests and the pane-close CLI's sandboxed `io.env` do not need to mutate
 *   the real process environment).
 */
export function resolveHerdrBin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.HERDR_BIN_PATH?.trim();
  if (!configured) return DEFAULT_HERDR_BIN;

  const candidate = stripDeletedSuffix(configured);
  if (isExecutableFile(candidate)) return candidate;

  return herdrOnPath(env.PATH) ?? candidate;
}
