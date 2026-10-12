/**
 * packages/shared/src/model-cooldown.ts — versioned, machine-wide model-cooldown
 * contract (WL-0MV563825002R9Y1; parent WL-0MV54ZP3Y00514Y9).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS HEADER COMMENT IS THE CONTRACT OF RECORD.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * When a pane's in-pane recovery loop classifies a provider-exhaustion error
 * (`SERVER_ERROR`: "all providers exhausted" / "all providers unavailable" /
 * "no provider is available during the current scheduled time window") and
 * starts a backoff, it records that fact here so the machine-wide herdr
 * dispatcher and mode-switch worker can see that the pane is *blocked on a
 * throttled provider* rather than idle. The signal must be machine-wide (not
 * per-worklog) because the cheap-switch decision is machine-wide, so it lives
 * in the coordination directory alongside `mode-activity.json`.
 *
 * ## On-disk format (versioned; readers ignore unknown fields)
 *
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "cooldowns": [
 *     {
 *       "paneId": "<herdr pane id or null>",
 *       "sessionId": "<pi session id or null>",
 *       "itemId": "WL-... or null",
 *       "kind": "plan|intake|implement|audit|risk-effort or null",
 *       "reason": "all providers exhausted",
 *       "createdAt": 1700000000000,
 *       "cooldownUntil": 1700000300000
 *     }
 *   ]
 * }
 * ```
 *
 * Field semantics:
 *  - `paneId` / `sessionId` are the entry key. At least one should be present;
 *    `paneId` is written when `HERDR_PANE_ID` is available, otherwise the key
 *    degrades to `sessionId` alone.
 *  - `itemId` / `kind` are best-effort (may be `null`); the herdr dispatcher
 *    resolves them from the pane label when absent.
 *  - `reason` is a human-readable description of why the cooldown was taken.
 *  - `createdAt` is when the entry was written (epoch ms).
 *  - `cooldownUntil` is the epoch-ms instant the cooldown expires; an entry is
 *    **active** while `cooldownUntil > now` and is ignored otherwise.
 *
 * ## Reader contract (tolerant, fail-closed)
 *
 * {@link readModelCooldowns} is the ONLY supported read path. It:
 *  - returns only active entries (`cooldownUntil > now`);
 *  - ignores unknown fields and skips malformed entries without throwing;
 *  - returns `[]` when the file is **missing** (nothing was ever recorded);
 *  - returns `null` when the file is **unreadable or corrupt**, or when the
 *    coordination directory cannot be resolved. `null` is the fail-closed
 *    signal: a consumer MUST treat it as "a cooldown may be active" and take
 *    the conservative branch (for the mode-switch gate: do not switch to
 *    cheap). `[]` and `null` are deliberately distinguishable so "no cooldown"
 *    and "cannot read the cooldown signal" never collapse.
 *
 * ## Writer contract (atomic, keyed, pruning)
 *
 * {@link writeModelCooldown} upserts by the `paneId`/`sessionId` key (a write
 * replaces any existing entry sharing either key), prunes expired entries, and
 * writes atomically (temp file + rename). It is best-effort: any I/O failure
 * returns `false` and never throws.
 *
 * {@link clearModelCooldown} removes the entry matching `key` (by `paneId` or
 * `sessionId`); a missing file is a no-op.
 *
 * The module mirrors the existing `@worklog/shared/lease-release` cross-package
 * pattern; herdr's `getMachineCoordinationDir()` delegates to
 * {@link resolveMachineCoordinationDir} so there is a single resolver.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Constants ──────────────────────────────────────────────────────────

/** On-disk schema version for the cooldown document. */
export const MODEL_COOLDOWN_SCHEMA_VERSION = 1;

/** File name of the cooldown document inside the coordination directory. */
export const MODEL_COOLDOWN_FILE = 'model-cooldowns.json';

/** Machine-wide coordination dir default: `~/.herdr/downtime`. */
export const DEFAULT_MACHINE_COORDINATION_DIR = '.herdr/downtime';

// ── Types ──────────────────────────────────────────────────────────────

/** Dispatch kind tokens the recovery loop can derive from session entries. */
export type ModelCooldownKind = 'plan' | 'intake' | 'implement' | 'audit' | 'risk-effort';

