/**
 * Unlock command – inspect and remove a stale worklog lock file.
 *
 * Usage:
 *   wl unlock              Display lock status (interactive prompt to remove)
 *   wl unlock --force      Remove the lock without prompting
 *   wl --json unlock       JSON output
 */

import * as fs from 'fs';
import type { PluginContext } from '../plugin-types.js';
import type { UnlockOptions } from '../cli-types.js';
import {
  getLockPathForJsonl,
  readLockInfo,
  isProcessAlive,
  formatLockAge,
} from '../file-lock.js';

export default function register(ctx: PluginContext): void {
  const { program, dataPath, output, utils } = ctx;

  program
    .command('unlock')
    .description('Inspect or remove a stale worklog lock file')
    .option('--force', 'Remove the lock file without prompting')
    .action((options: UnlockOptions) => {
      const lockPath = getLockPathForJsonl(dataPath);
      const jsonMode = utils.isJsonMode();

      // ------------------------------------------------------------------
      // No lock file
      // ------------------------------------------------------------------
      if (!fs.existsSync(lockPath)) {
        if (jsonMode) {
          output.json({ success: true, lockFound: false });
        } else {
          console.log('No lock file found.');
        }
        return;
      }

      // ------------------------------------------------------------------
      // Lock file exists – try to read metadata
      // ------------------------------------------------------------------
      const lockInfo = readLockInfo(lockPath);
      const corrupted = lockInfo === null;

      if (corrupted) {
        // Corrupted / unparseable lock file
        if (options.force) {
          fs.unlinkSync(lockPath);
          if (jsonMode) {
            output.json({ success: true, lockFound: true, removed: true, corrupted: true });
          } else {
            console.log('Lock file is corrupted (could not parse metadata).');
            console.log('Lock file removed.');
          }
          return;
        }
        // Interactive prompt for corrupted lock
        if (jsonMode) {
          output.json({ success: true, lockFound: true, removed: false, corrupted: true });
        } else {
          console.log('Lock file is corrupted (could not parse metadata).');
          console.log("Run 'wl unlock --force' to remove it.");
        }
        return;
      }

      // ------------------------------------------------------------------
      // Valid metadata – show details and optionally remove
      // ------------------------------------------------------------------
      const alive = isProcessAlive(lockInfo.pid);
      const age = formatLockAge(lockInfo.acquiredAt);

      if (!jsonMode) {
        console.log(`Lock held by PID ${lockInfo.pid} on ${lockInfo.hostname}`);
        console.log(`Acquired: ${lockInfo.acquiredAt} (${age})`);
        if (alive) {
          console.log(`PID ${lockInfo.pid} is still running.`);
        } else {
          console.log(`PID ${lockInfo.pid} is no longer running.`);
        }
      }

      if (options.force) {
        fs.unlinkSync(lockPath);
        if (jsonMode) {
          output.json({
            success: true,
            lockFound: true,
            removed: true,
            lockInfo: {
              pid: lockInfo.pid,
              hostname: lockInfo.hostname,
              acquiredAt: lockInfo.acquiredAt,
              age,
            },
          });
        } else {
          console.log('Lock file removed.');
        }
        return;
      }

      // No --force: just report (non-interactive in initial implementation)
      if (jsonMode) {
        output.json({
          success: true,
          lockFound: true,
          removed: false,
          lockInfo: {
            pid: lockInfo.pid,
            hostname: lockInfo.hostname,
            acquiredAt: lockInfo.acquiredAt,
            age,
          },
        });
      } else {
        console.log("Run 'wl unlock --force' to remove the lock file.");
      }
    });
}
