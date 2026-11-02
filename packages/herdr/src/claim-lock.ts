/**
 * packages/herdr/src/claim-lock.ts — local, side-effect-free claim-holder
 * heldness probe (WL-0MVWDAZL10025P8J).
 *
 * The hydrator's "busy = pane OR live claim holder" cycle (sibling child)
 * needs one cheap, local way to answer: *is this work item's
 * `<worklog>/locks/child-<id>.lock` currently held by a live claim holder?*
 * A pane-less driven session still holds its claim through the per-child
 * `flock` written by the shared `work_item_lock.py`, so a live lock must
 * suppress demotion instead of releasing a claim while it is still editing.
 *
 * Pure local probing only — no `wl`, no `herdr`, no network, no `fetch`. Every
 * seam (`fs` reader, lock prober, pid liveness, process-start probe, clock) is
 * injectable so orchestration stays unit-testable with no real filesystem, in
 * the same style as `HydratorDeps`.
 *
 * ── Lock contract (mirrors ~/.pi/agent/skills/shared/work_item_lock.py) ──
 *
 * Each work item gets one regular file at `<worklog>/locks/child-<id>.lock`
 * whose advisory `flock` is held for the lifetime of the holder's critical
 * section. The kernel drops the `flock` on exit, on `SIGKILL` and on crash, so
 * the **kernel** is authoritative while held. The lock file itself persists
 * after release and records the holder metadata
 * `{agent, pid, session_id, started_at, token}` — so file existence and
 * `started_at` age are NEVER liveness evidence. On 2026-10-31 the llm store
 * held 40 `child-*.lock` files whose recorded pids were all dead; an
 * existence check would suppress demotion forever and re-create
 * WL-0MSOJLZD9004P8PI's stuck-claim defect.
 *
 * `IMPLEMENT_CHILD_LOCK_TOKEN` re-entrancy means a holder chain (driver →
 * `parent`/`start` subprocess → driven child) may present one token against
 * one file; the probe ignores the token for heldness (it is metadata only).
 *
 * ── Mechanism decision (spiked and measured on the dev host, 2026-10-31) ──
 *
 * Two candidates were verified working:
 *
 *  1. `flock(1)` spawn — `sh -c 'flock -n -E 75 9 9<"$1"' sh <path>`:
 *     rc 0 = free, rc 75 = held, rc 2 = cannot open (missing). The
 *     fd-redirect form is REQUIRED: plain `flock -n <path> true` *creates* a
 *     missing file (util-linux 2.41.3 has no `--no-create`), which would
 *     violate the no-side-effects contract. Potable to every POSIX host.
 *  2. One `/proc/locks` snapshot per batch + one `stat` per candidate to map
 *     `dev:inode` (Linux-only; `/proc/locks` prints `major:minor` in hex and
 *     the inode in decimal).
 *
 * Measured per-candidate cost (50 candidates, warm host):
 *   - flock spawn: ~7.6 ms/candidate (~381 ms for the batch, one spawn each)
 *   - /proc/locks: ~0.2 ms/candidate (~10 ms for the batch, zero spawns)
 *
 * **Chosen: hybrid.** On Linux the probe takes ONE `/proc/locks` snapshot per
 * batch and maps each candidate with a single `stat` (zero spawns, ~38× faster
 * than spawning `flock`). When `/proc/locks` is unavailable — non-Linux, or a
 * mount namespace that hides it — it falls back to the portable fd-redirect
 * `flock` spawn, which costs ~7.6 ms/candidate and still sits far inside the
 * 5 s per-step budget (`HYDRATOR_STEP_TIMEOUT_MS`); 50 candidates worst-case
 * is ~0.4 s. Neither path ever creates, truncates or rewrites a lock file, and
 * neither ever waits for the lock (`-n` / non-blocking snapshot).
 *
 * ── Fail-open ──
 *
 * Any ambiguous state is reported `held` with a named reason — an
 * unenumerable `locks/` directory (`locks-dir-unreadable`), corrupt metadata
 * (`corrupt-lock-file`), an unexpected `fs`/`flock` error or an undecidable
 * probe (`probe-error`), and a suspected pid reuse (`pid-reuse-suspected`).
 * A release is only ever reported when the kernel lock is free AND the
 * recorded pid is provably dead (`stale`), or when there is simply no lock
 * file (`no-lock-file`).
 */

