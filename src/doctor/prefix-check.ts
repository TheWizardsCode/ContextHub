/**
 * Project ID-prefix rename for `wl doctor prefix` (WL-0MVZ2U4E0003IVSZ,
 * parent WL-0MVM8V79C003XH2J).
 *
 * The command has two faces:
 *
 *  - **Preview (default, read-only).** Report the current prefix, how many
 *    records a rename would touch (work items, comments, dependency edges,
 *    audit results) and a bounded sample of the old→new ID pairs.
 *  - **Apply (`--apply` / `--confirm`).** Rewrite every ID-bearing column and
 *    the `prefix:` entry in `.worklog/config.yaml` in one SQLite transaction,
 *    then write `.worklog/prefix-rename-<timestamp>.json` so callers can sweep
 *    ID references that live *outside* the store (code comments, docs, test
 *    fixtures, commit messages, branch/worktree names).
 *
 * A rename only ever changes the substring before the **first** `-` of an ID,
 * so `OSL-0MVK31VYQ007CN37` becomes `CC-0MVK31VYQ007CN37`. Suffixes are never
 * touched, which keeps the rename deterministic and reversible via the map.
 *
 * The rewrite opens the SQLite file directly (the same pattern the migration
 * runner uses in `src/migrations/index.ts`) because it has to touch several
 * tables — including the primary keys those tables hang off — inside a single
 * transaction. `foreign_keys` is disabled for the rename connection so the
 * primary-key moves cannot trip immediate FK checks mid-transaction; the
 * transaction is atomic, so a failure rolls the whole rename back.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import type { WorkItem, Comment, DependencyEdge, AuditResult } from '../types.js';
import { extractIdPrefix } from './foreign-items-check.js';

/** Maximum number of `{ from, to }` pairs echoed by a preview. */
export const MAX_PREFIX_SAMPLES = 10;

// ── Pure helpers (unit-tested) ─────────────────────────────────────────

/** Result of validating a `--to <PREFIX>` value. */
export interface PrefixValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a target prefix.
 *
 * A valid prefix is non-empty and consists of ASCII letters/digits only. A
 * `-` is rejected because it is the ID separator (`C-C` would produce
 * `C-C-0M...`), and whitespace/punctuation/non-ASCII characters are rejected
 * because IDs are matched by `extractIdPrefix` on the raw string.
 */
export function validateTargetPrefix(value: string): PrefixValidationResult {
  if (typeof value !== 'string' || value === '') {
    return { valid: false, error: 'Target prefix is invalid: it must be a non-empty string.' };
  }
  if (value !== value.trim()) {
    return {
      valid: false,
      error: `Target prefix ${JSON.stringify(value)} is invalid: it must not contain leading or trailing whitespace.`,
    };
  }
  if (!/^[A-Za-z0-9]+$/.test(value)) {
    return {
      valid: false,
      error:
        `Target prefix ${JSON.stringify(value)} is invalid: use ASCII letters and digits only ` +
        "(no '-', no spaces, no punctuation, no non-ASCII characters).",
    };
  }
  return { valid: true };
}

/**
 * Rename an ID's prefix, preserving its suffix.
 *
 * Only the substring before the **first** `-` changes. `fromPrefix` is matched
 * case-insensitively (a store can hold `OSL-…` while the config says `osl`),
 * IDs without a `-` and IDs carrying a different prefix are returned
 * unchanged, and `fromPrefix === toPrefix` is a no-op.
 */
export function renameId(id: string, fromPrefix: string, toPrefix: string): string {
  if (fromPrefix === toPrefix) {
    return id;
  }
  const prefix = extractIdPrefix(id);
  if (prefix === null) {
    return id;
  }
  if (prefix.toUpperCase() !== String(fromPrefix).toUpperCase()) {
    return id;
  }
  return `${toPrefix}${id.slice(prefix.length)}`;
}