/** A normalized cooldown entry as stored on disk and returned by readers. */
export interface ModelCooldownEntry {
  /** herdr pane id (the primary key when present), or `null`. */
  paneId: string | null;
  /** pi session id (the fallback key when no pane id), or `null`. */
  sessionId: string | null;
  /** Best-effort work-item id, or `null`. */
  itemId: string | null;
  /** Best-effort dispatch kind, or `null`. */
  kind: ModelCooldownKind | null;
  /** Human-readable reason the cooldown was taken. */
  reason: string;
  /** Epoch-ms creation time. */
  createdAt: number;
  /** Epoch-ms instant the cooldown expires. */
  cooldownUntil: number;
}

/** Input accepted by {@link writeModelCooldown}; optional fields default. */
export interface ModelCooldownInput {
  paneId?: string | null;
  sessionId?: string | null;
  itemId?: string | null;
  kind?: ModelCooldownKind | null;
  reason?: string;
  createdAt?: number;
  /** Required: the epoch-ms expiry instant. */
  cooldownUntil: number;
}

const COOLDOWN_KINDS: ReadonlySet<string> = new Set([
  'plan',
  'intake',
  'implement',
  'audit',
  'risk-effort',
]);

// ── Coordination dir resolver ──────────────────────────────────────────

/**
 * Resolve the machine-wide coordination directory.
 *
 * Resolution order:
 *  1. `HERDR_COORDINATION_DIR` env var (if set and non-empty). A leading `~`
 *     is expanded to the user's home directory.
 *  2. Default: `~/.herdr/downtime`.
 *
 * Returns `null` when neither resolves (e.g. `homedir()` is unavailable), which
 * callers must treat as "no dispatch / fail closed".
 */
export function resolveMachineCoordinationDir(): string | null {
  const envDir = process.env.HERDR_COORDINATION_DIR;
  if (envDir && envDir.length > 0) {
    if (envDir.startsWith('~')) {
      const home = os.homedir();
      if (home) {
        return path.join(home, envDir.slice(1));
      }
      // homedir() failed — env var is unusable, fall through to the default.
    } else {
      return envDir;
    }
  }

  try {
    const home = os.homedir();
    if (!home) return null;
    return path.join(home, DEFAULT_MACHINE_COORDINATION_DIR);
  } catch {
    // homedir() threw — fail-safe.
  }
  return null;
}

// ── Reader ─────────────────────────────────────────────────────────────

/**
 * Validate and normalize one raw entry from disk.
 *
 * `cooldownUntil` is the only required field: an entry without a finite
 * numeric expiry is malformed and skipped. All other fields are normalized to
 * `null`/`''`/`0` when absent or of the wrong type, so unknown or future
 * fields never break the reader.
 */
function normalizeReadEntry(raw: unknown): ModelCooldownEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const cooldownUntil = o.cooldownUntil;
  if (typeof cooldownUntil !== 'number' || !Number.isFinite(cooldownUntil)) return null;

  return {
    paneId: typeof o.paneId === 'string' ? o.paneId : null,
    sessionId: typeof o.sessionId === 'string' ? o.sessionId : null,
    itemId: typeof o.itemId === 'string' ? o.itemId : null,
    kind: typeof o.kind === 'string' && COOLDOWN_KINDS.has(o.kind) ? (o.kind as ModelCooldownKind) : null,
    reason: typeof o.reason === 'string' ? o.reason : '',
    createdAt: typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : 0,
    cooldownUntil,
  };
}

/**
 * Read the active model-cooldown entries for the given coordination directory.
 *
 * - Returns only entries whose `cooldownUntil` is strictly in the future.
 * - Unknown fields are ignored and malformed entries are skipped; the reader
 *   never throws.
 * - Returns `[]` when the file (or directory) is missing — nothing recorded.
 * - Returns `null` when the coordination directory is unresolvable, or the
 *   file is unreadable/corrupt. `null` is the **fail-closed** signal: the
 *   caller must treat it as "a cooldown may be active" and take the
 *   conservative branch.
 *
 * @param dir The coordination directory, or `null` when unresolvable.
 * @param now Epoch-ms "now" (defaults to `Date.now()`); entries at or before
 *   `now` are inactive.
 */
export function readModelCooldowns(
  dir: string | null,
  now: number = Date.now(),
): ModelCooldownEntry[] | null {
  if (dir === null) return null;

  const filePath = path.join(dir, MODEL_COOLDOWN_FILE);
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    // Missing file/directory → nothing recorded (not a failure).
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return [];
    // Permission/IO error → fail closed.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null; // corrupt JSON → fail closed
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const cooldowns = (parsed as Record<string, unknown>).cooldowns;
  // A structurally invalid document is corrupt → fail closed (not "empty").
  if (!Array.isArray(cooldowns)) return null;

  const active: ModelCooldownEntry[] = [];
  for (const raw of cooldowns) {
    const entry = normalizeReadEntry(raw);
    if (entry === null) continue; // malformed entry → skip
    if (entry.cooldownUntil > now) active.push(entry);
  }
  return active;
}