import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Named reason for a verdict. The `held` reasons fail open; only
 * `no-lock-file` and `stale` permit a demotion.
 */
export type ClaimHolderReason =
  | 'flock-held' // the kernel flock is currently held by a live holder
  | 'pid-alive' // flock free, recorded pid alive and start time consistent
  | 'pid-reuse-suspected' // lock older than the process now owning its pid
  | 'no-lock-file' // no child-<id>.lock present
  | 'stale' // lock exists, flock free, recorded pid provably dead
  | 'locks-dir-unreadable' // <worklog>/locks/ could not be enumerated
  | 'corrupt-lock-file' // metadata is empty/not a JSON object
  | 'probe-error'; // unexpected fs/flock error or undecidable probe

/** Outcome of probing one work item's claim lock. */
export interface ClaimHolderVerdict {
  /** True when a live claim holder is present (or ambiguity forces fail-open). */
  held: boolean;
  /** Named reason for the verdict. */
  reason: ClaimHolderReason;
  /** Recorded holder pid, when the metadata was readable. */
  pid?: number;
  /** Recorded holder session id, when readable. */
  sessionId?: string;
  /** Recorded holder agent name, when readable. */
  agent?: string;
  /** Recorded holder start timestamp (ISO-8601), when readable. */
  startedAt?: string;
}

/**
 * Injectable seams. Every method may throw; the probe treats a throw as an
 * ambiguous/unavailable lookup and fails open (`held`).
 */
export interface ClaimLockDeps {
  /**
   * Read the entry names of `<worklog>/locks/` — called exactly ONCE per
   * batch (the batch-cost contract). Resolves `null` when the directory
   * cannot be read, which fails the whole batch open.
   */
  readLockDir: (locksDir: string) => Promise<string[] | null>;
  /**
   * Read a lock file's raw text. Resolves `null` when the file does not
   * exist; throws for any other `fs` error (unreadable → fail open).
   */
  readLockFile: (path: string) => Promise<string | null>;
  /**
   * Whether *path* is currently `flock`ed by a live holder: `true` = held,
   * `false` = free, `null` = undecidable (fail open).
   */
  isFlockHeld: (path: string) => Promise<boolean | null>;
  /** Whether *pid* names a live process (fail closed: ambiguous → true). */
  isPidAlive: (pid: number) => boolean;
  /**
   * Wall-clock start time of *pid* in ms since the epoch, or `undefined` when
   * unknown (then the pid fallback cannot prove reuse → fail open).
   */
  getProcessStartMs: (pid: number) => number | undefined;
  /** Injectable clock (ms since the epoch) for the pid-reuse sanity bound. */
  now: () => number;
  /**
   * Optional diagnostic counter for external process spawns. The production
   * flock fallback reports `'flock'`; tests use it to assert the probe never
   * spawns `wl`/`herdr` per item.
   */
  recordSpawn?: (kind: 'flock' | 'wl' | 'herdr') => void;
}

/** Options for {@link probeClaimHolders}. */
export interface ClaimLockProbeOptions {
  /**
   * The worklog **store** root (the `.worklog` directory). Callers wire this
   * from `getWorklogDir()` (`packages/herdr/src/fetcher.ts`); when omitted it
   * falls back to `$WORKLOG_DIR` and then `<cwd>/.worklog`.
   */
  worklogDir?: string;
  /** Override the injectable seams (tests). Merged over the defaults. */
  deps?: Partial<ClaimLockDeps>;
  /** Override the probed platform (tests exercise the non-Linux fallback). */
  platform?: NodeJS.Platform;
}

// ── Constants ─────────────────────────────────────────────────────────

/** Directory (inside the worklog store) that holds per-item lock files. */
const LOCK_DIR_NAME = 'locks';
/** Filename prefix for a per-work-item lock file. */
const LOCK_FILE_PREFIX = 'child-';
/** Filename suffix for a per-work-item lock file. */
const LOCK_FILE_SUFFIX = '.lock';

/**
 * Clock skew tolerated before a lock's `started_at` is treated as an
 * implausible future timestamp (which fails open as `pid-reuse-suspected`).
 */
const STARTED_AT_FUTURE_SKEW_MS = 60_000;

/** `flock` conflict exit code for the fd-redirect fallback (`-E 75`). */
const FLOCK_CONFLICT_EXIT = 75;

