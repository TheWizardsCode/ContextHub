/**
 * packages/herdr/src/scheduled-prompts.ts — Scheduled-prompts config for the
 * downtime dispatcher (WL-0MSS1Q5ER007QDKX)
 *
 * Project-local config file consumed by the downtime worker's scheduled-
 * prompts tier: `<cwd>/.worklog/scheduled-prompts.json` (provisioned by
 * `wl init` from `templates/scheduled-prompts.json`, create-if-absent).
 *
 * Each entry carries:
 *  - a stable `id` (used for the pane name `Downtime <id>` and the rolling
 *    log marker itemId),
 *  - the `prompt` text (any text the pi agent pane can run, e.g.
 *    `/skill:refactor`),
 *  - a best-effort `intervalDays` frequency (whole days; a delayed dispatch
 *    never fires more often than the frequency),
 *  - `lastTriggeredAt` (ISO-8601 UTC datetime; `null` = never run).
 *
 * Fail-closed philosophy (mirrors settings.ts + the downtime worker): an
 * absent config is an EMPTY set (logged notice — `wl init` is the
 * provisioning path); a malformed config is an EMPTY set (logged error);
 * an invalid entry is skipped (logged warning). None of these ever throw
 * or crash the worker.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** File name of the scheduled-prompts config inside `.worklog/`. */
export const SCHEDULED_PROMPTS_FILE = 'scheduled-prompts.json';

/** One day in milliseconds (best-effort frequency granularity is whole days). */
export const DAY_MS = 24 * 60 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────

/** One scheduled-prompt entry from the config file. */
export interface ScheduledPrompt {
  /** Stable entry id (pane name `Downtime <id>`, rolling-log marker itemId). */
  id: string;
  /** Prompt text run by the pi agent pane (any text, e.g. `/skill:refactor`). */
  prompt: string;
  /** Best-effort frequency in whole days (> 0). */
  intervalDays: number;
  /** ISO-8601 UTC datetime of the last dispatch; null = never run. */
  lastTriggeredAt: string | null;
}

/** Root shape of `.worklog/scheduled-prompts.json`. */
export interface ScheduledPromptsConfig {
  entries: ScheduledPrompt[];
}

/** Result of loading the config (entries are ALWAYS the valid subset). */
export interface ScheduledPromptsLoadResult {
  entries: ScheduledPrompt[];
  /** true when the config file was absent (fail-closed empty set, notice logged). */
  absent: boolean;
  /** true when the file existed but could not be parsed (fail-closed empty set, error logged). */
  malformed: boolean;
}

/** Injectable logger (defaults to the plugin's stderr channel). */
export type ScheduledPromptLog = (message: string) => void;

/**
 * Default logger: the plugin's established `[worklog-plugin]` stderr
 * channel. Fail-closed logging must never crash the worker, so a throwing
 * logger is a non-issue here (these writes are best-effort diagnostics).
 */
export function defaultScheduledPromptLog(message: string): void {
  process.stderr.write(`[worklog-plugin] ${message}\n`);
}

// ── Path / parse ──────────────────────────────────────────────────────

/** Resolve the config file path for a worklog ROOT (`<cwd>/.worklog/...`). */
export function scheduledPromptsPath(cwd: string): string {
  return join(cwd, '.worklog', SCHEDULED_PROMPTS_FILE);
}

/**
 * Parse one raw config entry into a typed `ScheduledPrompt`, or null when
 * the entry is invalid (fail-closed, AC7):
 *
 *  - id must be a non-empty string,
 *  - prompt text must be a non-empty (non-whitespace) string,
 *  - intervalDays must be a finite number > 0,
 *  - lastTriggeredAt must be null, absent (⇒ normalized to null = due), or
 *    an ISO-8601 string; a non-string or unparseable value rejects the
 *    whole entry (skipped with a warning — never a crash).
 */
export function parseScheduledPrompt(entry: unknown): ScheduledPrompt | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const o = entry as Record<string, unknown>;

  if (typeof o.id !== 'string' || o.id.length === 0) return null;
  if (typeof o.prompt !== 'string' || o.prompt.trim().length === 0) return null;
  if (typeof o.intervalDays !== 'number' || !Number.isFinite(o.intervalDays) || o.intervalDays <= 0) {
    return null;
  }

  let lastTriggeredAt: string | null = null;
  if (o.lastTriggeredAt !== undefined && o.lastTriggeredAt !== null) {
    if (typeof o.lastTriggeredAt !== 'string') return null;
    if (Number.isNaN(new Date(o.lastTriggeredAt).getTime())) return null;
    lastTriggeredAt = o.lastTriggeredAt;
  }

  return { id: o.id, prompt: o.prompt, intervalDays: o.intervalDays, lastTriggeredAt };
}

/** Parse predicate: true when the entry is a valid scheduled prompt. */
export function isValidScheduledPrompt(entry: unknown): entry is ScheduledPrompt {
  return parseScheduledPrompt(entry) !== null;
}

// ── Due check (AC3: due iff null or now - last >= intervalDays) ───────

/**
 * Due-check for ONE entry (best-effort frequency): due iff
 * `lastTriggeredAt` is null (never run) or the interval has fully elapsed
 * (`now - last >= intervalDays * DAY_MS`). A `lastTriggeredAt` in the
 * future (clock skew) is not due.
 */