/** Input to {@link decidePrefixConfirmation}. */
export interface PrefixConfirmationInput {
  /** Explicit `--confirm` flag. */
  confirm?: boolean;
  /** `Boolean(process.stdin.isTTY)` of the running CLI. */
  stdinIsTTY: boolean;
  /** The operator's answer when the caller prompted (already read). */
  answer?: string | null;
}

/** Outcome of the confirmation gate. */
export interface PrefixConfirmationDecision {
  /** True only when the caller may write. */
  proceed: boolean;
  /** True when the caller must prompt (and re-run this helper with the answer). */
  prompt: boolean;
}

/**
 * Decide whether an apply request may proceed.
 *
 * - `confirm: true` → proceed, never prompt.
 * - non-TTY without `confirm` → never prompt, never proceed (fail closed).
 * - TTY without `confirm` → prompt; proceed only when the trimmed, lowercased
 *   answer is exactly `y` (`yes`, `n`, an empty answer and anything else
 *   decline).
 */
export function decidePrefixConfirmation(
  input: PrefixConfirmationInput,
): PrefixConfirmationDecision {
  if (input.confirm === true) {
    return { proceed: true, prompt: false };
  }
  if (!input.stdinIsTTY) {
    return { proceed: false, prompt: false };
  }
  const answer = typeof input.answer === 'string' ? input.answer.trim().toLowerCase() : '';
  return { proceed: answer === 'y', prompt: true };
}

// ── Preview (read-only) ────────────────────────────────────────────────

/** Rows touched by a rename, per record type. */
export interface PrefixRenameCounts {
  /** Work items whose `id` changes. */
  items: number;
  /** Comments whose `workItemId` changes. */
  comments: number;
  /** Dependency edges with at least one renamed endpoint. */
  dependencyEdges: number;
  /** Audit results whose `work_item_id` changes. */
  auditRecords: number;
}

/** One old→new ID pair. */
export interface PrefixRenameSample {
  from: string;
  to: string;
}

/** Read-only preview of a rename. */
export interface PrefixRenamePreview {
  fromPrefix: string;
  toPrefix: string;
  counts: PrefixRenameCounts;
  samples: PrefixRenameSample[];
  /** Number of work items whose ID changes (mirrors `counts.items`). */
  renamedCount: number;
  /** Old item ID → new item ID, for every item that changes. */
  idMap: Record<string, string>;
}

/** Input to {@link buildPrefixRenamePreview}. */
export interface PrefixRenamePreviewInput {
  items: WorkItem[];
  comments: Comment[];
  edges: DependencyEdge[];
  audits: AuditResult[];
  fromPrefix: string;
  toPrefix: string;
}

/** Counts with every field zero (an idempotent replay touches nothing). */
export function emptyPrefixRenameCounts(): PrefixRenameCounts {
  return { items: 0, comments: 0, dependencyEdges: 0, auditRecords: 0 };
}

/**
 * Build the read-only preview: counts per record type plus up to
 * {@link MAX_PREFIX_SAMPLES} old→new ID pairs. Performs no writes.
 */
export function buildPrefixRenamePreview(input: PrefixRenamePreviewInput): PrefixRenamePreview {
  const { fromPrefix, toPrefix } = input;
  const counts = emptyPrefixRenameCounts();
  const samples: PrefixRenameSample[] = [];
  const idMap: Record<string, string> = {};

  for (const item of input.items) {
    const renamed = renameId(item.id, fromPrefix, toPrefix);
    if (renamed === item.id) continue;
    counts.items += 1;
    idMap[item.id] = renamed;
    if (samples.length < MAX_PREFIX_SAMPLES) {
      samples.push({ from: item.id, to: renamed });
    }
  }

  for (const comment of input.comments) {
    if (renameId(comment.workItemId, fromPrefix, toPrefix) !== comment.workItemId) {
      counts.comments += 1;
    }
  }

  for (const edge of input.edges) {
    if (
      renameId(edge.fromId, fromPrefix, toPrefix) !== edge.fromId ||
      renameId(edge.toId, fromPrefix, toPrefix) !== edge.toId
    ) {
      counts.dependencyEdges += 1;
    }
  }

  for (const audit of input.audits) {
    if (renameId(audit.workItemId, fromPrefix, toPrefix) !== audit.workItemId) {
      counts.auditRecords += 1;
    }
  }

  return {
    fromPrefix,
    toPrefix,
    counts,
    samples,
    renamedCount: counts.items,
    idMap,
  };
}