/** Parsed lock-file metadata (never validated beyond what heldness needs). */
interface LockMetadata {
  pid?: number;
  agent?: string;
  sessionId?: string;
  startedAt?: string;
  token?: string;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Batch-probe claim heldness for *itemIds*.
 *
 * Performs ONE (`locks/` directory) read for the whole batch, then a
 * per-candidate heldness probe. Returns a verdict for every distinct id.
 * Never throws: every ambiguity is reported `held` (fail open).
 */
export async function probeClaimHolders(
  itemIds: readonly string[],
  opts: ClaimLockProbeOptions = {},
): Promise<Map<string, ClaimHolderVerdict>> {
  const worklogDir = opts.worklogDir ?? defaultWorklogDir();
  const locksDir = join(worklogDir, LOCK_DIR_NAME);
  const deps = resolveDeps(opts);

  const result = new Map<string, ClaimHolderVerdict>();

  let entries: string[] | null;
  try {
    entries = await deps.readLockDir(locksDir);
  } catch {
    entries = null;
  }

  if (entries === null) {
    // Fail open: without a directory listing we cannot prove any item stale.
    for (const id of itemIds) {
      result.set(id, heldVerdict('locks-dir-unreadable'));
    }
    return result;
  }

  const present = new Set(entries);
  for (const id of itemIds) {
    if (result.has(id)) continue; // de-duplicate without re-probing
    result.set(id, await probeOne(id, present, locksDir, deps));
  }
  return result;
}

/**
 * Create a batched `flock` prober.
 *
 * On Linux it reads ONE `/proc/locks` snapshot on first use and maps each
 * candidate `stat` (`dev:inode`) into that snapshot; when `/proc/locks` is
 * unavailable (or the platform is not Linux) it falls back to a portable
 * fd-redirect `flock -n` spawn per file. Both forms are strictly read-only
 * with respect to the lock file.
 */
export function createFlockProber(
  opts: { platform?: NodeJS.Platform; recordSpawn?: ClaimLockDeps['recordSpawn'] } = {},
): (path: string) => Promise<boolean | null> {
  const platform = opts.platform ?? process.platform;
  // Undefined = not read yet; null = /proc/locks unavailable.
  let procLocks: Set<string> | null | undefined;

  return async (path: string): Promise<boolean | null> => {
    if (platform === 'linux') {
      if (procLocks === undefined) procLocks = readProcLocks();
      if (procLocks !== null) {
        const stat = statLockFile(path);
        if (stat === null) return false; // vanished between listing and probe
        return procLocks.has(procLockKey(stat));
      }
    }
    return spawnFlockProbe(path, opts.recordSpawn);
  };
}

// ── Per-candidate probing ─────────────────────────────────────────────

async function probeOne(
  id: string,
  present: ReadonlySet<string>,
  locksDir: string,
  deps: ClaimLockDeps,
): Promise<ClaimHolderVerdict> {
  if (!isSafeItemId(id)) {
    // A path-traversal-shaped id can never name a lock file we would probe.
    return notHeldVerdict('no-lock-file');
  }

  const fileName = `${LOCK_FILE_PREFIX}${id}${LOCK_FILE_SUFFIX}`;
  if (!present.has(fileName)) {
    return notHeldVerdict('no-lock-file');
  }
  const path = join(locksDir, fileName);

  // 1. Metadata (diagnostics + the pid fallback).
  let raw: string | null;
  try {
    raw = await deps.readLockFile(path);
  } catch {
    return heldVerdict('probe-error');
  }
  if (raw === null) {
    // Vanished between the single directory read and the file read — benign.
    return notHeldVerdict('no-lock-file');
  }

  const parsed = parseLockMetadata(raw);
  if (parsed === 'corrupt') {
    return heldVerdict('corrupt-lock-file');
  }

  // 2. Kernel truth: is the flock currently held?
  let flockHeld: boolean | null;
  try {
    flockHeld = await deps.isFlockHeld(path);
  } catch {
    return heldVerdict('probe-error');
  }
  if (flockHeld === null) {
    return heldVerdict('probe-error');
  }
  if (flockHeld) {
    return heldFromMetadata('flock-held', parsed);
  }

  // 3. Flock is free: fall back to the recorded pid, guarded against reuse.
  const pid = parsed?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    // No usable pid → cannot prove the holder stale → fail open.
    return heldFromMetadata('probe-error', parsed);
  }
  if (!deps.isPidAlive(pid)) {
    return notHeldFromMetadata('stale', parsed);
  }

