/**
 * packages/herdr/src/host-dispatch-budget.ts — machine-scoped dispatch budget
 * ledger and configuration (WL-0MVXY0WQF0069YDJ, parent WL-0MVXWQFGV000D2AB).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS HEADER COMMENT IS THE CONTRACT OF RECORD.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * One machine-scoped record of every in-flight `implement` and `audit`
 * dispatch, plus a configurable per-tier cap, so a host budget is
 * authoritative across every herdr instance and project on the machine.
 * This module is the vertical slice only: F2–F5 wire enforcement (dispatcher
 * admission, interactive dialog, observability). Until they do, nothing here
 * changes dispatch behaviour.
 *
 * ## Files (machine coordination dir — `~/.herdr/downtime` or
 * ## `HERDR_COORDINATION_DIR`, see `machine-coordination.ts`)
 *
 *  - `dispatch-budget.json` — the ledger (this module's only write target).
 *  - `budget.json` — the per-tier caps (read-only here; the operator writes it):
 *    `{ "maxImplement": 2, "maxAudit": 1 }`.
 *
 * ## Ledger shape (version 1)
 *
 *     { "version": 1,
 *       "entries": [ { "kind": "implement" | "audit",
 *                      "itemId": "WL-…",
 *                      "instanceId": "…",
 *                      "paneId": "…"?,          // absent until a pane exists
 *                      "root": "/abs/worklog/root",
 *                      "startedAt": "<ISO-8601>",
 *                      "heartbeatAt": "<ISO-8601>",
 *                      "override": { "by": "user" }? } ] }
 *
 * `itemId` is the entry key: `reserve` upserts (and preserves the original
 * `startedAt`), `release(itemId)` removes. Entries are written by this module
 * only; a hand-edited or future-format document is `unknown`, never silently
 * reinterpreted (a dropped entry would under-count and admit too much work).
 *
 * ## Concurrency (no new locking scheme)
 *
 * Every read-modify-write runs under the existing `withCoordLock`
 * (`coordination.ts`, atomic `O_CREAT|O_EXCL`) and writes via atomic
 * tmp+rename. There is no daemon, no poller and no background refresh path:
 * the ledger is read and written only when a dispatch path asks about it.
 * Lock contention fails the operation (`lock-contention`) rather than
 * clobbering another writer; a kernel-released lock can therefore never wedge
 * the host.
 *
 * ## Semantics
 *
 *  - `readBudget()` — tolerant read. Missing ledger/file is an empty ledger
 *    (first run). Corrupt/unreadable bytes are `{ ok: false, unknown: true }`
 *    so each caller can apply its own fail direction (dispatcher fails
 *    closed, the interactive path fails open with a notice — parent AC9).
 *  - `reserve(input)` — under the lock, upsert one entry for `itemId`.
 *    Refuses (`unknown`) to rewrite a corrupt ledger.
 *  - `release(itemId)` — under the lock, remove that entry (idempotent:
 *    `removed: false` when absent). Called on pane close, dispatch failure and
 *    a failed claim.
 *  - `reap(livePanes)` — under the lock, drop entries whose heartbeat is stale
 *    **and** whose pane is not in the caller's live pane list.
 *  - `liveCount(kind, livePanes)` — the admission read: counts entries of that
 *    kind whose heartbeat is fresh **and** whose `paneId` is in the live pane
 *    list, and reaps stale, pane-less entries on read so a crashed leader
 *    cannot wedge the host. A reap write is best-effort: the count already
 *    excludes those entries, so lock contention only defers the cleanup.
 *
 * The composite liveness rules are deliberately explicit, because the
 * in-between states matter and are pinned by tests:
 *
 * | heartbeat | pane in live list | counted | reaped |
 * |-----------|-------------------|---------|--------|
 * | fresh     | yes               | yes     | no     |
 * | fresh     | no                | no      | no (spawn/reconcile window) |
 * | stale     | yes               | no      | no (pane still alive) |
 * | stale     | no                | no      | yes    |
 *
 * The window where a freshly reserved entry has no pane yet is why the
 * admission path must pass the `paneId` at reserve time whenever one exists;
 * reaping is bounded by the 2 h stale convention
 * (`DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS`).
 *
 * ## Configuration
 *
 * Resolution order: `budget.json` → defaults (`maxImplement: 2`,
 * `maxAudit: 1`, preserving today's single-flight audit behaviour) →
 * `HERDR_HOST_MAX_IMPLEMENT` / `HERDR_HOST_MAX_AUDIT` env override → clamp to
 * `0..HOST_BUDGET_MAX`. `0` disables that tier host-wide (a per-tier kill
 * switch). A malformed `budget.json` falls back to the defaults and records a
 * warning instead of throwing; an unresolvable coordination dir yields
 * defaults + env and never throws.
 *
 * ## Layering
 *
 * Pure decision helpers (`clampHostBudget`, `parseBudgetConfig`,
 * `applyBudgetEnvOverrides`, `resolveBudgetConfig`, `computeOverQuota`,
 * `isOverQuota`, `isEntryStale`, `reduceLedgerCounts`) touch no filesystem
 * and are unit-tested without fs; every fs read/write lives in the
 * I/O sections below.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { withCoordLock } from './coordination.js';
import {
  DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS,
  ensureMachineCoordinationDir,
  getMachineCoordinationDir,
} from './machine-coordination.js';

// ── Contract constants ─────────────────────────────────────────────────

/** Ledger file name inside the machine coordination dir. */
export const DISPATCH_BUDGET_FILE = 'dispatch-budget.json';

