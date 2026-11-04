/**
 * packages/herdr/src/host-dispatch-budget.fixtures.ts — machine-budget test
 * harness (WL-0MVXY0VGR00840ZS, parent WL-0MVXWQFGV000D2AB).
 *
 * One reusable harness for every host-wide dispatch-budget test, modelled on
 * the machine-wide slot-budget precedent (`slot-budget-machine.test.ts`,
 * WL-0MTII48OV008P2QU): two fake herdr instances share ONE temporary machine
 * coordination directory, so a test can prove machine-scoped semantics
 * (counts, caps, reaping, override) without hand-rolling `mkdtempSync` +
 * fake instance ids + fake pane lists in each file.
 *
 * Test-support only — this module contains NO production behaviour. It
 * writes and reads the dispatch ledger as RAW JSON, deliberately bypassing
 * the production ledger API, so a test can seed pre-existing, stale, corrupt
 * or over-quota state that the production writer would never produce.
 *
 * ## Isolation contract
 *
 * `withMachineDir(fn)` creates a unique directory under the OS temp root,
 * pins it as the machine coordination dir via `HERDR_COORDINATION_DIR`,
 * asserts the resolver actually returned that directory (so a test can never
 * silently fall through to the real `~/.herdr/downtime`), and removes the
 * directory — and restores the previous env value — on every exit path,
 * including a thrown error. A test that needs an injected path instead of
 * the env pin can pass the directory from `withMachineDir` straight to the
 * raw ledger writers below.
 *
 * ## Raw ledger file contract
 *
 * The ledger lives at `<machine dir>/dispatch-budget.json` with the shape
 * `{ version: 1, entries: [...] }`, one entry per in-flight dispatch:
 *
 *     { kind, itemId, instanceId, paneId?, root,
 *       startedAt, heartbeatAt, override?: { by: 'user' } }
 *
 * `DISPATCH_BUDGET_FILE` / `DISPATCH_BUDGET_VERSION` mirror the production
 * ledger contract (parent design). They are declared here because the
 * production ledger module lands in a later slice of the same epic; that
 * module must keep the same file name and shape, and this fixture is the
 * single place the tests encode them until it exists.
 *
 * ## Fake live pane list contract
 *
 * Liveness is modelled as a plain `Array<{ paneId: string; title: string }>`
 * — exactly what a pane list read yields — so tests drive "is this dispatch
 * still live?" without herdr, a real pane or `/proc`. The production rule is
 * the item-id-in-pane-title convention (`pane-title.ts`): a pane belongs to
 * a dispatch when its `paneId` is in the list and its `title` embeds the
 * work-item id. `makeLivePaneList` builds titles that embed the id
 * (`Downtime triggered - <id>`, mirroring the dispatcher's pane titles) and a
 * bare string spec is shorthand for that item id. A pane spec with no
 * `itemId`/`title` yields an empty title — "a live pane that belongs to no
 * work item" — and is never inferred to belong to one.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getMachineCoordinationDir } from './machine-coordination.js';

// ── Ledger contract mirrored from the parent design ────────────────────

/** Machine-dir ledger file name — one entry per in-flight dispatch. */
export const DISPATCH_BUDGET_FILE = 'dispatch-budget.json';

/** Ledger document schema version. */
export const DISPATCH_BUDGET_VERSION = 1;

/** Dispatch tiers the budget covers (v1: implement + audit only). */
export type FakeBudgetKind = 'implement' | 'audit';

/** One raw ledger entry, byte-for-byte the production on-disk shape. */
export interface FakeBudgetEntry {
  kind: FakeBudgetKind;
  itemId: string;
  instanceId: string;
  paneId?: string;
  root: string;
  startedAt: string;
  heartbeatAt: string;
  override?: { by: 'user' };
}

/** Full ledger document shape. */
export interface FakeBudgetLedger {
  version: number;
  entries: FakeBudgetEntry[];
}

// ── Fake instance records ──────────────────────────────────────────────

