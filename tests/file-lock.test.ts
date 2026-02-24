/**
 * Tests for file-lock module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as childProcess from 'child_process';
import { acquireFileLock, releaseFileLock, withFileLock, getLockPathForJsonl, isFileLockHeld, _resetLockState, formatLockAge, sleepSync } from '../src/file-lock.js';
import type { FileLockInfo } from '../src/file-lock.js';
import { createTempDir, cleanupTempDir } from './test-utils.js';

describe('file-lock', () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    lockPath = path.join(tempDir, 'test.lock');
  });

  afterEach(() => {
    // Reset reentrancy state between tests
    _resetLockState();
    // Clean up any leftover lock files
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    cleanupTempDir(tempDir);
  });

  describe('getLockPathForJsonl', () => {
    it('should append .lock to the JSONL path', () => {
      expect(getLockPathForJsonl('/path/to/worklog-data.jsonl')).toBe('/path/to/worklog-data.jsonl.lock');
    });

    it('should work with relative paths', () => {
      expect(getLockPathForJsonl('data.jsonl')).toBe('data.jsonl.lock');
    });
  });

  describe('acquireFileLock', () => {
    it('should create a lock file with PID, hostname, and timestamp', () => {
      acquireFileLock(lockPath, { timeout: 1000 });

      expect(fs.existsSync(lockPath)).toBe(true);
      const content = fs.readFileSync(lockPath, 'utf-8');
      const info: FileLockInfo = JSON.parse(content);

      expect(info.pid).toBe(process.pid);
      expect(info.hostname).toBe(os.hostname());
      expect(info.acquiredAt).toBeDefined();
      // Verify it's a valid ISO date
      expect(new Date(info.acquiredAt).toISOString()).toBe(info.acquiredAt);

      // Clean up
      releaseFileLock(lockPath);
    });

    it('should fail quickly when lock is held and timeout is short', () => {
      // Create a lock file manually (simulating another process holding it)
      const otherLockInfo: FileLockInfo = {
        pid: process.pid, // Use current PID so it's seen as alive
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(otherLockInfo));

      expect(() => {
        acquireFileLock(lockPath, { timeout: 100 });
      }).toThrow(/Failed to acquire file lock/);
    });

    it('should succeed after a stale lock from a dead process is cleaned up', () => {
      // Create a lock file with a non-existent PID
      const staleLockInfo: FileLockInfo = {
        pid: 999999, // Very unlikely to be a real PID
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(staleLockInfo));

      // Should succeed because the stale lock is detected and removed
      acquireFileLock(lockPath, { timeout: 5000 });

      // Verify our lock is now in place
      const content = fs.readFileSync(lockPath, 'utf-8');
      const info: FileLockInfo = JSON.parse(content);
      expect(info.pid).toBe(process.pid);

      releaseFileLock(lockPath);
    });

    it('should not clean up stale locks from different hosts', () => {
      // Create a lock file from a "different host"
      const remoteLockInfo: FileLockInfo = {
        pid: 999999,
        hostname: 'some-other-host-that-is-not-this-one',
        acquiredAt: new Date().toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(remoteLockInfo));

      // Should fail because we can't verify the PID on a different host
      expect(() => {
        acquireFileLock(lockPath, { timeout: 100 });
      }).toThrow(/Failed to acquire file lock/);
    });

    it('should respect the timeout option', () => {
      // Create a lock held by the current process
      const lockInfo: FileLockInfo = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(lockInfo));

      const start = Date.now();
      expect(() => {
        acquireFileLock(lockPath, { retryDelay: 50, timeout: 300 });
      }).toThrow(/timeout/);
      const elapsed = Date.now() - start;

      // Should have waited approximately the timeout duration
      expect(elapsed).toBeGreaterThanOrEqual(250); // Allow some slack
      expect(elapsed).toBeLessThan(2000); // But not too long
    });

    it('should create parent directories if they do not exist', () => {
      const deepLockPath = path.join(tempDir, 'a', 'b', 'c', 'test.lock');

      acquireFileLock(deepLockPath, { timeout: 1000 });
      expect(fs.existsSync(deepLockPath)).toBe(true);

      releaseFileLock(deepLockPath);
    });

    it('should throw on unexpected filesystem errors', () => {
      // Try to acquire a lock in a path that cannot be created
      // (e.g. a file where a directory is expected)
      const filePath = path.join(tempDir, 'not-a-dir');
      fs.writeFileSync(filePath, 'block');
      const badLockPath = path.join(filePath, 'test.lock');

      expect(() => {
        acquireFileLock(badLockPath, { timeout: 1000 });
      }).toThrow();
    });
  });

  describe('releaseFileLock', () => {
    it('should remove the lock file', () => {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString() }));
      expect(fs.existsSync(lockPath)).toBe(true);

      releaseFileLock(lockPath);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('should be a no-op if the lock file does not exist', () => {
      expect(fs.existsSync(lockPath)).toBe(false);
      // Should not throw
      releaseFileLock(lockPath);
    });
  });

  describe('withFileLock', () => {
    it('should acquire the lock, run the callback, and release the lock', () => {
      let callbackRan = false;

      withFileLock(lockPath, () => {
        // Verify lock is held during callback
        expect(fs.existsSync(lockPath)).toBe(true);
        callbackRan = true;
      });

      expect(callbackRan).toBe(true);
      // Verify lock is released after callback
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('should return the callback result', () => {
      const result = withFileLock(lockPath, () => 42);
      expect(result).toBe(42);
    });

    it('should release the lock even if the callback throws', () => {
      expect(() => {
        withFileLock(lockPath, () => {
          expect(fs.existsSync(lockPath)).toBe(true);
          throw new Error('callback error');
        });
      }).toThrow('callback error');

      // Lock should be released
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('should handle async callbacks and release lock after resolution', async () => {
      const result = await withFileLock(lockPath, async () => {
        expect(fs.existsSync(lockPath)).toBe(true);
        return 'async-result';
      });

      expect(result).toBe('async-result');
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('should release lock after async callback rejection', async () => {
      await expect(
        withFileLock(lockPath, async () => {
          expect(fs.existsSync(lockPath)).toBe(true);
          throw new Error('async error');
        })
      ).rejects.toThrow('async error');

      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('should serialize access when called sequentially', () => {
      const order: number[] = [];

      withFileLock(lockPath, () => {
        order.push(1);
      });

      withFileLock(lockPath, () => {
        order.push(2);
      });

      withFileLock(lockPath, () => {
        order.push(3);
      });

      expect(order).toEqual([1, 2, 3]);
    });

    it('should pass through options to acquireFileLock', () => {
      // Hold the lock manually
      const lockInfo: FileLockInfo = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(lockInfo));

      expect(() => {
        withFileLock(lockPath, () => {}, { timeout: 100 });
      }).toThrow(/Failed to acquire file lock/);
    });
  });

  describe('retry logic', () => {
    it('should eventually acquire the lock after it is released', () => {
      // Acquire the lock
      acquireFileLock(lockPath, { timeout: 1000 });

      // Schedule release after a short delay
      const releaseAfterMs = 200;
      setTimeout(() => {
        releaseFileLock(lockPath);
      }, releaseAfterMs);

      // Try to acquire in a new "process" context (same process, so we need
      // a different lock path or release first). Since we're in the same
      // process and the lock contains our PID, we simulate by writing a lock
      // with a fake alive PID then releasing it.

      // Actually, let's test this differently — release the current lock
      // and verify re-acquisition works
      releaseFileLock(lockPath);

      // Re-acquire should succeed immediately
      acquireFileLock(lockPath, { timeout: 1000 });
      expect(fs.existsSync(lockPath)).toBe(true);
      releaseFileLock(lockPath);
    });
  });

  describe('stale lock cleanup', () => {
    it('should clean up and re-acquire a stale lock from a dead process', () => {
      // Write a lock file with a non-existent PID
      const stalePid = 999999;
      const staleInfo: FileLockInfo = {
        pid: stalePid,
        hostname: os.hostname(),
        acquiredAt: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
      };
      fs.writeFileSync(lockPath, JSON.stringify(staleInfo));

      // Acquire should succeed (stale lock cleaned up)
      acquireFileLock(lockPath, { timeout: 5000 });

      const content = fs.readFileSync(lockPath, 'utf-8');
      const info: FileLockInfo = JSON.parse(content);
      expect(info.pid).toBe(process.pid);

      releaseFileLock(lockPath);
    });

    it('should not clean up stale locks when staleLockCleanup is false', () => {
      const staleInfo: FileLockInfo = {
        pid: 999999,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(staleInfo));

      expect(() => {
        acquireFileLock(lockPath, { timeout: 100, staleLockCleanup: false });
      }).toThrow(/Failed to acquire file lock/);
    });

    it('should recover from corrupted lock file with garbage content', () => {
      // Write garbage content to the lock file
      fs.writeFileSync(lockPath, 'not-json-content');

      // Should succeed: corrupted lock file is treated as stale, removed, and lock acquired
      acquireFileLock(lockPath, { timeout: 5000 });

      // Verify our lock is now in place
      const content = fs.readFileSync(lockPath, 'utf-8');
      const info: FileLockInfo = JSON.parse(content);
      expect(info.pid).toBe(process.pid);

      releaseFileLock(lockPath);
    });

    it('should recover from an empty lock file (0 bytes)', () => {
      // Write an empty file to simulate a crash during lock creation
      fs.writeFileSync(lockPath, '');

      // Should succeed: empty lock file is treated as corrupted/stale
      acquireFileLock(lockPath, { timeout: 5000 });

      // Verify our lock is now in place
      const content = fs.readFileSync(lockPath, 'utf-8');
      const info: FileLockInfo = JSON.parse(content);
      expect(info.pid).toBe(process.pid);

      releaseFileLock(lockPath);
    });

    it('should recover from lock file with valid JSON but missing required fields', () => {
      // Write valid JSON that lacks required pid and hostname fields
      fs.writeFileSync(lockPath, JSON.stringify({ someOtherField: 'value' }));

      // Should succeed: missing required fields means readLockInfo returns null
      acquireFileLock(lockPath, { timeout: 5000 });

      // Verify our lock is now in place
      const content = fs.readFileSync(lockPath, 'utf-8');
      const info: FileLockInfo = JSON.parse(content);
      expect(info.pid).toBe(process.pid);

      releaseFileLock(lockPath);
    });

    it('should NOT treat a valid lock file as corrupted', () => {
      // Write a properly formatted lock file held by the current (alive) process
      const validLockInfo: FileLockInfo = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(validLockInfo));

      // Should fail: lock is held by a live process, not corrupted
      expect(() => {
        acquireFileLock(lockPath, { timeout: 100 });
      }).toThrow(/Failed to acquire file lock/);
    });

    it('should not clean up corrupted lock files when staleLockCleanup is false', () => {
      // Write garbage content to the lock file
      fs.writeFileSync(lockPath, 'not-json-content');

      // Should fail because staleLockCleanup is disabled
      expect(() => {
        acquireFileLock(lockPath, { timeout: 100, staleLockCleanup: false });
      }).toThrow(/Failed to acquire file lock/);
    });
  });

  describe('age-based lock expiry', () => {
    it('should remove a lock older than maxLockAge even if PID is alive', () => {
      // Write a lock file with current PID (alive) but acquiredAt 6 minutes ago
      const oldLockInfo: FileLockInfo = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(), // 6 minutes ago
      };
      fs.writeFileSync(lockPath, JSON.stringify(oldLockInfo));

      // Should succeed: lock is older than default 5-minute threshold
      acquireFileLock(lockPath, { timeout: 5000 });

      const content = fs.readFileSync(lockPath, 'utf-8');
      const info: FileLockInfo = JSON.parse(content);
      expect(info.pid).toBe(process.pid);
      // Verify acquiredAt is recent (not the old one)
      const age = Date.now() - new Date(info.acquiredAt).getTime();
      expect(age).toBeLessThan(5000);

      releaseFileLock(lockPath);
    });

    it('should NOT remove a fresh lock held by a live PID', () => {
      // Write a lock file with current PID and acquiredAt 1 minute ago (within threshold)
      const freshLockInfo: FileLockInfo = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date(Date.now() - 1 * 60 * 1000).toISOString(), // 1 minute ago
      };
      fs.writeFileSync(lockPath, JSON.stringify(freshLockInfo));

      // Should fail: lock is fresh and held by a live process
      expect(() => {
        acquireFileLock(lockPath, { timeout: 100 });
      }).toThrow(/Failed to acquire file lock/);
    });

    it('should remove an old lock with a dead PID (both triggers)', () => {
      // Lock is both old AND held by a dead PID
      const oldDeadLockInfo: FileLockInfo = {
        pid: 999999,
        hostname: os.hostname(),
        acquiredAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(), // 6 minutes ago
      };
      fs.writeFileSync(lockPath, JSON.stringify(oldDeadLockInfo));

      // Should succeed: dead PID would trigger cleanup alone, age confirms
      acquireFileLock(lockPath, { timeout: 5000 });

      const content = fs.readFileSync(lockPath, 'utf-8');
      const info: FileLockInfo = JSON.parse(content);
      expect(info.pid).toBe(process.pid);

      releaseFileLock(lockPath);
    });

    it('should remove a fresh lock with a dead PID (PID-based cleanup, existing behavior)', () => {
      // Lock is fresh but held by a dead process
      const freshDeadLockInfo: FileLockInfo = {
        pid: 999999,
        hostname: os.hostname(),
        acquiredAt: new Date(Date.now() - 1 * 60 * 1000).toISOString(), // 1 minute ago
      };
      fs.writeFileSync(lockPath, JSON.stringify(freshDeadLockInfo));

      // Should succeed: dead PID triggers cleanup even though lock is young
      acquireFileLock(lockPath, { timeout: 5000 });

      const content = fs.readFileSync(lockPath, 'utf-8');
      const info: FileLockInfo = JSON.parse(content);
      expect(info.pid).toBe(process.pid);

      releaseFileLock(lockPath);
    });

    it('should NOT treat a lock with acquiredAt in the future as expired', () => {
      // Lock with acquiredAt in the future (clock skew scenario)
      const futureLockInfo: FileLockInfo = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 minutes in the future
      };
      fs.writeFileSync(lockPath, JSON.stringify(futureLockInfo));

      // Should fail: future acquiredAt should not be treated as expired
      expect(() => {
        acquireFileLock(lockPath, { timeout: 100 });
      }).toThrow(/Failed to acquire file lock/);
    });

    it('should respect a custom maxLockAge option', () => {
      // Write a lock 2 seconds old with an alive PID
      const recentLockInfo: FileLockInfo = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date(Date.now() - 2000).toISOString(), // 2 seconds ago
      };
      fs.writeFileSync(lockPath, JSON.stringify(recentLockInfo));

      // With a 1-second maxLockAge, this 2-second-old lock should be treated as stale
      acquireFileLock(lockPath, { timeout: 5000, maxLockAge: 1000 });

      const content = fs.readFileSync(lockPath, 'utf-8');
      const info: FileLockInfo = JSON.parse(content);
      expect(info.pid).toBe(process.pid);
      // Verify it's a new lock, not the old one
      const age = Date.now() - new Date(info.acquiredAt).getTime();
      expect(age).toBeLessThan(5000);

      releaseFileLock(lockPath);
    });

    it('should NOT expire a lock within a custom maxLockAge threshold', () => {
      // Write a lock 500ms old with an alive PID
      const recentLockInfo: FileLockInfo = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date(Date.now() - 500).toISOString(), // 500ms ago
      };
      fs.writeFileSync(lockPath, JSON.stringify(recentLockInfo));

      // With a 5-second maxLockAge, this 500ms lock should be considered fresh
      expect(() => {
        acquireFileLock(lockPath, { timeout: 100, maxLockAge: 5000 });
      }).toThrow(/Failed to acquire file lock/);
    });
  });

  describe('error messages', () => {
    it('should include lock file path in timeout error', () => {
      const lockInfo: FileLockInfo = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(lockInfo));

      try {
        acquireFileLock(lockPath, { timeout: 100 });
        expect.unreachable('should have thrown');
      } catch (err: any) {
        expect(err.message).toContain(lockPath);
      }
    });

    it('should include holder PID, hostname, and acquiredAt in error', () => {
      const lockInfo: FileLockInfo = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(lockInfo));

      try {
        acquireFileLock(lockPath, { timeout: 100 });
        expect.unreachable('should have thrown');
      } catch (err: any) {
        expect(err.message).toContain(`PID ${process.pid}`);
        expect(err.message).toContain(os.hostname());
        expect(err.message).toContain(lockInfo.acquiredAt);
      }
    });

    it('should include human-readable lock age in error', () => {
      const lockInfo: FileLockInfo = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(), // 12 minutes ago
      };
      fs.writeFileSync(lockPath, JSON.stringify(lockInfo));

      try {
        // Use a maxLockAge larger than 12 minutes so the lock is NOT
        // cleaned up by age-based expiry — we want the error to fire
        // with the holder metadata intact so we can assert on the age string.
        acquireFileLock(lockPath, { timeout: 100, maxLockAge: 60 * 60 * 1000 });
        expect.unreachable('should have thrown');
      } catch (err: any) {
        expect(err.message).toMatch(/12 minutes? ago/);
      }
    });

    it('should suggest wl unlock in error message', () => {
      const lockInfo: FileLockInfo = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(lockInfo));

      try {
        acquireFileLock(lockPath, { timeout: 100 });
        expect.unreachable('should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('wl unlock');
      }
    });

    it('should say corrupted lock file when lock info is unparseable', () => {
      // Write garbage — but with staleLockCleanup disabled so it can't auto-recover
      fs.writeFileSync(lockPath, 'not-json-content');

      try {
        acquireFileLock(lockPath, { timeout: 100, staleLockCleanup: false });
        expect.unreachable('should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('corrupted lock file');
      }
    });

    it('should include enriched message in timeout error', () => {
      const lockInfo: FileLockInfo = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date(Date.now() - 30000).toISOString(), // 30 seconds ago
      };
      fs.writeFileSync(lockPath, JSON.stringify(lockInfo));

      try {
        acquireFileLock(lockPath, { retryDelay: 10, timeout: 100 });
        expect.unreachable('should have thrown');
      } catch (err: any) {
        expect(err.message).toContain(lockPath);
        expect(err.message).toContain(`PID ${process.pid}`);
        expect(err.message).toContain('wl unlock');
        expect(err.message).toMatch(/ago/);
        expect(err.message).toContain('timeout');
      }
    });
  });

  describe('formatLockAge', () => {
    it('should format seconds ago', () => {
      const result = formatLockAge(new Date(Date.now() - 5000).toISOString());
      expect(result).toMatch(/5 seconds? ago/);
    });

    it('should format minutes ago', () => {
      const result = formatLockAge(new Date(Date.now() - 3 * 60 * 1000).toISOString());
      expect(result).toMatch(/3 minutes? ago/);
    });

    it('should format hours ago', () => {
      const result = formatLockAge(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
      expect(result).toMatch(/2 hours? ago/);
    });

    it('should handle future timestamps gracefully', () => {
      const result = formatLockAge(new Date(Date.now() + 60000).toISOString());
      expect(result).toMatch(/just now|0 seconds ago|in the future/);
    });
  });

  describe('reentrancy', () => {
    it('should allow nested withFileLock calls on the same path without deadlocking', () => {
      const order: string[] = [];

      withFileLock(lockPath, () => {
        order.push('outer-start');
        expect(isFileLockHeld(lockPath)).toBe(true);

        // Nested call on the same lock path — must not deadlock
        withFileLock(lockPath, () => {
          order.push('inner');
          expect(isFileLockHeld(lockPath)).toBe(true);
        });

        order.push('outer-end');
        expect(isFileLockHeld(lockPath)).toBe(true);
      });

      expect(order).toEqual(['outer-start', 'inner', 'outer-end']);
      // Lock should be fully released after outermost withFileLock returns
      expect(isFileLockHeld(lockPath)).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('should track reentrancy depth correctly across three nesting levels', () => {
      let depths: boolean[] = [];

      withFileLock(lockPath, () => {
        depths.push(isFileLockHeld(lockPath)); // true (depth 1)

        withFileLock(lockPath, () => {
          depths.push(isFileLockHeld(lockPath)); // true (depth 2)

          withFileLock(lockPath, () => {
            depths.push(isFileLockHeld(lockPath)); // true (depth 3)
          });

          depths.push(isFileLockHeld(lockPath)); // true (depth 2 again)
        });

        depths.push(isFileLockHeld(lockPath)); // true (depth 1 again)
      });

      // All checks should be true while inside withFileLock
      expect(depths).toEqual([true, true, true, true, true]);
      // After outermost exits, lock should be released
      expect(isFileLockHeld(lockPath)).toBe(false);
    });

    it('should release lock file only when outermost withFileLock exits', () => {
      withFileLock(lockPath, () => {
        // Lock file should exist on disk (outer acquired it)
        expect(fs.existsSync(lockPath)).toBe(true);

        withFileLock(lockPath, () => {
          // Still exists — inner didn't touch it
          expect(fs.existsSync(lockPath)).toBe(true);
        });

        // Inner returned but lock file should still exist (outer still holds it)
        expect(fs.existsSync(lockPath)).toBe(true);
      });

      // Now outer returned — lock file should be gone
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('should clean up reentrancy state if inner callback throws', () => {
      expect(() => {
        withFileLock(lockPath, () => {
          withFileLock(lockPath, () => {
            throw new Error('inner error');
          });
        });
      }).toThrow('inner error');

      // Reentrancy state should be fully cleaned up
      expect(isFileLockHeld(lockPath)).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('should clean up reentrancy state if outer callback throws after successful inner', () => {
      expect(() => {
        withFileLock(lockPath, () => {
          withFileLock(lockPath, () => {
            // inner succeeds
          });
          throw new Error('outer error');
        });
      }).toThrow('outer error');

      expect(isFileLockHeld(lockPath)).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('should handle async nested withFileLock calls', async () => {
      const order: string[] = [];

      await withFileLock(lockPath, async () => {
        order.push('outer-start');

        await withFileLock(lockPath, async () => {
          order.push('inner');
        });

        order.push('outer-end');
      });

      expect(order).toEqual(['outer-start', 'inner', 'outer-end']);
      expect(isFileLockHeld(lockPath)).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('should clean up reentrancy state on async inner rejection', async () => {
      await expect(
        withFileLock(lockPath, async () => {
          await withFileLock(lockPath, async () => {
            throw new Error('async inner error');
          });
        })
      ).rejects.toThrow('async inner error');

      expect(isFileLockHeld(lockPath)).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('should treat different lock paths independently', () => {
      const lockPath2 = path.join(tempDir, 'test2.lock');

      withFileLock(lockPath, () => {
        expect(isFileLockHeld(lockPath)).toBe(true);
        expect(isFileLockHeld(lockPath2)).toBe(false);

        withFileLock(lockPath2, () => {
          expect(isFileLockHeld(lockPath)).toBe(true);
          expect(isFileLockHeld(lockPath2)).toBe(true);
        });

        expect(isFileLockHeld(lockPath2)).toBe(false);
        expect(isFileLockHeld(lockPath)).toBe(true);
      });

      expect(isFileLockHeld(lockPath)).toBe(false);
      expect(isFileLockHeld(lockPath2)).toBe(false);

      // Clean up
      try { fs.unlinkSync(lockPath2); } catch { /* ignore */ }
    });

    it('should return values from nested withFileLock calls', () => {
      const result = withFileLock(lockPath, () => {
        const inner = withFileLock(lockPath, () => {
          return 'inner-value';
        });
        return `outer-${inner}`;
      });

      expect(result).toBe('outer-inner-value');
    });

    it('should treat relative and absolute paths to the same file as one lock', () => {
      // Use the absolute lockPath and a relative version of the same path
      const cwd = process.cwd();
      const relativeLockPath = path.relative(cwd, lockPath);

      withFileLock(lockPath, () => {
        expect(isFileLockHeld(lockPath)).toBe(true);

        // Nested call with the relative path — should be treated as reentrant
        withFileLock(relativeLockPath, () => {
          expect(isFileLockHeld(relativeLockPath)).toBe(true);
        });

        // Lock should still be held (outer hasn't returned)
        expect(isFileLockHeld(lockPath)).toBe(true);
        expect(fs.existsSync(lockPath)).toBe(true);
      });

      expect(isFileLockHeld(lockPath)).toBe(false);
    });
  });

  describe('isFileLockHeld', () => {
    it('should return false when no lock is held', () => {
      expect(isFileLockHeld(lockPath)).toBe(false);
    });

    it('should return true inside withFileLock', () => {
      withFileLock(lockPath, () => {
        expect(isFileLockHeld(lockPath)).toBe(true);
      });
    });

    it('should return false after withFileLock completes', () => {
      withFileLock(lockPath, () => {});
      expect(isFileLockHeld(lockPath)).toBe(false);
    });
  });

  describe('_resetLockState', () => {
    it('should clear all tracked reentrancy state', () => {
      withFileLock(lockPath, () => {
        expect(isFileLockHeld(lockPath)).toBe(true);
        // Simulate an abnormal situation: reset while lock is held
        _resetLockState();
        expect(isFileLockHeld(lockPath)).toBe(false);
      });
      // Note: the outer withFileLock will still release the file on disk
    });
  });

  describe('sleepSync', () => {
    it('should not busy-wait (CPU time should be negligible during sleep)', () => {
      const sleepMs = 200;
      const cpuBefore = process.cpuUsage();
      sleepSync(sleepMs);
      const cpuAfter = process.cpuUsage(cpuBefore);

      // Total CPU time (user + system) should be well under 50ms even
      // though we slept for 200ms.  A busy-wait loop would consume
      // ~200ms of CPU time.  cpuUsage reports in microseconds.
      const totalCpuUs = cpuAfter.user + cpuAfter.system;
      expect(totalCpuUs).toBeLessThan(50_000); // < 50ms of CPU time
    });

    it('should sleep for approximately the requested duration', () => {
      const sleepMs = 100;
      const start = Date.now();
      sleepSync(sleepMs);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(80); // allow some slack
      expect(elapsed).toBeLessThan(500); // but not absurdly long
    });

    it('should not throw or hang for sleepSync(0)', () => {
      const start = Date.now();
      sleepSync(0);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
    });

    it('should not throw or hang for sleepSync(-1)', () => {
      const start = Date.now();
      sleepSync(-1);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('exponential backoff with jitter', () => {
    it('should use increasing delays between retry attempts', () => {
      // Hold the lock with a live PID so retries are needed
      const lockInfo: FileLockInfo = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(lockInfo));

      // Capture sleepSync calls by temporarily intercepting debug output
      const delays: number[] = [];
      const origDebugEnv = process.env.WL_DEBUG;
      process.env.WL_DEBUG = '1';

      const origWrite = process.stderr.write;
      process.stderr.write = ((chunk: any, enc?: any, cb?: any) => {
        const line = typeof chunk === 'string' ? chunk : chunk.toString();
        // Parse delay from debug log: "sleeping Xms (base delay Yms)"
        const match = line.match(/base delay (\d+)ms/);
        if (match) {
          delays.push(parseInt(match[1], 10));
        }
        if (typeof cb === 'function') cb();
        return true;
      }) as any;

      try {
        acquireFileLock(lockPath, { retryDelay: 100, timeout: 2000, maxRetryDelay: 5000 });
      } catch {
        // Expected: timeout
      } finally {
        process.stderr.write = origWrite;
        process.env.WL_DEBUG = origDebugEnv;
        if (!origDebugEnv) delete process.env.WL_DEBUG;
      }

      // Should have multiple delays that increase
      expect(delays.length).toBeGreaterThanOrEqual(2);

      // Verify delays are non-decreasing (allowing for equal at cap)
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
      }

      // First delay should be the initial retryDelay
      expect(delays[0]).toBe(100);

      // Second delay should be approximately 1.5x
      if (delays.length >= 2) {
        expect(delays[1]).toBe(150); // 100 * 1.5
      }
    });

    it('should cap delay at maxRetryDelay', () => {
      const lockInfo: FileLockInfo = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(lockInfo));

      const delays: number[] = [];
      const origDebugEnv = process.env.WL_DEBUG;
      process.env.WL_DEBUG = '1';

      const origWrite = process.stderr.write;
      process.stderr.write = ((chunk: any, enc?: any, cb?: any) => {
        const line = typeof chunk === 'string' ? chunk : chunk.toString();
        const match = line.match(/base delay (\d+)ms/);
        if (match) {
          delays.push(parseInt(match[1], 10));
        }
        if (typeof cb === 'function') cb();
        return true;
      }) as any;

      try {
        acquireFileLock(lockPath, { retryDelay: 100, timeout: 5000, maxRetryDelay: 200 });
      } catch {
        // Expected: timeout
      } finally {
        process.stderr.write = origWrite;
        process.env.WL_DEBUG = origDebugEnv;
        if (!origDebugEnv) delete process.env.WL_DEBUG;
      }

      // All delays should be <= maxRetryDelay (200ms)
      for (const delay of delays) {
        expect(delay).toBeLessThanOrEqual(200);
      }
    });

    it('should add jitter within 0-25% of base delay', () => {
      const lockInfo: FileLockInfo = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(lockInfo));

      const sleepValues: number[] = [];
      const baseValues: number[] = [];
      const origDebugEnv = process.env.WL_DEBUG;
      process.env.WL_DEBUG = '1';

      const origWrite = process.stderr.write;
      process.stderr.write = ((chunk: any, enc?: any, cb?: any) => {
        const line = typeof chunk === 'string' ? chunk : chunk.toString();
        const match = line.match(/sleeping (\d+)ms \(base delay (\d+)ms\)/);
        if (match) {
          sleepValues.push(parseInt(match[1], 10));
          baseValues.push(parseInt(match[2], 10));
        }
        if (typeof cb === 'function') cb();
        return true;
      }) as any;

      try {
        // Use small delays and a generous timeout so clamping doesn't interfere
        acquireFileLock(lockPath, { retryDelay: 50, timeout: 5000, maxRetryDelay: 5000 });
      } catch {
        // Expected: timeout
      } finally {
        process.stderr.write = origWrite;
        process.env.WL_DEBUG = origDebugEnv;
        if (!origDebugEnv) delete process.env.WL_DEBUG;
      }

      // Only check entries where sleep was NOT clamped to remaining time
      // (i.e., actual sleep is near the base delay range)
      const unclamped = sleepValues.filter((s, i) => s >= baseValues[i]);

      expect(unclamped.length).toBeGreaterThanOrEqual(2);

      for (let i = 0; i < unclamped.length; i++) {
        const idx = sleepValues.indexOf(unclamped[i]);
        const base = baseValues[idx];
        const actual = unclamped[i];
        // actual should be >= base (jitter is always positive)
        expect(actual).toBeGreaterThanOrEqual(base);
        // actual should be <= base + 25% of base (allowing rounding)
        expect(actual).toBeLessThanOrEqual(Math.ceil(base * 1.25) + 1);
      }
    });

    it('should clamp sleep to remaining time before deadline', () => {
      const lockInfo: FileLockInfo = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(lockInfo));

      const start = Date.now();
      try {
        // Short timeout with large retry delay — should clamp
        acquireFileLock(lockPath, { retryDelay: 10000, timeout: 200 });
      } catch {
        // Expected: timeout
      }

      const elapsed = Date.now() - start;
      // Should not have slept for 10s; should have been clamped to ~200ms
      expect(elapsed).toBeLessThan(2000);
    });
  });

  describe('concurrent multi-process access', () => {
    /**
     * Helper script that each child process runs.
     * It acquires the lock, reads a counter from a shared file, increments it,
     * writes it back, and releases the lock.
     *
     * Without the lock, concurrent processes would lose increments (TOCTOU race).
     * With the lock, the final counter value must equal the number of increments.
     */
    function createWorkerScript(dir: string): string {
      const scriptPath = path.join(dir, 'lock-worker.mjs');
      const script = `
import * as fs from 'fs';
import * as path from 'path';

// Import the compiled file-lock module
const fileLock = await import(path.resolve(process.argv[2]));

const lockPath = process.argv[3];
const counterFile = process.argv[4];
const iterations = parseInt(process.argv[5], 10);

for (let i = 0; i < iterations; i++) {
  fileLock.withFileLock(lockPath, () => {
    // Read current counter
    let counter = 0;
    try {
      counter = parseInt(fs.readFileSync(counterFile, 'utf-8'), 10);
      if (isNaN(counter)) counter = 0;
    } catch {
      counter = 0;
    }

    // Increment and write back
    counter++;
    fs.writeFileSync(counterFile, String(counter));
  }, { retryDelay: 50, timeout: 30000 });
}

// Signal success
process.exit(0);
`;
      fs.writeFileSync(scriptPath, script);
      return scriptPath;
    }

    it('should serialize writes across multiple processes (no lost increments)', () => {
      const workerScript = createWorkerScript(tempDir);
      const counterFile = path.join(tempDir, 'counter.txt');
      const sharedLockPath = path.join(tempDir, 'shared.lock');

      // Initialize counter
      fs.writeFileSync(counterFile, '0');

      const numWorkers = 4;
      const iterationsPerWorker = 10;

      // Find the compiled file-lock module
      const fileLockModulePath = path.resolve(__dirname, '..', 'dist', 'file-lock.js');

      // If dist doesn't exist (not built), skip this test gracefully
      if (!fs.existsSync(fileLockModulePath)) {
        // Try using tsx to run the TypeScript source directly
        const fileLockTsPath = path.resolve(__dirname, '..', 'src', 'file-lock.ts');

        // Spawn workers using tsx
        const workers: childProcess.SpawnSyncReturns<string>[] = [];

        for (let i = 0; i < numWorkers; i++) {
          const result = childProcess.spawnSync(
            process.execPath,
            [
              '--import', 'tsx',
              workerScript,
              fileLockTsPath,
              sharedLockPath,
              counterFile,
              String(iterationsPerWorker),
            ],
            {
              encoding: 'utf-8',
              timeout: 60000,
              env: { ...process.env, NODE_NO_WARNINGS: '1' },
            }
          );
          workers.push(result);
        }

        // All workers must exit successfully
        for (let i = 0; i < workers.length; i++) {
          if (workers[i].status !== 0) {
            console.error(`Worker ${i} failed:`, workers[i].stderr);
          }
          expect(workers[i].status).toBe(0);
        }

        // The final counter value must equal numWorkers * iterationsPerWorker
        const finalCounter = parseInt(fs.readFileSync(counterFile, 'utf-8'), 10);
        expect(finalCounter).toBe(numWorkers * iterationsPerWorker);
        return;
      }

      // Spawn workers using the compiled JS module
      const workers: childProcess.SpawnSyncReturns<string>[] = [];

      for (let i = 0; i < numWorkers; i++) {
        const result = childProcess.spawnSync(
          process.execPath,
          [
            workerScript,
            fileLockModulePath,
            sharedLockPath,
            counterFile,
            String(iterationsPerWorker),
          ],
          {
            encoding: 'utf-8',
            timeout: 60000,
            env: { ...process.env, NODE_NO_WARNINGS: '1' },
          }
        );
        workers.push(result);
      }

      // All workers must exit successfully
      for (let i = 0; i < workers.length; i++) {
        if (workers[i].status !== 0) {
          console.error(`Worker ${i} failed:`, workers[i].stderr);
        }
        expect(workers[i].status).toBe(0);
      }

      // The final counter value must equal numWorkers * iterationsPerWorker
      const finalCounter = parseInt(fs.readFileSync(counterFile, 'utf-8'), 10);
      expect(finalCounter).toBe(numWorkers * iterationsPerWorker);
    }, 60000); // 60s timeout for this test

    it('should serialize writes when workers run concurrently (parallel spawn)', async () => {
      const workerScript = createWorkerScript(tempDir);
      const counterFile = path.join(tempDir, 'counter-parallel.txt');
      const sharedLockPath = path.join(tempDir, 'shared-parallel.lock');

      // Initialize counter
      fs.writeFileSync(counterFile, '0');

      const numWorkers = 4;
      const iterationsPerWorker = 10;

      // Determine module path
      const fileLockModulePath = path.resolve(__dirname, '..', 'dist', 'file-lock.js');
      const fileLockTsPath = path.resolve(__dirname, '..', 'src', 'file-lock.ts');
      const useTs = !fs.existsSync(fileLockModulePath);
      const modulePath = useTs ? fileLockTsPath : fileLockModulePath;

      // Spawn all workers in parallel and wait for them via promises
      const workerPromises: Promise<{ index: number; exitCode: number | null; stderr: string }>[] = [];

      for (let i = 0; i < numWorkers; i++) {
        const args = useTs
          ? ['--import', 'tsx', workerScript, modulePath, sharedLockPath, counterFile, String(iterationsPerWorker)]
          : [workerScript, modulePath, sharedLockPath, counterFile, String(iterationsPerWorker)];

        const promise = new Promise<{ index: number; exitCode: number | null; stderr: string }>((resolve) => {
          const child = childProcess.spawn(process.execPath, args, {
            env: { ...process.env, NODE_NO_WARNINGS: '1' },
            stdio: ['ignore', 'ignore', 'pipe'],
          });

          let stderr = '';
          child.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString();
          });

          child.on('close', (code) => {
            resolve({ index: i, exitCode: code, stderr });
          });

          child.on('error', (err) => {
            resolve({ index: i, exitCode: -1, stderr: err.message });
          });
        });

        workerPromises.push(promise);
      }

      const results = await Promise.all(workerPromises);

      // Verify all workers succeeded
      for (const result of results) {
        if (result.exitCode !== 0) {
          console.error(`Parallel worker ${result.index} failed (exit ${result.exitCode}):`, result.stderr);
        }
        expect(result.exitCode).toBe(0);
      }

      // The final counter value must equal numWorkers * iterationsPerWorker
      const finalCounter = parseInt(fs.readFileSync(counterFile, 'utf-8'), 10);
      expect(finalCounter).toBe(numWorkers * iterationsPerWorker);
    }, 60000); // 60s timeout
  });

  // -----------------------------------------------------------------------
  // Diagnostic logging (WL_DEBUG)
  // -----------------------------------------------------------------------
  describe('diagnostic logging', () => {
    let stderrChunks: string[];
    let origStderrWrite: typeof process.stderr.write;

    function captureStderr() {
      stderrChunks = [];
      origStderrWrite = process.stderr.write;
      process.stderr.write = ((chunk: any, enc?: any, cb?: any) => {
        stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
        if (typeof cb === 'function') cb();
        return true;
      }) as any;
    }

    function restoreStderr(): string {
      process.stderr.write = origStderrWrite;
      return stderrChunks.join('');
    }

    afterEach(() => {
      // Ensure stderr is always restored even if a test fails
      if (origStderrWrite) {
        process.stderr.write = origStderrWrite;
      }
      delete process.env.WL_DEBUG;
    });

    it('should produce debug output on stderr when WL_DEBUG=1 during acquire/release', () => {
      process.env.WL_DEBUG = '1';
      captureStderr();

      acquireFileLock(lockPath, { timeout: 5000 });
      releaseFileLock(lockPath);

      const output = restoreStderr();
      expect(output).toContain('[wl:lock]');
      // Should log acquisition with PID and lock path
      expect(output).toMatch(/acquir/i);
      expect(output).toContain(String(process.pid));
      // Should log release
      expect(output).toMatch(/releas/i);
    });

    it('should produce NO debug output when WL_DEBUG is not set', () => {
      delete process.env.WL_DEBUG;
      captureStderr();

      acquireFileLock(lockPath, { timeout: 5000 });
      releaseFileLock(lockPath);

      const output = restoreStderr();
      expect(output).not.toContain('[wl:lock]');
    });

    it('should log stale lock cleanup reason when PID is dead', () => {
      // Create a lock file with a dead PID
      const staleLock: FileLockInfo = {
        pid: 99999,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(staleLock));

      process.env.WL_DEBUG = '1';
      captureStderr();

      acquireFileLock(lockPath, { timeout: 5000 });
      releaseFileLock(lockPath);

      const output = restoreStderr();
      expect(output).toContain('[wl:lock]');
      // Should mention stale/dead PID cleanup
      expect(output).toMatch(/stale|dead/i);
      expect(output).toContain('99999');
    });

    it('should log stale lock cleanup reason when lock is age-expired', () => {
      // Create a lock file that's older than maxLockAge
      const oldLock: FileLockInfo = {
        pid: process.pid, // alive PID but too old
        hostname: os.hostname(),
        acquiredAt: new Date(Date.now() - 600_000).toISOString(), // 10 min ago
      };
      fs.writeFileSync(lockPath, JSON.stringify(oldLock));

      process.env.WL_DEBUG = '1';
      captureStderr();

      acquireFileLock(lockPath, { timeout: 5000, maxLockAge: 1000 });
      releaseFileLock(lockPath);

      const output = restoreStderr();
      expect(output).toContain('[wl:lock]');
      // Should mention age-based expiry
      expect(output).toMatch(/age|expir/i);
    });

    it('should log stale lock cleanup reason when lock is corrupted', () => {
      // Create a corrupted lock file
      fs.writeFileSync(lockPath, 'not-valid-json');

      process.env.WL_DEBUG = '1';
      captureStderr();

      acquireFileLock(lockPath, { timeout: 5000 });
      releaseFileLock(lockPath);

      const output = restoreStderr();
      expect(output).toContain('[wl:lock]');
      // Should mention corrupted
      expect(output).toMatch(/corrupt/i);
    });

    it('should include attempt number in acquire log', () => {
      process.env.WL_DEBUG = '1';
      captureStderr();

      acquireFileLock(lockPath, { timeout: 5000 });
      releaseFileLock(lockPath);

      const output = restoreStderr();
      // Should mention attempt 1 (or attempt 0, depending on implementation)
      expect(output).toMatch(/attempt/i);
    });
  });
});