/** Ledger document schema version written by this module. */
export const DISPATCH_BUDGET_VERSION = 1;

/** Budget configuration file name inside the machine coordination dir. */
export const HOST_BUDGET_CONFIG_FILE = 'budget.json';

/** Env override keys, per tier. */
export const HOST_BUDGET_ENV_KEYS = {
  implement: 'HERDR_HOST_MAX_IMPLEMENT',
  audit: 'HERDR_HOST_MAX_AUDIT',
} as const;

/** Ceiling for a configured cap — guards typos/overflow, never a policy. */
export const HOST_BUDGET_MAX = 32;

/** Today's behaviour preserved: two implements, one audit. */
export const DEFAULT_HOST_BUDGET_CONFIG: Readonly<HostBudgetConfig> = Object.freeze({
  maxImplement: 2,
  maxAudit: 1,
});

/**
 * Staleness window for heartbeat-based reaping: the existing 2 h convention
 * used by the host-wide active-audit marker
 * (`DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS`), kept as one number so the two
 * liveness mechanisms cannot drift.
 */
export const HOST_BUDGET_STALE_WINDOW_MS = DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS;

// ── Types ──────────────────────────────────────────────────────────────

/** Dispatch tiers the budget covers (v1: implement + audit only). */
export type HostBudgetKind = 'implement' | 'audit';

/** One in-flight dispatch, exactly the on-disk shape. */
export interface HostBudgetEntry {
  kind: HostBudgetKind;
  /** Entry key — one entry per work item. */
  itemId: string;
  /** herdr instance that owns the dispatch. */
  instanceId: string;
  /** herdr pane id, once a pane exists. */
  paneId?: string;
  /** Absolute worklog root the dispatch operates on. */
  root: string;
  /** ISO-8601 creation time (preserved across re-reserves). */
  startedAt: string;
  /** ISO-8601 liveness timestamp, refreshed by a re-reserve. */
  heartbeatAt: string;
  /** Present when a human deliberately proceeded over quota. */
  override?: { by: 'user' };
}

/** Full ledger document. */
export interface HostBudgetLedger {
  version: number;
  entries: HostBudgetEntry[];
}

/** Per-tier caps. */
export interface HostBudgetConfig {
  maxImplement: number;
  maxAudit: number;
}

/** A resolved configuration plus any non-fatal warnings. */
export interface HostBudgetConfigResult {
  config: HostBudgetConfig;
  warnings: string[];
}

/** One live pane as a pane-list read reports it (title is optional here). */
export interface HostBudgetLivePane {
  paneId: string;
  title?: string;
}