// ── Rename map ─────────────────────────────────────────────────────────

/** Machine-readable rename map persisted next to the store. */
export interface PrefixRenameMap {
  fromPrefix: string;
  toPrefix: string;
  /** ISO timestamp of the applied rename. */
  renamedAt: string;
  /** Old item ID → new item ID. */
  ids: Record<string, string>;
}

/** Filename-safe ISO timestamp (no `:`, no `.`). */
function renameMapTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/** Build the rename-map payload for a completed apply. */
export function buildPrefixRenameMap(
  fromPrefix: string,
  toPrefix: string,
  ids: Record<string, string>,
  now: Date = new Date(),
): PrefixRenameMap {
  return { fromPrefix, toPrefix, renamedAt: now.toISOString(), ids };
}

/**
 * Write the rename map to `.worklog/prefix-rename-<timestamp>.json` and return
 * its absolute path.
 */
export function writePrefixRenameMap(
  worklogDir: string,
  map: PrefixRenameMap,
  now: Date = new Date(),
): string {
  const file = path.join(worklogDir, `prefix-rename-${renameMapTimestamp(now)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`, 'utf-8');
  return file;
}

// ── Config rewrite ─────────────────────────────────────────────────────

/**
 * Rewrite only the top-level `prefix:` entry of `.worklog/config.yaml`.
 *
 * Deliberately line-anchored instead of `saveConfig(loadConfig())`: the
 * config loader resolves the `llm` section from `LLM_*` environment variables,
 * so re-serialising it would persist an env-derived API key into a tracked
 * file. This preserves every other line (comments, ordering, formatting)
 * byte-for-byte; the prefix itself is ASCII alphanumeric, so it needs no YAML
 * quoting.
 *
 * @throws When the file has no top-level `prefix:` line to rewrite.
 */
export function rewriteConfigPrefix(configPath: string, prefix: string): void {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const lines = raw.split('\n');
  const index = lines.findIndex((line) => /^prefix:\s*/.test(line));
  if (index === -1) {
    throw new Error(
      `Cannot rewrite the project prefix: no top-level 'prefix:' entry in ${configPath}`,
    );
  }
  lines[index] = `prefix: ${prefix}`;
  fs.writeFileSync(configPath, lines.join('\n'), 'utf-8');
}

// ── Report shaping ─────────────────────────────────────────────────────

/** JSON report emitted by `wl doctor prefix` (both modes). */
export interface PrefixRenameReport {
  success: boolean;
  dryRun: boolean;
  /** True only when this run wrote to the store. */
  applied: boolean;
  fromPrefix: string;
  toPrefix: string;
  counts: PrefixRenameCounts;
  samples: PrefixRenameSample[];
  renamedCount: number;
  /** Absolute rename-map path after a write, `null` otherwise. */
  renameMapPath: string | null;
}

/** Input to {@link buildPrefixRenameReport}. */
export interface PrefixRenameReportInput {
  preview: PrefixRenamePreview;
  dryRun: boolean;
  applied: boolean;
  counts?: PrefixRenameCounts;
  renameMapPath?: string | null;
}

/** Build the machine-readable report for a preview or applied rename. */
export function buildPrefixRenameReport(input: PrefixRenameReportInput): PrefixRenameReport {
  const counts = input.counts ?? input.preview.counts;
  return {
    success: true,
    dryRun: input.dryRun,
    applied: input.applied,
    fromPrefix: input.preview.fromPrefix,
    toPrefix: input.preview.toPrefix,
    counts,
    samples: input.preview.samples,
    renamedCount: counts.items,
    renameMapPath: input.renameMapPath ?? null,
  };
}