// ── Writer ─────────────────────────────────────────────────────────────

/** Normalize a writer input into a stored entry. */
function normalizeWriteEntry(entry: ModelCooldownInput, now: number): ModelCooldownEntry {
  return {
    paneId: typeof entry.paneId === 'string' ? entry.paneId : null,
    sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : null,
    itemId: typeof entry.itemId === 'string' ? entry.itemId : null,
    kind:
      typeof entry.kind === 'string' && COOLDOWN_KINDS.has(entry.kind)
        ? (entry.kind as ModelCooldownKind)
        : null,
    reason: typeof entry.reason === 'string' ? entry.reason : '',
    createdAt:
      typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
        ? entry.createdAt
        : now,
    cooldownUntil: entry.cooldownUntil,
  };
}

/** Whether two entries share the pane/session key. */
function sharesKey(a: ModelCooldownEntry, b: ModelCooldownEntry): boolean {
  if (b.paneId !== null && a.paneId === b.paneId) return true;
  if (b.sessionId !== null && a.sessionId === b.sessionId) return true;
  return false;
}

/** Atomically persist the cooldown document. Returns false on any I/O error. */
function writeCooldownDocument(dir: string, entries: ModelCooldownEntry[]): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, MODEL_COOLDOWN_FILE);
    const payload = JSON.stringify({
      schemaVersion: MODEL_COOLDOWN_SCHEMA_VERSION,
      cooldowns: entries,
    });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    fs.writeFileSync(tmp, payload, 'utf8');
    try {
      fs.renameSync(tmp, filePath);
    } catch {
      // rename-over-existing is not portable (Windows); fall back to a
      // direct small synchronous write.
      fs.writeFileSync(filePath, payload, 'utf8');
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best-effort temp cleanup */
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Upsert a model-cooldown entry (atomic, keyed by `paneId`/`sessionId`).
 *
 * Replaces any existing entry sharing either key, prunes entries that have
 * already expired, and writes the document atomically (temp file + rename).
 * Best-effort: returns `true` on success and `false` on any failure (including
 * an unresolvable directory or an invalid `cooldownUntil`); never throws.
 *
 * @param dir The coordination directory, or `null` when unresolvable.
 * @param entry The cooldown to record.
 * @param now Epoch-ms "now" used to prune expired entries (defaults to
 *   `Date.now()`).
 */
export function writeModelCooldown(
  dir: string | null,
  entry: ModelCooldownInput,
  now: number = Date.now(),
): boolean {
  if (dir === null) return false;
  if (
    entry === null ||
    typeof entry !== 'object' ||
    typeof entry.cooldownUntil !== 'number' ||
    !Number.isFinite(entry.cooldownUntil)
  ) {
    return false;
  }

  const incoming = normalizeWriteEntry(entry, now);
  // readModelCooldowns filters expired entries (pruning) and returns null for
  // a corrupt document; start fresh in that case (repairs the signal).
  const existing = readModelCooldowns(dir, now) ?? [];
  const remaining = existing.filter((e) => !sharesKey(e, incoming));
  return writeCooldownDocument(dir, [...remaining, incoming]);
}

// ── Clearer ────────────────────────────────────────────────────────────

/**
 * Remove the cooldown entry identified by `key`.
 *
 * Matches an entry when `key` equals its `paneId` or its `sessionId`. A missing
 * file is a no-op; an unreadable/corrupt file is a no-op (fail-safe). Returns
 * `true` when the file was rewritten without the matching entry, `false`
 * otherwise. Never throws.
 *
 * @param dir The coordination directory, or `null` when unresolvable.
 * @param key The `paneId` or `sessionId` of the entry to remove.
 * @param now Epoch-ms "now" (defaults to `Date.now()`); expired entries are
 *   pruned as part of the rewrite.
 */
export function clearModelCooldown(
  dir: string | null,
  key: string,
  now: number = Date.now(),
): boolean {
  if (dir === null) return false;

  const entries = readModelCooldowns(dir, now);
  if (entries === null) return false; // unreadable/corrupt → no-op
  const remaining = entries.filter((e) => e.paneId !== key && e.sessionId !== key);
  if (remaining.length === entries.length) return false; // nothing matched

  return writeCooldownDocument(dir, remaining);
}