/** Injected seams; every field falls back to production behaviour. */
export interface HostBudgetOptions {
  /** Coordination dir override; `null` means "unresolvable" (AC7). */
  dir?: string | null;
  /** Epoch-ms "now" for staleness/arithmetic. */
  now?: number;
  /** Heartbeat staleness window (defaults to the 2 h convention). */
  staleWindowMs?: number;
  /** Environment view for the config env overrides. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Inputs to {@link reserve}. */
export interface HostBudgetReserveInput {
  kind: HostBudgetKind;
  itemId: string;
  instanceId: string;
  root: string;
  paneId?: string;
  override?: { by: 'user' };
}

/** Why a budget operation could not complete. */
export type HostBudgetFailureReason =
  | 'no-coordination-dir'
  | 'corrupt'
  | 'unreadable'
  | 'lock-contention'
  | 'io-error'
  | 'invalid-input';

/** Shared failure arm. `unknown` distinguishes "cannot tell" from "no ledger". */
export interface HostBudgetFailure {
  ok: false;
  /** `true` when the ledger exists but cannot be trusted (corrupt/unreadable). */
  unknown: boolean;
  reason: HostBudgetFailureReason;
}

/** Result of {@link readBudget}. */
export type BudgetReadout =
  | { ok: true; unknown: false; ledger: HostBudgetLedger }
  | HostBudgetFailure;

/** Result of {@link reserve}. */
export type ReserveResult = { ok: true; entry: HostBudgetEntry } | HostBudgetFailure;

/** Result of {@link release}. */
export type ReleaseResult = { ok: true; removed: boolean } | HostBudgetFailure;

/** Live counts per tier. */
export interface HostBudgetCounts {
  implement: number;
  audit: number;
}

/** Result of {@link reap}. */
export type ReapResult =
  | { ok: true; reaped: number; counts: HostBudgetCounts }
  | HostBudgetFailure;

/** Result of {@link liveCount}. */
export type LiveCountResult =
  | { ok: true; kind: HostBudgetKind; count: number; counts: HostBudgetCounts }
  | HostBudgetFailure;

/** Pure ledger reduction (counts + which entries survive/reap). */
export interface HostBudgetReduction {
  counts: HostBudgetCounts;
  retained: HostBudgetEntry[];
  reaped: HostBudgetEntry[];
}

// ── Pure decision helpers (no filesystem) ───────────────────────────────

/**
 * Clamp one configured cap to `[0, HOST_BUDGET_MAX]`.
 *
 * A non-number, a non-finite value or a negative value is invalid and keeps
 * `fallback` (the repo's clamp convention: garbage never silently changes a
 * setting — in particular, garbage must not silently disable a tier).
 * Invalid `fallback` values are the caller's bug; the defaults are in range.
 */
export function clampHostBudget(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(Math.round(value), HOST_BUDGET_MAX);
}

/**
 * Parse a raw `budget.json` document (already JSON-parsed) into a config.
 *
 * Absent (`undefined`/`null`) means "no file": the defaults, no warning.
 * A non-object, an invalid per-tier value (wrong type, non-finite, negative)
 * keeps the default for that tier and records a warning — a malformed file
 * must never throw, and never half-apply a nonsense cap. Unknown extra keys
 * are ignored (additive format evolution).
 */
export function parseBudgetConfig(raw: unknown): HostBudgetConfigResult {
  const defaults: HostBudgetConfig = { ...DEFAULT_HOST_BUDGET_CONFIG };
  if (raw === undefined || raw === null) return { config: defaults, warnings: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      config: defaults,
      warnings: ['budget.json is not a JSON object; falling back to defaults'],
    };
  }
  const doc = raw as Record<string, unknown>;
  const warnings: string[] = [];
  const tier = (key: keyof HostBudgetConfig): number => {
    const value = doc[key];
    if (value === undefined) return defaults[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      warnings.push(
        `budget.json ${key} is not a non-negative number; using ${defaults[key]}`,
      );
      return defaults[key];
    }
    return clampHostBudget(value, defaults[key]);
  };
  return {
    config: { maxImplement: tier('maxImplement'), maxAudit: tier('maxAudit') },
    warnings,
  };
}

/**
 * Apply `HERDR_HOST_MAX_IMPLEMENT` / `HERDR_HOST_MAX_AUDIT` over a config.
 *
 * Unset and empty values are "no override". A non-numeric or negative value
 * is ignored with a warning (keeping the file/default value). A valid value
 * is clamped to `[0, HOST_BUDGET_MAX]`, so `0` is the documented kill switch.
 */
