/**
 * lib/guardrails.ts — Guardrails to protect Worklog data integrity.
 *
 * Provides protection mechanisms to prevent accidental corruption of
 * work item data or the worklog database via pi agent tool calls:
 *
 * 1. Blocks direct write/edit tool calls to protected worklog paths
 * 2. Blocks dangerous shell commands that could damage worklog data
 * 3. Supports toggling guardrails on/off via configuration
 *
 * Usage:
 *
 *   import { INSTALL_GUARDRAILS } from './guardrails.js';
 *
 *   export default function (pi: ExtensionAPI) {
 *     INSTALL_GUARDRAILS(pi);  // enabled by default
 *     // or
 *     INSTALL_GUARDRAILS(pi, { enabled: false });  // disabled
 *   }
 *
 * Protected paths:
 *   - .worklog/worklog.db        (main database)
 *   - .worklog/worklog.db-wal    (write-ahead log)
 *   - .worklog/worklog.db-shm    (shared memory)
 *   - .worklog/worklog-data.jsonl (sync data, when present)
 *
 * Dangerous commands:
 *   - rm -rf .worklog
 *   - sqlite3 .worklog/worklog.db
 *   - mv .worklog
 *   - cp .worklog
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { isToolCallEventType } from '@earendil-works/pi-coding-agent';

// ── Configuration ─────────────────────────────────────────────────────

/**
 * Guardrails configuration.
 */
export interface GuardrailsOptions {
  /** Master toggle to enable/disable all guardrails (default: true). */
  enabled?: boolean;
}

// ── Protected paths ───────────────────────────────────────────────────

/**
 * List of worklog database file patterns that should never be directly
 * written or edited by the agent.
 *
 * These are matched as suffixes on the path to protect both relative
 * paths like `.worklog/worklog.db` and absolute paths like
 * `/home/user/project/.worklog/worklog.db`.
 */
const PROTECTED_PATH_PATTERNS = [
  '.worklog/worklog.db',
  '.worklog/worklog.db-wal',
  '.worklog/worklog.db-shm',
  '.worklog/worklog-data.jsonl',
];

// ── Dangerous command patterns ────────────────────────────────────────

/**
 * Regex patterns that match shell commands capable of damaging worklog data.
 *
 * Each pattern is tested against the full command string.
 * Only patterns that explicitly target `.worklog` paths are included
 * to avoid false positives on safe commands.
 *
 * Patterns cover:
 * - rm/rmdir of .worklog directory or any file within it
 * - sqlite3 direct access to .worklog/worklog.db
 * - mv of .worklog directory or any file within it
 * - cp of .worklog directory or any file within it
 */
const DANGEROUS_COMMAND_PATTERNS = [
  // rm on .worklog directory (recursive or not)
  /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)?\.worklog(\/.*)?\b/,
  // rm on specific .worklog files (handles both dot and dash separators)
  /\brm\s+(-[a-zA-Z]*[fF]?[a-zA-Z]*\s+)?\.worklog\/worklog[-.](db|db-wal|db-shm|data\.jsonl)\b/,
  // sqlite3 direct access to worklog database files
  /\bsqlite3\s+\.worklog\/worklog[-.]db(?:-wal|-shm)?\b/,
  // mv on .worklog directory or its files
  /\bmv\s+.*\.worklog(\/.*)?\s+/,
  // cp on .worklog directory or its files (recursive copy)
  /\bcp\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)?\.worklog(\/.*)?\s+/,
];

// ── Detection functions ───────────────────────────────────────────────

/**
 * Check whether a given file path is a protected worklog file.
 *
 * The check is a suffix/ends-with approach so it works with both
 * relative paths (`.worklog/worklog.db`) and absolute paths
 * (`/home/user/project/.worklog/worklog.db`).
 *
 * @param path - The file path to check (may be relative or absolute).
 * @returns `true` if the path is a protected worklog file.
 */
export function isWorklogProtectedPath(path: string): boolean {
  if (!path || typeof path !== 'string') return false;

  const normalizedPath = path.replace(/\\/g, '/').replace(/\/$/, '');

  return PROTECTED_PATH_PATTERNS.some((pattern) =>
    normalizedPath.endsWith(pattern),
  );
}

/**
 * Check whether a shell command is a dangerous operation against
 * worklog data.
 *
 * Matches against known-dangerous patterns: rm/mv/cp of .worklog
 * directory or files, and direct sqlite3 access to the database.
 *
 * @param command - The full shell command string.
 * @returns `true` if the command is dangerous to worklog data.
 */
export function isDangerousWorklogCommand(command: string): boolean {
  if (!command || typeof command !== 'string') return false;

  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

// ── Message templates ─────────────────────────────────────────────────

const WRITE_BLOCK_MESSAGE =
  'Direct edits to worklog database files are not allowed. Use `wl` commands instead.';

const COMMAND_BLOCK_MESSAGE =
  'This command could damage worklog data. Use `wl` commands instead.';

// ── Guardrails installation ───────────────────────────────────────────

/**
 * Install guardrails into a Pi extension instance.
 *
 * Registers `tool_call` event handlers that block:
 * 1. Direct `write`/`edit` tool calls targeting protected worklog paths
 * 2. Dangerous shell commands that could damage worklog data
 *
 * When `enabled` is `false`, the handlers are still registered but
 * perform a no-op pass-through (no blocking). This allows the toggling
 * behavior without requiring dynamic handler addition/removal.
 *
 * @param pi - The ExtensionAPI instance to install guardrails into.
 * @param options - Optional configuration.
 */
export function INSTALL_GUARDRAILS(
  pi: ExtensionAPI,
  options?: GuardrailsOptions,
): void {
  const enabled = options?.enabled ?? true;

  // ── Path protection: block direct write/edit to protected files ────
  pi.on('tool_call', async (event) => {
    if (!enabled) return;

    if (
      isToolCallEventType('write', event) ||
      isToolCallEventType('edit', event)
    ) {
      const path = event.input.path as string;
      if (isWorklogProtectedPath(path)) {
        return {
          block: true as const,
          reason: WRITE_BLOCK_MESSAGE,
        };
      }
    }
  });

  // ── Command protection: block dangerous shell commands ─────────────
  pi.on('tool_call', async (event) => {
    if (!enabled) return;

    if (isToolCallEventType('bash', event)) {
      const command = event.input.command as string;
      if (isDangerousWorklogCommand(command)) {
        return {
          block: true as const,
          reason: COMMAND_BLOCK_MESSAGE,
        };
      }
    }
  });
}