/** Render a report as human-readable lines (one `console.log` per line). */
export function formatPrefixRenameReport(report: PrefixRenameReport): string[] {
  const lines = [
    `Doctor prefix: ${report.fromPrefix} -> ${report.toPrefix} — ` +
      `${report.counts.items} item(s), ${report.counts.comments} comment(s), ` +
      `${report.counts.dependencyEdges} dependency edge(s), ${report.counts.auditRecords} audit record(s).`,
  ];
  for (const sample of report.samples) {
    lines.push(`  ${sample.from} -> ${sample.to}`);
  }
  if (report.dryRun) {
    lines.push('Dry-run only; nothing was modified. Re-run with --confirm to apply the rename.');
  } else {
    lines.push(`Applied prefix rename. Rename map: ${report.renameMapPath ?? '(none)'}`);
  }
  return lines;
}

/** Human-readable line for an idempotent replay (nothing to rename). */
export function formatPrefixRenameReplay(toPrefix: string): string {
  return `Doctor prefix: the store already carries the ${toPrefix} prefix; nothing to rename.`;
}

// ── Apply (transactional rewrite) ──────────────────────────────────────

/** Input to {@link applyPrefixRename}. */
export interface ApplyPrefixRenameOptions {
  /** Absolute path to the SQLite store (`<worklog-dir>/worklog.db`). */
  dbPath: string;
  fromPrefix: string;
  toPrefix: string;
  /**
   * Run inside the DB transaction, immediately before `COMMIT`. Used to
   * persist ancillary state (the config prefix) so it commits with the store
   * or is not written at all.
   */
  beforeCommit?: () => void;
  /** Run when the transaction (including `beforeCommit`/`COMMIT`) fails. */
  onFailure?: () => void;
}

/** Result of an applied rename. */
export interface ApplyPrefixRenameResult {
  counts: PrefixRenameCounts;
  renamedCount: number;
  ids: Record<string, string>;
}

/** Row shapes read from the store. */
interface WorkItemIdRow {
  id: string;
  parentId: string | null;
}
interface CommentIdRow {
  id: string;
  workItemId: string;
  refs: string;
}
interface EdgeRow {
  fromId: string;
  toId: string;
}
interface AuditRow {
  work_item_id: string;
}
interface FtsRow {
  itemId: string | null;
  parentId: string | null;
}

/**
 * Rewrite every ID-bearing record in a single SQLite transaction.
 *
 * Covered columns: `workitems.id`, `workitems.parentId`, `comments.id`,
 * `comments.workItemId`, the IDs inside `comments.refs` (JSON array),
 * `dependency_edges.fromId`/`toId`, `audit_results.work_item_id` and the
 * `worklog_fts` `itemId`/`parentId` columns (when the index exists).
 *
 * Suffixes are preserved by {@link renameId}. Any failure — including a throw
 * from `beforeCommit` — rolls the whole rewrite back, leaving the store
 * exactly as it was.
 */