export function applyBudgetEnvOverrides(
  config: HostBudgetConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): HostBudgetConfigResult {
  const next: HostBudgetConfig = { ...config };
  const warnings: string[] = [];
  const override = (
    key: keyof HostBudgetConfig,
    envKey: string,
  ): void => {
    const raw = env[envKey];
    if (raw === undefined) return;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      warnings.push(`${envKey}="${raw}" is not a non-negative number; keeping ${next[key]}`);
      return;
    }
    next[key] = clampHostBudget(parsed, next[key]);
  };
  override('maxImplement', HOST_BUDGET_ENV_KEYS.implement);
  override('maxAudit', HOST_BUDGET_ENV_KEYS.audit);
  return { config: next, warnings };
}

/** Resolve a config from a raw document plus an environment view (pure). */
export function resolveBudgetConfig(
  raw: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): HostBudgetConfigResult {
  const parsed = parseBudgetConfig(raw);
  const overridden = applyBudgetEnvOverrides(parsed.config, env);
  return {
    config: overridden.config,
    warnings: [...parsed.warnings, ...overridden.warnings],
  };
}

/**
 * How far a dispatch would overshoot its tier after the current one starts.
 *
 * `0` means "within quota". At cap (`current === maximum`) the next dispatch
 * is over by 1; already `n` over cap it is over by `n + 1`. A disabled tier
 * (`maximum === 0`) is over by 1 at `current === 0` — the arithmetic the
 * over-quota dialog and the dispatcher's log both quote.
 */
export function computeOverQuota(current: number, maximum: number): number {
  return Math.max(0, Math.trunc(current) + 1 - Math.trunc(maximum));
}

/** True when a tier at `current` already admits no further dispatch. */
export function isOverQuota(current: number, maximum: number): boolean {
  return Math.trunc(current) >= Math.trunc(maximum);
}

/**
 * True when an entry's heartbeat is at or beyond `staleWindowMs` old.
 *
 * The comparison matches `isHostAuditActive` (an age of exactly the window is
 * stale). An unparseable/missing heartbeat is stale: a corrupt timestamp can
 * never pin an entry forever. A future heartbeat (clock skew) is fresh.
 */
export function isEntryStale(
  entry: Pick<HostBudgetEntry, 'heartbeatAt'>,
  now: number,
  staleWindowMs: number = HOST_BUDGET_STALE_WINDOW_MS,
): boolean {
  const heartbeat = Date.parse(entry.heartbeatAt);
  if (Number.isNaN(heartbeat)) return true;
  return now - heartbeat >= staleWindowMs;
}

/** Build the live-pane-id set from a pane list (pure). */
export function livePaneIdSet(
  panes: readonly HostBudgetLivePane[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const pane of panes) {
    if (typeof pane.paneId === 'string' && pane.paneId.length > 0) ids.add(pane.paneId);
  }
  return ids;
}

/**
 * Reduce a ledger against a live pane list: per-tier live counts, surviving
 * entries and entries to reap (see the liveness table in the header).
 *
 * Pure — the single place the counting and reaping rules live, so
 * `liveCount`, `reap` and the future observability surfaces cannot drift.
 */
export function reduceLedgerCounts(
  entries: readonly HostBudgetEntry[],
  livePaneIds: ReadonlySet<string>,
  now: number,
  staleWindowMs: number = HOST_BUDGET_STALE_WINDOW_MS,
): HostBudgetReduction {
  const counts: HostBudgetCounts = { implement: 0, audit: 0 };
  const retained: HostBudgetEntry[] = [];
  const reaped: HostBudgetEntry[] = [];
  for (const entry of entries) {
    const hasLivePane =
      typeof entry.paneId === 'string' &&
      entry.paneId.length > 0 &&
      livePaneIds.has(entry.paneId);
    const stale = isEntryStale(entry, now, staleWindowMs);
    if (stale && !hasLivePane) {
      reaped.push(entry);
      continue;
    }
    retained.push(entry);
    if (!stale && hasLivePane) counts[entry.kind] += 1;
  }
  return { counts, retained, reaped };
}

// ── Filesystem seams ───────────────────────────────────────────────────