  // The pid is alive. Trust it ONLY when the lock was taken no earlier than
  // the process now owning that pid started — otherwise the pid was recycled
  // and the "live" process is an unrelated newcomer.
  const startedAtMs = parseStartedAt(parsed?.startedAt);
  const processStartMs = deps.getProcessStartMs(pid);
  const nowMs = deps.now();

  if (startedAtMs !== undefined && startedAtMs > nowMs + STARTED_AT_FUTURE_SKEW_MS) {
    // Implausible future timestamp — fail open rather than release.
    return heldFromMetadata('pid-reuse-suspected', parsed);
  }
  if (
    startedAtMs !== undefined &&
    processStartMs !== undefined &&
    startedAtMs < processStartMs
  ) {
    return heldFromMetadata('pid-reuse-suspected', parsed);
  }
  return heldFromMetadata('pid-alive', parsed);
}

// ── Metadata parsing ──────────────────────────────────────────────────

/**
 * Parse lock metadata defensively. `null` = no metadata was recorded (an
 * empty file is treated as corrupt, since an acquire writes metadata under
 * the same flock); `'corrupt'` = unparseable / not a JSON object.
 */
function parseLockMetadata(raw: string): LockMetadata | 'corrupt' | null {
  const text = raw.trim();
  if (text.length === 0) return 'corrupt';

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return 'corrupt';
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return 'corrupt';
  }

  const obj = data as Record<string, unknown>;
  return {
    pid: typeof obj.pid === 'number' ? obj.pid : undefined,
    agent: typeof obj.agent === 'string' ? obj.agent : undefined,
    sessionId: typeof obj.session_id === 'string' ? obj.session_id : undefined,
    startedAt: typeof obj.started_at === 'string' ? obj.started_at : undefined,
    token: typeof obj.token === 'string' ? obj.token : undefined,
  };
}

/** Parse an ISO-8601 timestamp to ms since the epoch, or undefined. */
function parseStartedAt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Reject ids that could escape the `locks/` directory. */
function isSafeItemId(id: string): boolean {
  if (id.length === 0 || id.length > 256) return false;
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return false;
  return true;
}

// ── Verdict builders ──────────────────────────────────────────────────

function heldVerdict(reason: ClaimHolderReason): ClaimHolderVerdict {
  return { held: true, reason };
}

function notHeldVerdict(reason: ClaimHolderReason): ClaimHolderVerdict {
  return { held: false, reason };
}

function heldFromMetadata(
  reason: ClaimHolderReason,
  meta: LockMetadata | null,
): ClaimHolderVerdict {
  return { held: true, reason, ...metadataFields(meta) };
}

function notHeldFromMetadata(
  reason: ClaimHolderReason,
  meta: LockMetadata | null,
): ClaimHolderVerdict {
  return { held: false, reason, ...metadataFields(meta) };
}

function metadataFields(meta: LockMetadata | null): Partial<ClaimHolderVerdict> {
  if (meta === null) return {};
  const fields: Partial<ClaimHolderVerdict> = {};
  if (meta.pid !== undefined) fields.pid = meta.pid;
  if (meta.sessionId !== undefined) fields.sessionId = meta.sessionId;
  if (meta.agent !== undefined) fields.agent = meta.agent;
  if (meta.startedAt !== undefined) fields.startedAt = meta.startedAt;
  return fields;
}

// ── Default deps (production) ─────────────────────────────────────────

function defaultWorklogDir(): string {
  const fromEnv = process.env.WORKLOG_DIR;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(process.cwd(), '.worklog');
}

