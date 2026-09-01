/**
 * packages/herdr/src/leader-election.ts — Leader election with file-lock + 5-minute lease
 *
 * Parent: WL-0MSXH3UF5000HJUS (Leader Election Module),
 * parent of WL-0MST3OJ8S0001ROL (Refactor Downtime Dispatcher).
 *
 * Implements file-lock-based leader election with lease management:
 *
 *  - A file lock at `<worklog-root>/.worklog/downtime-leader.lock` elects
 *    a single leader per worklog directory.
 *  - The leader holds a 5-minute lease (TTL), refreshed on each proxy-poll
 *    cycle. If the lease expires (leader crashed or idle), instances detect
 *    the expiry and run a new election.
 *  - Non-leader instances detect the lock is held and retry with exponential
 *    backoff (1–2s initial).
 *  - When the coordination file is missing or unreadable, instances degrade
 *    gracefully (no dispatch).
 *
 * Fail-safe: missing/unreadable coordination file or failed leader election
 * degrades to no-dispatch from that instance.
 *
 * Single-machine only for v1 — coordination file access uses flock.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// ── Constants ──────────────────────────────────────────────────────────

/** Lock file name (inside the worklog directory). */
export const LEADER_LOCK_FILE = 'downtime-leader.lock';

/** Lease file name (inside the worklog directory). */
export const LEASE_FILE = 'downtime-leader-lease.json';

/** Default lease TTL in seconds (5 minutes). */
export const DEFAULT_LEASE_TTL_SECONDS = 300;

/** Initial backoff for re-election attempts (milliseconds). */
export const DEFAULT_REELECTION_BACKOFF_MS = 1000;

/** Maximum backoff for re-election attempts (milliseconds). */
export const MAX_REELECTION_BACKOFF_MS = 2000;

/** Minimum lease TTL to consider valid (10 seconds — allows for clock skew). */
const MIN_VALID_LEASE_TTL_MS = 10_000;

// ── Types ──────────────────────────────────────────────────────────────

/**
 * Lease data stored in the lease file.
 * `leaderId` is a unique identifier for the leader instance.
 * `acquiredAt` is the ISO-8601 timestamp when the lease was acquired.
 * `ttlSeconds` is the lease TTL in seconds.
 */
export interface LeaderLease {
  leaderId: string;
  acquiredAt: string;
  ttlSeconds: number;
}

/**
 * Election result. `isLeader: true` means this instance won the election;
 * `isLeader: false` means another instance is the leader (or the election
 * is ongoing).
 */
export interface ElectionResult {
  isLeader: boolean;
  leaderId?: string;
}

/**
 * Leader election manager interface.
 *
 * The manager is constructed with a worklog directory and an optional
 * unique instance ID (generated if not provided). It owns the lock file
 * and lease file and provides methods to manage the election state.
 */
export interface LeaderElectionManager {
  /**
   * True if this instance is the current leader.
   * Checks the lease file for expiry and the lock file for ownership.
   */
  isLeader(): boolean;

  /**
   * Refresh the lease. Called by the leader on each proxy-poll cycle
   * to extend the lease TTL.
   */
  refreshLease(): void;

  /**
   * Detect a stale leader lease and clear it if expired.
   * Called by non-leader instances to determine if a re-election should
   * be attempted. Returns true if the lease was detected as stale.
   */
  detectStaleLeader(): boolean;

  /**
   * True when a lease file exists at all (held by ANY instance, current
   * or expired). Callers use it to decide between "no leader yet — run a
   * fresh election" and "a leader exists with a valid lease — stay
   * non-leader" (the worker attempts an election on no-lease as well as
   * on stale-lease).
   */
  hasLease(): boolean;

  /**
   * Attempt to acquire leadership. Runs a new election: tries to
   * acquire the file lock and write a new lease. Returns true if this
   * instance became the leader.
   */
  attemptElection(): boolean;

  /**
   * Release leadership (the leader voluntarily steps down).
   * Clears the lease file and releases the file lock.
   */
  releaseLeadership(): void;

  /**
   * Generate a unique instance ID. Called on construction if no
   * instance ID is provided.
   */
  getInstanceId(): string;

  /**
   * Clean up any lock/lease files. Called on shutdown.
   *
   * NOTE: does NOT delete the lease/lock files — a departing leader's
   * files must remain so other instances detect the lease expiry and
   * run a new election (crash-recovery design). Use
   * `releaseLeadership()` for an explicit voluntary hand-off.
   */
  close(): void;