/** Absolute ledger path inside `dir`. */
export function budgetLedgerPath(dir: string): string {
  return path.join(dir, DISPATCH_BUDGET_FILE);
}

/** Absolute config path inside `dir`. */
export function budgetConfigPath(dir: string): string {
  return path.join(dir, HOST_BUDGET_CONFIG_FILE);
}

/**
 * Resolve the effective coordination dir: an explicit override wins (`null`
 * stays `null` = unresolvable), otherwise the machine resolver is consulted.
 */
function resolveBudgetDir(opts: HostBudgetOptions): string | null {
  if (opts.dir !== undefined) return opts.dir;
  return getMachineCoordinationDir();
}

function staleWindowOf(opts: HostBudgetOptions): number {
  return opts.staleWindowMs ?? HOST_BUDGET_STALE_WINDOW_MS;
}

function emptyLedger(): HostBudgetLedger {
  return { version: DISPATCH_BUDGET_VERSION, entries: [] };
}

function noDir(): HostBudgetFailure {
  return { ok: false, unknown: false, reason: 'no-coordination-dir' };
}

function ioError(): HostBudgetFailure {
  return { ok: false, unknown: false, reason: 'io-error' };
}

/**
 * Validate one raw ledger entry. Returns `null` for anything this module did
 * not write (or a future shape it must not guess about) — a single invalid
 * entry makes the whole document corrupt rather than silently dropping it.
 */
function normalizeLedgerEntry(raw: unknown): HostBudgetEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== 'implement' && o.kind !== 'audit') return null;
  if (typeof o.itemId !== 'string' || o.itemId.length === 0) return null;
  if (typeof o.instanceId !== 'string' || o.instanceId.length === 0) return null;
  if (typeof o.root !== 'string') return null;
  if (typeof o.startedAt !== 'string' || Number.isNaN(Date.parse(o.startedAt))) return null;
  if (typeof o.heartbeatAt !== 'string' || Number.isNaN(Date.parse(o.heartbeatAt))) return null;
  if (
    o.paneId !== undefined &&
    (typeof o.paneId !== 'string' || o.paneId.length === 0)
  ) {
    return null;
  }
  let override: { by: 'user' } | undefined;
  if (o.override !== undefined) {
    if (typeof o.override !== 'object' || o.override === null) return null;
    const by = (o.override as Record<string, unknown>).by;
    if (by !== 'user') return null;
    override = { by: 'user' };
  }
  return {
    kind: o.kind,
    itemId: o.itemId,
    instanceId: o.instanceId,
    ...(typeof o.paneId === 'string' ? { paneId: o.paneId } : {}),
    root: o.root,
    startedAt: o.startedAt,
    heartbeatAt: o.heartbeatAt,
    ...(override !== undefined ? { override } : {}),
  };
}

/** Validate a whole ledger document; `null` means corrupt. */
function normalizeLedgerDocument(raw: unknown): HostBudgetLedger | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  if (doc.version !== DISPATCH_BUDGET_VERSION) return null;
  if (!Array.isArray(doc.entries)) return null;
  const entries: HostBudgetEntry[] = [];
  for (const candidate of doc.entries) {
    const entry = normalizeLedgerEntry(candidate);
    if (entry === null) return null;
    entries.push(entry);
  }
  return { version: DISPATCH_BUDGET_VERSION, entries };
}

/**
 * Tolerant read of `<dir>/dispatch-budget.json`.
 *
 * Missing file/directory → an empty ledger (first run). Empty bytes, invalid
 * JSON or a structurally invalid document → `unknown` (never a silent zero).
 * An I/O error other than ENOENT (permissions, EISDIR) → `unknown` too.
 */
function readBudgetAt(dir: string): BudgetReadout {
  let content: string;
  try {
    content = fs.readFileSync(budgetLedgerPath(dir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return { ok: true, unknown: false, ledger: emptyLedger() };
    }
    return { ok: false, unknown: true, reason: 'unreadable' };
  }
  if (!content.trim()) return { ok: false, unknown: true, reason: 'corrupt' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, unknown: true, reason: 'corrupt' };
  }
  const ledger = normalizeLedgerDocument(parsed);
  if (ledger === null) return { ok: false, unknown: true, reason: 'corrupt' };
  return { ok: true, unknown: false, ledger };
}