function resolveDeps(opts: ClaimLockProbeOptions): ClaimLockDeps {
  const platform = opts.platform ?? process.platform;
  const defaults: ClaimLockDeps = {
    readLockDir: async (dir) => {
      try {
        return await readdir(dir);
      } catch {
        return null;
      }
    },
    readLockFile: async (path) => {
      try {
        return await readFile(path, 'utf8');
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    isFlockHeld: createFlockProber({ platform, recordSpawn: opts.deps?.recordSpawn }),
    isPidAlive: defaultIsPidAlive,
    getProcessStartMs: defaultProcessStartMs,
    now: () => Date.now(),
    recordSpawn: opts.deps?.recordSpawn,
  };
  return { ...defaults, ...(opts.deps ?? {}) };
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Whether *pid* names a live process. `ESRCH` = dead; `EPERM` = alive but not
 * ours; any other `OSError` is ambiguous and treated as alive (fail closed —
 * never release a holder we cannot prove dead).
 */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

/**
 * Wall-clock start time (ms since the epoch) of *pid*, or `undefined` when
 * unknown. Linux reads `/proc/<pid>/stat` field 22 (`starttime`, clock ticks
 * since boot) and converts through `/proc/uptime`; other platforms return
 * `undefined`, which fails the pid-reuse guard open (held).
 */
function defaultProcessStartMs(pid: number): number | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // `comm` (field 2) may contain spaces and parentheses; slice after the
    // LAST ')' so the remaining fields start at field 3 (state).
    const closeParen = stat.lastIndexOf(')');
    if (closeParen < 0) return undefined;
    const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
    // fields[0] = state (field 3); starttime (field 22) → index 19.
    const startTicks = Number(fields[19]);
    if (!Number.isFinite(startTicks)) return undefined;

    const uptimeSeconds = Number.parseFloat(
      readFileSync('/proc/uptime', 'utf8').split(' ')[0] ?? '',
    );
    if (!Number.isFinite(uptimeSeconds)) return undefined;

    // USER_HZ is 100 on Linux (sysconf(_SC_CLK_TCK)).
    const USER_HZ = 100;
    const bootMs = Date.now() - uptimeSeconds * 1000;
    return bootMs + (startTicks / USER_HZ) * 1000;
  } catch {
    return undefined;
  }
}

// ── /proc/locks fast path (Linux) ─────────────────────────────────────

interface LockFileStat {
  /** gnu_dev_major(dev), hex-formatted by {@link procLockKey}. */
  major: bigint;
  /** gnu_dev_minor(dev), hex-formatted by {@link procLockKey}. */
  minor: bigint;
  /** Inode number, decimal-formatted by {@link procLockKey}. */
  ino: bigint;
}

function statLockFile(path: string): LockFileStat | null {
  try {
    const st = statSync(path, { bigint: true });
    const dev = st.dev;
    const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
    const minor = (dev & 0xffn) | ((dev >> 12n) & 0xfff00n);
    return { major, minor, ino: st.ino };
  } catch {
    return null;
  }
}

/**
 * Map a `stat` result onto the `/proc/locks` identifier format: `major:minor`
 * are printed as two-digit hex and the inode as a decimal unsigned long.
 */
function procLockKey(stat: LockFileStat): string {
  const major = stat.major.toString(16).padStart(2, '0');
  const minor = stat.minor.toString(16).padStart(2, '0');
  return `${major}:${minor}:${stat.ino.toString(10)}`;
}

/**
 * Read ONE `/proc/locks` snapshot into a set of `major:minor:inode` keys, or
 * `null` when the file is unavailable (fall back to the portable spawn).
 *
 * A line looks like `6: FLOCK  ADVISORY  WRITE 2976141 00:2f:2632970 0 EOF`;
 * token 5 is the `dev:inode` identifier and token 1 the lock type. Only
 * `FLOCK` entries matter (the per-item lock is an `fcntl.flock`).
 */
function readProcLocks(): Set<string> | null {
  let raw: string;
  try {
    raw = readFileSync('/proc/locks', 'utf8');
  } catch {
    return null;
  }

  const keys = new Set<string>();
  for (const line of raw.split('\n')) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 6) continue;
    if (tokens[1] !== 'FLOCK') continue;
    keys.add(tokens[5]);
  }
  return keys;
}

// ── Portable flock fallback ───────────────────────────────────────────

/**
 * Portable heldness probe via a `flock -n` spawn. The fd-redirect form
 * (`9<"$1"`) is mandatory: it never creates or truncates the lock file, and
 * `-n` never waits. Resolves `true` (held), `false` (free) or `null`
 * (undecidable → fail open).
 */
function spawnFlockProbe(
  path: string,
  recordSpawn: ClaimLockDeps['recordSpawn'],
): Promise<boolean | null> {
  recordSpawn?.('flock');
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', 'flock -n -E 75 9 9<"$1"', 'sh', path], {
      stdio: 'ignore',
    });
    child.on('error', () => resolve(null));
    child.on('exit', (code) => {
      if (code === 0) resolve(false);
      else if (code === FLOCK_CONFLICT_EXIT) resolve(true);
      else resolve(null);
    });
  });
}