export function applyPrefixRename(opts: ApplyPrefixRenameOptions): ApplyPrefixRenameResult {
  const { dbPath, fromPrefix, toPrefix } = opts;
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Cannot apply prefix rename: store not found at ${dbPath}`);
  }

  const db = new Database(dbPath);
  const counts = emptyPrefixRenameCounts();
  const ids: Record<string, string> = {};

  const run = db.transaction(() => {
    // Work items: primary key plus the parent reference.
    const workItems = db
      .prepare('SELECT id, parentId FROM workitems')
      .all() as WorkItemIdRow[];
    const updateItemId = db.prepare('UPDATE workitems SET id = ? WHERE id = ?');
    const updateParentId = db.prepare('UPDATE workitems SET parentId = ? WHERE parentId = ?');
    for (const row of workItems) {
      const newId = renameId(row.id, fromPrefix, toPrefix);
      if (newId !== row.id) {
        updateItemId.run(newId, row.id);
        ids[row.id] = newId;
        counts.items += 1;
      }
      if (row.parentId) {
        const newParentId = renameId(row.parentId, fromPrefix, toPrefix);
        if (newParentId !== row.parentId) {
          updateParentId.run(newParentId, row.parentId);
        }
      }
    }

    // Comments: owning item, the comment's own ID and its `refs` array.
    const comments = db
      .prepare('SELECT id, workItemId, refs FROM comments')
      .all() as CommentIdRow[];
    const updateCommentItem = db.prepare('UPDATE comments SET workItemId = ? WHERE id = ?');
    const updateCommentRefs = db.prepare('UPDATE comments SET refs = ? WHERE id = ?');
    const updateCommentId = db.prepare('UPDATE comments SET id = ? WHERE id = ?');
    for (const row of comments) {
      const newWorkItemId = renameId(row.workItemId, fromPrefix, toPrefix);
      if (newWorkItemId !== row.workItemId) {
        updateCommentItem.run(newWorkItemId, row.id);
        counts.comments += 1;
      }

      const newRefs = renameReferences(row.refs, fromPrefix, toPrefix);
      if (newRefs !== null && newRefs !== row.refs) {
        updateCommentRefs.run(newRefs, row.id);
      }

      const newCommentId = renameId(row.id, fromPrefix, toPrefix);
      if (newCommentId !== row.id) {
        updateCommentId.run(newCommentId, row.id);
      }
    }

    // Dependency edges: both endpoints.
    const edges = db
      .prepare('SELECT fromId, toId FROM dependency_edges')
      .all() as EdgeRow[];
    const updateEdge = db.prepare(
      'UPDATE dependency_edges SET fromId = ?, toId = ? WHERE fromId = ? AND toId = ?',
    );
    for (const row of edges) {
      const newFromId = renameId(row.fromId, fromPrefix, toPrefix);
      const newToId = renameId(row.toId, fromPrefix, toPrefix);
      if (newFromId !== row.fromId || newToId !== row.toId) {
        updateEdge.run(newFromId, newToId, row.fromId, row.toId);
        counts.dependencyEdges += 1;
      }
    }

    // Audit results: the audited item's ID.
    const audits = db
      .prepare('SELECT work_item_id FROM audit_results')
      .all() as AuditRow[];
    const updateAudit = db.prepare('UPDATE audit_results SET work_item_id = ? WHERE work_item_id = ?');
    for (const row of audits) {
      const newWorkItemId = renameId(row.work_item_id, fromPrefix, toPrefix);
      if (newWorkItemId !== row.work_item_id) {
        updateAudit.run(newWorkItemId, row.work_item_id);
        counts.auditRecords += 1;
      }
    }

    // Full-text index: the UNINDEXED ID columns must follow the rename or
    // `wl search` keeps returning stale IDs.
    const ftsExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worklog_fts'")
      .get() as { name: string } | undefined;
    if (ftsExists) {
      const rows = db
        .prepare('SELECT itemId, parentId FROM worklog_fts')
        .all() as FtsRow[];
      const updateFts = db.prepare(
        'UPDATE worklog_fts SET itemId = ?, parentId = ? WHERE itemId = ? AND parentId = ?',
      );
      for (const row of rows) {
        const itemId = row.itemId ?? '';
        const parentId = row.parentId ?? '';
        const newItemId = renameId(itemId, fromPrefix, toPrefix);
        const newParentId = renameId(parentId, fromPrefix, toPrefix);
        if (newItemId !== itemId || newParentId !== parentId) {
          updateFts.run(newItemId, newParentId, itemId, parentId);
        }
      }
    }

    opts.beforeCommit?.();
  });

  try {
    // Primary keys move, so immediate FK enforcement would reject the
    // in-flight state. `foreign_keys` must be toggled outside a transaction.
    db.pragma('foreign_keys = OFF');
    run();
  } catch (err) {
    try {
      opts.onFailure?.();
    } catch (_restoreErr) {
      // Restoring ancillary state is best-effort on the failure path.
    }
    throw err;
  } finally {
    db.close();
  }

  return { counts, renamedCount: counts.items, ids };
}

/**
 * Rewrite the work-item IDs inside a comment's `refs` JSON array.
 *
 * Returns `null` when the payload is not a JSON array (left untouched) so the
 * caller can skip the write.
 */
function renameReferences(
  rawRefs: string,
  fromPrefix: string,
  toPrefix: string,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawRefs);
  } catch (_err) {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  let changed = false;
  const next = parsed.map((value) => {
    if (typeof value !== 'string') return value;
    const renamed = renameId(value, fromPrefix, toPrefix);
    if (renamed !== value) changed = true;
    return renamed;
  });
  return changed ? JSON.stringify(next) : rawRefs;
}

// ── Command runner ─────────────────────────────────────────────────────

/** Subset of the WorklogDatabase the command needs (read-only preview input). */
export interface PrefixRenameStore {
  getAll(): WorkItem[];
  getAllComments(): Comment[];
  getAllDependencyEdges(): DependencyEdge[];
  getAllAuditResults(): AuditResult[];
}

/** Input to {@link runPrefixRename}. */
export interface PrefixRenameRunnerDeps {
  opts: { to?: string; apply?: boolean; confirm?: boolean; prefix?: string };
  /** The project's configured prefix (`null` when no config exists). */
  configPrefix: string | null;
  /** The CLI's data path (`.worklog/worklog-data.jsonl`); its directory holds the store. */
  dataPath: string;
  /** Absolute path to `.worklog/config.yaml`. */
  configPath: string;
  isJsonMode: boolean;
  stdinIsTTY: boolean;
  db: PrefixRenameStore;
  /** Serialise the write with the CLI's other store mutations. */
  withMutationLock: <T>(fn: () => T) => T;
  /** Readline-backed prompt (injected so the gate flow is TTY-free testable). */
  prompt: (question: string) => Promise<string>;
  /** Clock override (rename-map filename/timestamp). */
  now?: Date;
}

/** Result of {@link runPrefixRename}: the caller renders whichever is present. */
export interface PrefixRenameRunResult {
  /** Process exit code (0 = success, non-zero = refusal/validation error). */
  exitCode: number;
  /** JSON payload to emit in JSON mode (report or `{ success: false, error }`). */
  json: Record<string, unknown>;
  /** Human-readable lines to print (non-JSON mode); empty for failures. */
  lines: string[];
  /** Error text (non-JSON mode writes it to stderr). */
  error?: string;
}

function prefixFailure(message: string): PrefixRenameRunResult {
  return { exitCode: 1, json: { success: false, error: message }, lines: [], error: message };
}

function prefixSuccess(
  report: PrefixRenameReport,
  lines: string[] = formatPrefixRenameReport(report),
): PrefixRenameRunResult {
  return { exitCode: 0, json: report as unknown as Record<string, unknown>, lines };
}

/**
 * Run `wl doctor prefix` end to end.
 *
 * Flow: validate `--to`; build the read-only preview; stop there unless an
 * apply was requested (`--apply`/`--confirm`); run the confirmation gate
 * (fail closed without a TTY when `--confirm` is absent); no-op on replay; then
 * apply the transactional rewrite plus config and rename map.
 */
export async function runPrefixRename(
  deps: PrefixRenameRunnerDeps,
): Promise<PrefixRenameRunResult> {
  const fromPrefix = deps.opts.prefix || deps.configPrefix || 'WI';
  const toPrefix = deps.opts.to !== undefined ? String(deps.opts.to) : fromPrefix;

  const validation = validateTargetPrefix(toPrefix);
  if (!validation.valid) {
    return prefixFailure(validation.error || 'Invalid target prefix.');
  }

  const preview = buildPrefixRenamePreview({
    items: deps.db.getAll(),
    comments: deps.db.getAllComments(),
    edges: deps.db.getAllDependencyEdges(),
    audits: deps.db.getAllAuditResults(),
    fromPrefix,
    toPrefix,
  });

  // Preview is the default; only an explicit apply request can write.
  if (!deps.opts.apply && !deps.opts.confirm) {
    return prefixSuccess(buildPrefixRenameReport({ preview, dryRun: true, applied: false }));
  }

  const decision = decidePrefixConfirmation({
    confirm: Boolean(deps.opts.confirm),
    stdinIsTTY: deps.stdinIsTTY,
  });
  let proceed = decision.proceed;
  if (!proceed && decision.prompt) {
    const answer = await deps.prompt(
      `Rename ${preview.counts.items} work item ID(s) from ${fromPrefix} to ${toPrefix}? (y/N): `,
    );
    proceed = decidePrefixConfirmation({ confirm: false, stdinIsTTY: true, answer }).proceed;
  }

  if (!proceed) {
    if (!decision.prompt && !deps.opts.confirm) {
      return prefixFailure(
        'Refusing to rewrite work item IDs without confirmation in a non-interactive session. ' +
        'Re-run with --confirm to apply the rename (preview is the default without --apply/--confirm).',
      );
    }
    // Interactive decline: no writes, exit cleanly.
    return prefixSuccess(buildPrefixRenameReport({ preview, dryRun: true, applied: false }));
  }

  // Idempotent replay: the store already carries the target prefix.
  if (fromPrefix === toPrefix) {
    const replay = buildPrefixRenameReport({
      preview,
      dryRun: false,
      applied: false,
      counts: emptyPrefixRenameCounts(),
    });
    return prefixSuccess(replay, [formatPrefixRenameReplay(toPrefix)]);
  }

  if (!fs.existsSync(deps.configPath)) {
    return prefixFailure(`Refusing to rename: no config file found at ${deps.configPath}.`);
  }

  const worklogDir = path.dirname(deps.dataPath);
  const plan = applyPrefixRenamePlan({
    preview,
    dbPath: path.join(worklogDir, 'worklog.db'),
    configPath: deps.configPath,
    worklogDir,
    withMutationLock: deps.withMutationLock,
    now: deps.now,
  });

  return prefixSuccess(
    buildPrefixRenameReport({
      preview,
      dryRun: false,
      applied: true,
      counts: plan.counts,
      renameMapPath: plan.renameMapPath,
    }),
  );
}


/** Input to {@link applyPrefixRenamePlan}. */
export interface PrefixRenamePlanInput {
  /** Preview previously built from the same store snapshot. */
  preview: PrefixRenamePreview;
  dbPath: string;
  configPath: string;
  worklogDir: string;
  /** Serialise the write with the CLI's other store mutations. */
  withMutationLock: <T>(fn: () => T) => T;
  /** Clock override (rename-map filename/timestamp). */
  now?: Date;
}

/** Result of an applied rename plan. */
export interface PrefixRenamePlanResult {
  counts: PrefixRenameCounts;
  renameMapPath: string;
}

/**
 * Apply a rename atomically: store rows + config prefix in the SQLite
 * transaction, then the rename map. The apply path always writes (the config
 * prefix moves even when an empty store has no IDs to rewrite), so a rename
 * map is always recorded.
 */
export function applyPrefixRenamePlan(input: PrefixRenamePlanInput): PrefixRenamePlanResult {
  const { preview, dbPath, configPath, worklogDir, withMutationLock } = input;
  return withMutationLock(() => {
    const applied = applyPrefixRename({
      dbPath,
      fromPrefix: preview.fromPrefix,
      toPrefix: preview.toPrefix,
      beforeCommit: () => rewriteConfigPrefix(configPath, preview.toPrefix),
      onFailure: () => rewriteConfigPrefix(configPath, preview.fromPrefix),
    });
    const renameMapPath = writePrefixRenameMap(
      worklogDir,
      buildPrefixRenameMap(preview.fromPrefix, preview.toPrefix, applied.ids),
      input.now,
    );
    return { counts: applied.counts, renameMapPath };
  });
}