/**
 * Atomically replace the ledger (tmp + rename): a concurrent reader never
 * sees a partial document and a crash leaves the previous file intact.
 */
function writeBudgetAt(dir: string, ledger: HostBudgetLedger): boolean {
  if (!ensureMachineCoordinationDir(dir)) return false;
  const target = budgetLedgerPath(dir);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort — the rename never happened
    }
    return false;
  }
}

/** Outcome shape for a critical section: success payload or a failure arm. */
type LockedOutcome<T extends object> = ({ ok: true } & T) | HostBudgetFailure;

/**
 * Run one ledger read-modify-write under `withCoordLock`.
 *
 * Lock contention returns `lock-contention` without running `fn` (no lost
 * update, no clobber). A corrupt ledger is surfaced as `unknown` before `fn`
 * runs, so no mutation ever rewrites bytes it cannot trust.
 */
function withLedgerLock<T extends object>(
  dir: string,
  fn: (ledger: HostBudgetLedger) => LockedOutcome<T>,
): LockedOutcome<T> {
  if (!ensureMachineCoordinationDir(dir)) return ioError();
  const outcome = withCoordLock(dir, (): LockedOutcome<T> => {
    const read = readBudgetAt(dir);
    if (!read.ok) return read;
    return fn(read.ledger);
  });
  if (outcome === null) return { ok: false, unknown: false, reason: 'lock-contention' };
  return outcome;
}

// ── Public ledger API ──────────────────────────────────────────────────

/**
 * Read the ledger (tolerant; see the header contract). Never throws.
 *
 * An unresolvable coordination dir is `no-coordination-dir` with
 * `unknown: false`: distinct from `unknown: true`, so a caller's fail
 * direction is never chosen from an ambiguous zero.
 */
export function readBudget(opts: HostBudgetOptions = {}): BudgetReadout {
  const dir = resolveBudgetDir(opts);
  if (dir === null) return noDir();
  return readBudgetAt(dir);
}

/**
 * Reserve (upsert) one entry for `input.itemId`.
 *
 * The entry key is `itemId`, so re-reserving refreshes `heartbeatAt`, adopts
 * a newly known `paneId` and preserves the original `startedAt`. A corrupt
 * ledger is never rewritten (`unknown`), so the caller fails closed.
 */
export function reserve(
  input: HostBudgetReserveInput,
  opts: HostBudgetOptions = {},
): ReserveResult {
  if (
    input.itemId.length === 0 ||
    input.instanceId.length === 0 ||
    (input.kind !== 'implement' && input.kind !== 'audit')
  ) {
    return { ok: false, unknown: false, reason: 'invalid-input' };
  }
  const dir = resolveBudgetDir(opts);
  if (dir === null) return noDir();
  const nowIso = new Date(opts.now ?? Date.now()).toISOString();
  return withLedgerLock(dir, (ledger) => {
    const existing = ledger.entries.find((entry) => entry.itemId === input.itemId);
    const paneId = input.paneId ?? existing?.paneId;
    const override = input.override ?? existing?.override;
    const entry: HostBudgetEntry = {
      kind: input.kind,
      itemId: input.itemId,
      instanceId: input.instanceId,
      ...(paneId !== undefined ? { paneId } : {}),
      root: input.root,
      startedAt: existing?.startedAt ?? nowIso,
      heartbeatAt: nowIso,
      ...(override !== undefined ? { override } : {}),
    };
    const next: HostBudgetLedger = {
      version: DISPATCH_BUDGET_VERSION,
      entries: [
        ...ledger.entries.filter((candidate) => candidate.itemId !== input.itemId),
        entry,
      ],
    };
    if (!writeBudgetAt(dir, next)) return ioError();
    return { ok: true as const, entry };
  });
}

/**
 * Release `itemId`'s entry (pane close, dispatch failure, failed claim).
 * Idempotent: `removed: false` when it was not present. A missing ledger is
 * a successful no-op.
 */