export function isDueScheduledPrompt(entry: ScheduledPrompt, now: number = Date.now()): boolean {
  if (entry.lastTriggeredAt === null) return true;
  const last = new Date(entry.lastTriggeredAt).getTime();
  // Defensive: an unparseable timestamp (constructed directly, bypassing
  // parseScheduledPrompt) is NaN → never due (fail-closed).
  if (Number.isNaN(last)) return false;
  return now - last >= entry.intervalDays * DAY_MS;
}

/**
 * Select the first due entry in CONFIG ORDER (AC6/AC7): entries dispatch
 * one per idle slot in config order. Returns null when none are due.
 */
export function getDueScheduledPrompt(
  entries: ScheduledPrompt[],
  now: number = Date.now(),
): ScheduledPrompt | null {
  return entries.find((entry) => isDueScheduledPrompt(entry, now)) ?? null;
}

// ── Load (AC2: absent ⇒ empty + notice; malformed ⇒ empty + error) ────

/**
 * Load the scheduled-prompts config for a worklog root, fail-closed:
 *
 *  - absent file ⇒ `{ entries: [], absent: true }` with a logged notice
 *    (`wl init` is the provisioning path — no synthesis of defaults here),
 *  - unreadable/corrupt JSON/wrong shape ⇒ `{ entries: [], malformed: true }`
 *    with a logged error,
 *  - valid file ⇒ the VALID entries (invalid ones are skipped with a logged
 *    warning, AC7 — never a crash).
 *
 * Never throws.
 */
export function loadScheduledPrompts(
  cwd: string,
  log: ScheduledPromptLog = defaultScheduledPromptLog,
): ScheduledPromptsLoadResult {
  const file = scheduledPromptsPath(cwd);

  if (!existsSync(file)) {
    log(
      `scheduled-prompts: config file absent at ${file} — treating the ` +
        `scheduled-prompt set as empty (fail-closed; run \`wl init\` to provision).`,
    );
    return { entries: [], absent: true, malformed: false };
  }

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    log(
      `scheduled-prompts: unreadable config at ${file} (${(err as Error).message}) — ` +
        `no scheduled dispatch (fail-closed).`,
    );
    return { entries: [], absent: false, malformed: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log(
      `scheduled-prompts: malformed JSON in ${file} — no scheduled dispatch (fail-closed).`,
    );
    return { entries: [], absent: false, malformed: true };
  }

  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    log(
      `scheduled-prompts: config at ${file} has no entries list — no scheduled ` +
        `dispatch (fail-closed).`,
    );
    return { entries: [], absent: false, malformed: true };
  }

  const entries: ScheduledPrompt[] = [];
  const rawEntries = (parsed as { entries: unknown[] }).entries;
  for (const [index, rawEntry] of rawEntries.entries()) {
    const entry = parseScheduledPrompt(rawEntry);
    if (entry === null) {
      log(
        `scheduled-prompts: skipping invalid entry #${index + 1} in ${file} ` +
          `(missing/invalid id, prompt, intervalDays, or lastTriggeredAt) — fail-closed.`,
      );
      continue;
    }
    entries.push(entry);
  }
  return { entries, absent: false, malformed: false };
}

// ── Atomic persist (AC4: tmp+rename; failures fail closed) ───────────

/**
 * Atomically write the config file: write to a unique tmp file in the same
 * directory, then rename over the target (a reader never sees a partial
 * write). Creates `.worklog/` when missing. Throws on failure — callers
 * (updateScheduledPromptLastTriggered) catch and fail closed.
 */
export async function saveScheduledPrompts(cwd: string, config: ScheduledPromptsConfig): Promise<void> {
  const dir = join(cwd, '.worklog');
  const file = scheduledPromptsPath(cwd);
  await mkdir(dir, { recursive: true });
  const tmp = join(
    dir,
    `${SCHEDULED_PROMPTS_FILE}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/**
 * Persist a scheduled prompt's `lastTriggeredAt` (atomic tmp+rename) after a
 * successful dispatch, so a delayed dispatch never fires more often than its
 * frequency. Re-reads the RAW file immediately before writing
 * (last-writer-wins vs a concurrent user edit is the accepted risk) and
 * preserves ALL other fields verbatim — including entries the loader would
 * skip as invalid, so a runtime write never silently deletes user config.
 *
 * Resolves FALSE on any failure (absent/malformed file, unknown id, I/O
 * error) — the caller ABORTS the spawn (an unrecorded dispatch never runs)
 * and the entry stays due for the next idle slot. Never throws.
 */
export async function updateScheduledPromptLastTriggered(
  cwd: string,
  id: string,
  at: string,
): Promise<boolean> {
  try {
    const file = scheduledPromptsPath(cwd);
    if (!existsSync(file)) return false; // removed while we looked — fail closed
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return false;
    const root = parsed as Record<string, unknown>;
    if (!Array.isArray(root.entries)) return false;

    const idx = (root.entries as unknown[]).findIndex(
      (entry) => typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).id === id,
    );
    if (idx < 0) return false; // unknown id — fail closed
    (root.entries[idx] as Record<string, unknown>).lastTriggeredAt = at;

    await saveScheduledPrompts(cwd, root as unknown as ScheduledPromptsConfig);
    return true;
  } catch {
    // Fail-closed: any I/O/parse error means the state could not be
    // persisted — the dispatch must not proceed unrecorded.
    return false;
  }
}