/**
 * A fake herdr instance record usable directly as a coordination entry.
 *
 * `directory` is kept in sync with `worklogRoot` (the coordination module's
 * legacy alias, see `coordination.ts`), so the same record can be fed to the
 * coordination helpers and the budget harness without translation.
 */
export interface FakeInstance {
  instanceId: string;
  workItemId: string;
  worklogRoot: string;
  directory: string;
  assignedAt: string;
  lastUpdated: string;
}

/**
 * Build a fake instance record for `id`.
 *
 * Defaults are deliberately inert: an empty `workItemId` and a fake
 * `/repo/<id>` root (never touched on disk — the ledger stores the root as a
 * string only). `assignedAt`/`lastUpdated` default to "now" so the record is
 * non-stale; pass ISO timestamps in `overrides` for staleness scenarios.
 */
export function makeInstance(
  id: string,
  overrides: Partial<Omit<FakeInstance, 'instanceId' | 'directory'>> = {},
): FakeInstance {
  const now = new Date().toISOString();
  const worklogRoot = overrides.worklogRoot ?? `/repo/${id}`;
  return {
    instanceId: id,
    workItemId: overrides.workItemId ?? '',
    worklogRoot,
    directory: worklogRoot,
    assignedAt: overrides.assignedAt ?? now,
    lastUpdated: overrides.lastUpdated ?? now,
  };
}

// ── Fake live pane lists ───────────────────────────────────────────────

/** One live pane as a pane-list read reports it. */
export interface FakeLivePane {
  paneId: string;
  title: string;
}

/**
 * Concise pane spec:
 *  - a bare string is the work-item id the pane belongs to;
 *  - an object may set `paneId`, `title` and/or `itemId` independently.
 */
export type FakePaneSpec = string | { paneId?: string; title?: string; itemId?: string };

/**
 * Build a fake live pane list (see the fake-pane-list contract above).
 *
 * Deterministic: an omitted `paneId` becomes `pane-<n>` (1-based index), and
 * an omitted `title` is `Downtime triggered - <itemId>` when an item id is
 * given, otherwise `''`. An explicit `title` always wins, so a test can
 * simulate a pane whose title carries a DIFFERENT id (or none).
 */
export function makeLivePaneList(specs: readonly FakePaneSpec[] = []): FakeLivePane[] {
  return specs.map((spec, index) => {
    const fallbackPaneId = `pane-${index + 1}`;
    if (typeof spec === 'string') {
      return { paneId: fallbackPaneId, title: `Downtime triggered - ${spec}` };
    }
    const itemSuffix = spec.itemId ? `Downtime triggered - ${spec.itemId}` : '';
    return {
      paneId: spec.paneId ?? fallbackPaneId,
      title: spec.title ?? itemSuffix,
    };
  });
}

// ── Machine-dir isolation ──────────────────────────────────────────────

/** Prefix of the temporary machine directories this harness creates. */
export const MACHINE_DIR_TEMP_PREFIX = 'herdr-budget-';

/**
 * Run `fn` against a freshly created, isolated machine coordination dir.
 *
 * The directory is pinned via `HERDR_COORDINATION_DIR` for the duration of
 * `fn`, and the process env is restored afterwards (a previously set value
 * is put back; an unset value is deleted). The directory is removed in a
 * `finally`, so a throwing body still leaves the OS temp root clean.
 *
 * Fail-closed pin: if the machine-dir resolver does not return exactly the
 * temporary directory (e.g. the override was ignored), the call throws
 * BEFORE `fn` runs — no test body can ever touch the real
 * `~/.herdr/downtime`.
 *
 * `HERDR_COORDINATION_DIR` is process-global, so calls must not overlap: run
 * one `withMachineDir` at a time (the vitest default — sequential tests
 * within a file). `it.concurrent` bodies sharing this harness would fight
 * over the env pin.
 */
