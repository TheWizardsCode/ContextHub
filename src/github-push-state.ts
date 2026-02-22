/**
 * Local-only per-machine storage for the last successful `wl github push` timestamp.
 *
 * Stores state in `.worklog/.local/github-push-state.json` using atomic writes
 * (write to temp file then rename) to prevent corruption.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface GithubPushState {
  lastPushAt: string;
}

const LOCAL_DIR = '.local';
const STATE_FILENAME = 'github-push-state.json';

/**
 * Read the last-push timestamp from `.worklog/.local/github-push-state.json`.
 *
 * @param worklogDir - Absolute path to the `.worklog` directory.
 * @returns The ISO-8601 timestamp string, or `null` if the file does not exist
 *          or is malformed.
 */
export function readLastPushTimestamp(worklogDir: string): string | null {
  const filePath = path.join(worklogDir, LOCAL_DIR, STATE_FILENAME);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, { encoding: 'utf8' });
    const parsed = JSON.parse(raw);

    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof parsed.lastPushAt === 'string' &&
      parsed.lastPushAt.length > 0
    ) {
      // Validate it's a parseable date
      const ts = new Date(parsed.lastPushAt).getTime();
      if (Number.isNaN(ts)) {
        console.warn(
          `Warning: malformed timestamp in ${filePath}: lastPushAt is not a valid ISO-8601 date`
        );
        return null;
      }
      return parsed.lastPushAt;
    }

    console.warn(
      `Warning: malformed github-push-state.json in ${filePath}: missing or invalid "lastPushAt" field`
    );
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Race condition: file was removed between existsSync and readFileSync
      return null;
    }
    console.warn(
      `Warning: failed to read ${filePath}: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * Write the last-push timestamp to `.worklog/.local/github-push-state.json`.
 *
 * Uses atomic writes (write to a temp file then rename) to prevent corruption.
 * Creates the `.worklog/.local/` directory if it does not exist.
 *
 * @param worklogDir - Absolute path to the `.worklog` directory.
 * @param timestamp - ISO-8601 timestamp string to write.
 * @throws If the `.worklog/.local/` directory cannot be created or the write fails.
 */
export function writeLastPushTimestamp(worklogDir: string, timestamp: string): void {
  const localDir = path.join(worklogDir, LOCAL_DIR);

  // Ensure the .local directory exists; throw with descriptive error if it fails
  try {
    let exists = false;
    try {
      const stat = fs.statSync(localDir);
      if (!stat.isDirectory()) {
        throw new Error(`${localDir} exists but is not a directory`);
      }
      exists = true;
    } catch (statErr) {
      if ((statErr as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw statErr;
      }
    }
    if (!exists) {
      fs.mkdirSync(localDir, { recursive: true });
    }
  } catch (err) {
    throw new Error(
      `Failed to create directory ${localDir}: ${(err as Error).message}`
    );
  }

  const filePath = path.join(localDir, STATE_FILENAME);
  const state: GithubPushState = { lastPushAt: timestamp };
  const content = JSON.stringify(state, null, 2) + '\n';

  // Atomic write: write to a temp file in the same directory, then rename
  const tmpFile = path.join(localDir, `.${STATE_FILENAME}.${crypto.randomBytes(6).toString('hex')}.tmp`);

  try {
    fs.writeFileSync(tmpFile, content, { encoding: 'utf8' });
    fs.renameSync(tmpFile, filePath);
  } catch (err) {
    // Clean up temp file if rename failed
    try {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    } catch {
      // Ignore cleanup errors
    }
    throw new Error(
      `Failed to write ${filePath}: ${(err as Error).message}`
    );
  }
}