export function release(itemId: string, opts: HostBudgetOptions = {}): ReleaseResult {
  if (itemId.length === 0) return { ok: false, unknown: false, reason: 'invalid-input' };
  const dir = resolveBudgetDir(opts);
  if (dir === null) return noDir();
  return withLedgerLock(dir, (ledger) => {
    const next = ledger.entries.filter((entry) => entry.itemId !== itemId);
    if (next.length === ledger.entries.length) return { ok: true as const, removed: false };
    if (!writeBudgetAt(dir, { version: DISPATCH_BUDGET_VERSION, entries: next })) {
      return ioError();
    }
    return { ok: true as const, removed: true };
  });
}

/**
 * Reap entries whose heartbeat is stale **and** whose pane is not live.
 *
 * Fresh entries and entries whose pane is still live are retained. Writes
 * only when something is reaped, so an idle reap is a pure read. A corrupt
 * ledger is `unknown` and is never rewritten.
 */
export function reap(
  livePanes: readonly HostBudgetLivePane[],
  opts: HostBudgetOptions = {},
): ReapResult {
  const dir = resolveBudgetDir(opts);
  if (dir === null) return noDir();
  const now = opts.now ?? Date.now();
  const windowMs = staleWindowOf(opts);
  const livePaneIds = livePaneIdSet(livePanes);
  return withLedgerLock(dir, (ledger) => {
    const reduction = reduceLedgerCounts(ledger.entries, livePaneIds, now, windowMs);
    if (
      reduction.reaped.length > 0 &&
      !writeBudgetAt(dir, { version: DISPATCH_BUDGET_VERSION, entries: reduction.retained })
    ) {
      return ioError();
    }
    return { ok: true as const, reaped: reduction.reaped.length, counts: reduction.counts };
  });
}

/**
 * Count one tier's live dispatches and reap stale, pane-less entries on read.
 *
 * Counted = heartbeat fresh AND `paneId` in `livePanes` (see the header
 * table). The reap write is best-effort: the returned count already excludes
 * reaped entries, so lock contention only defers cleanup — a crashed leader
 * can never wedge the host.
 */
export function liveCount(
  kind: HostBudgetKind,
  livePanes: readonly HostBudgetLivePane[],
  opts: HostBudgetOptions = {},
): LiveCountResult {
  const dir = resolveBudgetDir(opts);
  if (dir === null) return noDir();
  const now = opts.now ?? Date.now();
  const windowMs = staleWindowOf(opts);
  const read = readBudgetAt(dir);
  if (!read.ok) return read;
  const reduction = reduceLedgerCounts(
    read.ledger.entries,
    livePaneIdSet(livePanes),
    now,
    windowMs,
  );
  let counts = reduction.counts;
  if (reduction.reaped.length > 0) {
    const reaped = reap(livePanes, { ...opts, dir, now, staleWindowMs: windowMs });
    if (reaped.ok) counts = reaped.counts;
  }
  return { ok: true, kind, count: counts[kind], counts };
}

/**
 * Resolve the effective per-tier caps from `budget.json` + env overrides.
 *
 * Never throws. A missing file is silent (defaults); malformed/unreadable
 * content records a warning and uses defaults; an unresolvable coordination
 * dir records a warning and still applies env overrides, so behaviour stays
 * exactly as today (AC7).
 */
export function readBudgetConfig(opts: HostBudgetOptions = {}): HostBudgetConfigResult {
  const env = opts.env ?? process.env;
  const dir = resolveBudgetDir(opts);
  if (dir === null) {
    const resolved = resolveBudgetConfig(undefined, env);
    return {
      config: resolved.config,
      warnings: [
        'budget.json not read: coordination dir unresolvable; using defaults and env overrides',
        ...resolved.warnings,
      ],
    };
  }
  const file = budgetConfigPath(dir);
  let raw: unknown;
  const warnings: string[] = [];
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') {
      warnings.push(`budget.json unreadable at ${file} (${code ?? 'unknown error'}); using defaults`);
    }
    const resolved = resolveBudgetConfig(undefined, env);
    return { config: resolved.config, warnings: [...warnings, ...resolved.warnings] };
  }
  try {
    raw = JSON.parse(content);
  } catch {
    warnings.push(`budget.json at ${file} is not valid JSON; using defaults`);
    raw = undefined;
  }
  const resolved = resolveBudgetConfig(raw, env);
  return { config: resolved.config, warnings: [...warnings, ...resolved.warnings] };
}