export async function withMachineDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), MACHINE_DIR_TEMP_PREFIX));
  const previous = process.env.HERDR_COORDINATION_DIR;
  process.env.HERDR_COORDINATION_DIR = dir;
  try {
    const pinned = getMachineCoordinationDir();
    if (pinned !== dir) {
      throw new Error(
        `withMachineDir: HERDR_COORDINATION_DIR did not pin the machine dir ` +
          `(expected ${dir}, resolved ${pinned ?? 'null'}) — refusing to run the test body.`,
      );
    }
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HERDR_COORDINATION_DIR;
    else process.env.HERDR_COORDINATION_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Raw ledger writers / readers (no production API) ───────────────────

/** Absolute path of the ledger file inside `dir`. */
export function budgetLedgerPath(dir: string): string {
  return join(dir, DISPATCH_BUDGET_FILE);
}

/**
 * Build a ledger entry with documented defaults, for seeding and appending.
 * `overrides` wins field by field; `override: { by: 'user' }` is only
 * present when explicitly supplied.
 */
export function makeBudgetEntry(overrides: Partial<FakeBudgetEntry> = {}): FakeBudgetEntry {
  const now = new Date().toISOString();
  return {
    kind: overrides.kind ?? 'implement',
    itemId: overrides.itemId ?? 'WL-TEST',
    instanceId: overrides.instanceId ?? 'instance-1',
    ...(overrides.paneId !== undefined ? { paneId: overrides.paneId } : {}),
    root: overrides.root ?? '/repo/test',
    startedAt: overrides.startedAt ?? now,
    heartbeatAt: overrides.heartbeatAt ?? now,
    ...(overrides.override !== undefined ? { override: overrides.override } : {}),
  };
}

/**
 * Write `raw` bytes verbatim as the ledger file (creating `dir` if absent).
 * The escape hatch for corrupt/truncated/empty-ledger scenarios that no
 * well-typed writer could produce. Returns the ledger path.
 */
export function writeRawBudgetLedger(dir: string, raw: string): string {
  mkdirSync(dir, { recursive: true });
  const file = budgetLedgerPath(dir);
  writeFileSync(file, raw, 'utf8');
  return file;
}

/**
 * Replace the ledger with exactly `entries` (creating `dir` if absent).
 * Returns the ledger path.
 */
export function writeBudgetLedger(
  dir: string,
  entries: readonly FakeBudgetEntry[],
  opts: { version?: number } = {},
): string {
  const document: FakeBudgetLedger = {
    version: opts.version ?? DISPATCH_BUDGET_VERSION,
    entries: entries.map((entry) => ({ ...entry })),
  };
  return writeRawBudgetLedger(dir, JSON.stringify(document, null, 2) + '\n');
}

/**
 * Read the ledger as stored on disk. Returns `null` when the file is
 * missing, empty or unparsable — the same fail-safe view a production
 * reader must have, and the hook for "corrupt ledger" tests.
 */
export function readBudgetLedger(dir: string): FakeBudgetLedger | null {
  let raw: string;
  try {
    raw = readFileSync(budgetLedgerPath(dir), 'utf8');
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const document = parsed as Partial<FakeBudgetLedger>;
    if (!Array.isArray(document.entries)) return null;
    return {
      version: typeof document.version === 'number' ? document.version : DISPATCH_BUDGET_VERSION,
      entries: document.entries as FakeBudgetEntry[],
    };
  } catch {
    return null;
  }
}

/**
 * Append `entries` to the existing ledger (creating it when absent) and
 * return the merged document. This is the "another instance wrote here"
 * primitive: two fake instances sharing one machine dir each seed their own
 * entry and can then observe both, without a production reserve call.
 */
export function seedBudgetLedger(
  dir: string,
  entries: readonly FakeBudgetEntry[],
): FakeBudgetLedger {
  const existing = readBudgetLedger(dir);
  const merged: FakeBudgetLedger = {
    version: existing?.version ?? DISPATCH_BUDGET_VERSION,
    entries: [...(existing?.entries ?? []), ...entries.map((entry) => ({ ...entry }))],
  };
  writeRawBudgetLedger(dir, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}