  /**
   * The worklog directory this manager operates on.
   */
  readonly worklogDir: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Generate a unique instance ID (UUID v4). */
function generateInstanceId(): string {
  return crypto.randomUUID();
}

/** Resolve the lock file path. */
function lockFilePath(worklogDir: string): string {
  return path.join(worklogDir, LEADER_LOCK_FILE);
}

/** Resolve the lease file path. */
function leaseFilePath(worklogDir: string): string {
  return path.join(worklogDir, LEASE_FILE);
}

/** Read the lock file contents. Returns null if missing or unreadable. */
function readLockFile(worklogDir: string): string | null {
  try {
    const fp = lockFilePath(worklogDir);
    return fs.readFileSync(fp, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/** Write the lock file with the current instance ID. Returns true on success.
 * Uses `O_CREAT | O_EXCL` for atomic exclusive file creation — if the
 * file already exists, the open fails and the caller knows another
 * instance holds the lock.
 */
function writeLockFile(worklogDir: string, instanceId: string): boolean {
  try {
    const fp = lockFilePath(worklogDir);
    // Ensure the coordination dir exists (a fresh worklog may not have it
    // yet — same provisioning as writeCoordinationFile's recursive mkdir).
    fs.mkdirSync(worklogDir, { recursive: true });
    // O_CREAT|O_EXCL: atomic exclusive creation — fails if file exists
    const fd = fs.openSync(fp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
    fs.writeSync(fd, instanceId);
    fs.closeSync(fd);
    return true;
  } catch {
    // File exists (another instance holds the lock) or I/O error
    return false;
  }
}

/** Delete the lock file. */
function deleteLockFile(worklogDir: string): void {
  try {
    fs.unlinkSync(lockFilePath(worklogDir));
  } catch {
    // Ignore — file may not exist or be locked
  }
}

/** Read the lease file. Returns null if missing or unreadable. */
function readLeaseFile(worklogDir: string): LeaderLease | null {
  try {
    const fp = leaseFilePath(worklogDir);
    const content = fs.readFileSync(fp, 'utf-8').trim();
    if (!content) return null;
    return JSON.parse(content) as LeaderLease;
  } catch {
    return null;
  }
}

/** Write the lease file. Returns true on success. */
function writeLeaseFile(worklogDir: string, lease: LeaderLease): boolean {
  try {
    const fp = leaseFilePath(worklogDir);
    const tmpPath = fp + '.tmp';
    fs.mkdirSync(worklogDir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(lease), 'utf-8');
    fs.renameSync(tmpPath, fp);
    return true;
  } catch {
    return false;
  }
}

/** Delete the lease file. */
function deleteLeaseFile(worklogDir: string): void {
  try {
    fs.unlinkSync(leaseFilePath(worklogDir));
  } catch {
    // Ignore — file may not exist
  }
}

/** Check if a lease is expired. */
export function isLeaseExpired(lease: LeaderLease, nowMs: number = Date.now()): boolean {
  const acquiredAt = new Date(lease.acquiredAt).getTime();
  const expiryMs = acquiredAt + lease.ttlSeconds * 1000;
  return nowMs >= expiryMs;
}

/** Check if a lease is still valid (not expired and close to expiry). */
export function isLeaseValid(lease: LeaderLease, nowMs: number = Date.now()): boolean {
  if (!lease) return false;
  const acquiredAt = new Date(lease.acquiredAt).getTime();
  const expiryMs = acquiredAt + lease.ttlSeconds * 1000;
  const remaining = expiryMs - nowMs;
  // Consider valid if more than MIN_VALID_LEASE_TTL_MS remains
  return remaining > MIN_VALID_LEASE_TTL_MS;
}

// ── Leader Election Manager ────────────────────────────────────────────

/**
 * Create a leader election manager.
 *
 * @param options - Configuration
 * @param options.worklogDir - Path to the worklog directory
 * @param options.instanceId - Optional unique instance ID (generated if not provided)
 * @param options.leaseTtlSeconds - Optional lease TTL in seconds (default: 300)
 * @param options.reelectionBackoffMs - Optional initial re-election backoff in ms (default: 1000)
 * @returns A LeaderElectionManager instance
 */
export function createLeaderElectionManager(options: {
  worklogDir: string;
  instanceId?: string;
  leaseTtlSeconds?: number;
  reelectionBackoffMs?: number;
}): LeaderElectionManager {
  const {
    worklogDir,
    instanceId = generateInstanceId(),
    leaseTtlSeconds = DEFAULT_LEASE_TTL_SECONDS,
    reelectionBackoffMs = DEFAULT_REELECTION_BACKOFF_MS,
  } = options;

  let closed = false;

  return {
    get worklogDir(): string {
      return worklogDir;
    },

    getInstanceId(): string {
      return instanceId;
    },

    isLeader(): boolean {
      if (closed) return false;
      // Check if we hold the lease and it is still valid
      const lease = readLeaseFile(worklogDir);
      if (!lease) return false;
      if (lease.leaderId !== instanceId) return false;
      return isLeaseValid(lease);
    },

    refreshLease(): void {
      if (closed) return;
      // Self-heal by OWNERSHIP, not validity: isLeader() requires
      // > MIN_VALID_LEASE_TTL_MS remaining, so an OWNED-but-EXPIRED lease
      // would make the old `if (!this.isLeader()) return` guard no-op
      // forever — the zombie can never renew. Renew whenever the lease
      // belongs to this instance, regardless of current validity (writes a
      // fresh acquiredAt with the same TTL). Missing/unreadable or FOREIGN
      // leases stay untouched: takeover of a foreign/expired lease is the
      // election path's job, never refresh (takeover-race safe).
      const lease = readLeaseFile(worklogDir);
      if (!lease || lease.leaderId !== instanceId) return;

      writeLeaseFile(worklogDir, {
        leaderId: instanceId,
        acquiredAt: new Date().toISOString(),
        ttlSeconds: leaseTtlSeconds,
      });
    },

    detectStaleLeader(): boolean {
      if (closed) return false;
      const lease = readLeaseFile(worklogDir);
      if (!lease) return false;
      // If the current leader is us, we are not stale
      if (lease.leaderId === instanceId) return false;
      // Check if the lease is expired
      return isLeaseExpired(lease);
    },

    hasLease(): boolean {
      if (closed) return false;
      return readLeaseFile(worklogDir) !== null;
    },

    attemptElection(): boolean {
      if (closed) return false;
      // Try to acquire the lock file (atomic write)
      if (!writeLockFile(worklogDir, instanceId)) return false;
      // Write our lease
      const lease: LeaderLease = {
        leaderId: instanceId,
        acquiredAt: new Date().toISOString(),
        ttlSeconds: leaseTtlSeconds,
      };
      if (!writeLeaseFile(worklogDir, lease)) {
        deleteLockFile(worklogDir);
        return false;
      }
      return true;
    },

    releaseLeadership(): void {
      if (closed) return;
      deleteLeaseFile(worklogDir);
      deleteLockFile(worklogDir);
    },

    close(): void {
      closed = true;
    },
  };
}

// ── Election helpers ───────────────────────────────────────────────────

/**
 * Run a leader election with retry. Non-leader instances detect if the
 * lock is held by another instance and retry with exponential backoff.
 *
 * @param options - Election options
 * @param options.worklogDir - Worklog directory
 * @param options.instanceId - Instance ID
 * @param options.maxAttempts - Maximum election attempts before giving up
 * @param options.backoffMs - Initial backoff in ms
 * @param options.leaseTtlSeconds - Lease TTL in seconds
 * @param options.onStaleDetect - Callback when a stale leader is detected (triggers re-election)
 * @returns ElectionResult indicating leadership status
 */
export async function runElectionWithRetry(options: {
  worklogDir: string;
  instanceId?: string;
  maxAttempts?: number;
  backoffMs?: number;
  leaseTtlSeconds?: number;
  onStaleDetect?: () => void;
}): Promise<ElectionResult> {
  const {
    maxAttempts = 5,
    backoffMs = DEFAULT_REELECTION_BACKOFF_MS,
  } = options;

  let currentBackoff = backoffMs;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const manager = createLeaderElectionManager({
      worklogDir: options.worklogDir,
      instanceId: options.instanceId,
      leaseTtlSeconds: options.leaseTtlSeconds,
    });

    // Check if we are already the leader (e.g., from a previous election)
    if (manager.isLeader()) {
      return { isLeader: true, leaderId: options.instanceId };
    }

    // Check if the current leader is stale — if so, clean up stale files
    // so we can win the election on the next attempt.
    if (manager.detectStaleLeader()) {
      options.onStaleDetect?.();
      // Clean up the stale lock + lease so we can acquire them
      cleanupStaleElection({ worklogDir: options.worklogDir });
    }

    // Attempt election
    if (manager.attemptElection()) {
      return { isLeader: true, leaderId: options.instanceId };
    }

    // Check if we hold the lock but our lease was overwritten
    const lockHolder = readLockFile(options.worklogDir);
    if (lockHolder === options.instanceId) {
      return { isLeader: true, leaderId: options.instanceId };
    }

    // Lock is held by another instance — wait and retry
    if (attempt < maxAttempts - 1) {
      await sleep(currentBackoff);
      currentBackoff = Math.min(currentBackoff * 2, MAX_REELECTION_BACKOFF_MS);
    }
  }

  // Could not become leader
  return { isLeader: false, leaderId: readLockFile(options.worklogDir) || undefined };
}

/** Check if a stale leader exists without attempting election. */
export function checkForStaleLeader(options: {
  worklogDir: string;
}): boolean {
  const lease = readLeaseFile(options.worklogDir);
  if (!lease) return false;
  return isLeaseExpired(lease);
}

/** Clean up stale election files (orphaned lock + expired lease). */
export function cleanupStaleElection(options: {
  worklogDir: string;
}): void {
  const lockContent = readLockFile(options.worklogDir);
  if (lockContent) {
    const lease = readLeaseFile(options.worklogDir);
    if (!lease || isLeaseExpired(lease)) {
      deleteLockFile(options.worklogDir);
      deleteLeaseFile(options.worklogDir);
    }
  }
}

// ── Utilities ──────────────────────────────────────────────────────────

/** Sleep for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
