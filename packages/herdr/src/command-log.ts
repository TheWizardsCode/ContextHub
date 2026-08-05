/**
 * packages/herdr/src/command-log.ts — Plugin command log
 *
 * Records commands executed against work items within the Herdr plugin.
 * Commands are persisted to a JSON file in `~/.config/herdr/` and can be
 * queried to show the most recent command for any work item.
 *
 * Features:
 * - Atomic writes (temp file + rename) for concurrent safety
 * - Bounded size: pruned to MAX_ENTRIES_PER_ITEM per item on each write
 * - Graceful degradation: missing or corrupt files do not cause crashes
 * - Configurable log path (for tests and custom deployments)
 *
 * Log file format:
 * ```json
 * {
 *   "version": 1,
 *   "entries": {
 *     "WL-123": [
 *       { "itemId": "WL-123", "command": "/skill:audit WL-123", "timestamp": "2026-08-04T12:00:00.000Z" }
 *     ]
 *   }
 * }
 * ```
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of command entries to retain per work item. */
export const MAX_ENTRIES_PER_ITEM = 50;

/** Default log file name. */
const DEFAULT_LOG_FILENAME = 'worklog-command-log.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single command entry in the log.
 */
export interface CommandEntry {
  /** The work item ID this command was executed against. */
  itemId: string;
  /** The command string (e.g., "/skill:audit WL-123"). */
  command: string;
  /** ISO-8601 timestamp of when the command was recorded. */
  timestamp: string;
}

/**
 * The top-level structure of the command log JSON file.
 */
export interface CommandLogData {
  /** Current log format version (incremented on format changes). */
  version: number;
  /** Command entries keyed by work item ID. */
  entries: Record<string, CommandEntry[]>;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Override for the log file path. Used by tests and custom deployments.
 * When undefined, the default path (~/.config/herdr/worklog-command-log.json) is used.
 */
let _logPath: string | undefined;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Get the default command log file path.
 * Creates the config directory if it doesn't exist.
 */
function getDefaultLogPath(): string {
  const configDir = join(homedir(), '.config', 'herdr');
  if (!existsSync(configDir)) {
    try {
      mkdirSync(configDir, { recursive: true });
    } catch {
      // Ignore permission errors — fall back to default path
    }
  }
  return join(configDir, DEFAULT_LOG_FILENAME);
}

/**
 * Get the effective log file path (override or default).
 */
function getLogPath(): string {
  return _logPath ?? getDefaultLogPath();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Set a custom log file path. Used by tests and for custom deployments.
 * Pass `undefined` to reset to the default path.
 */
export function setLogPath(path: string | undefined): void {
  _logPath = path;
}

/**
 * Reset the log path to the default location.
 */
export function resetLogPath(): void {
  _logPath = undefined;
}

/**
 * Record a command executed against a work item.
 *
 * The command is appended to the log entries for the given item, and
 * the entries are pruned to MAX_ENTRIES_PER_ITEM if they exceed the limit.
 *
 * @param itemId - The work item ID this command was executed against.
 * @param command - The command string.
 */
export function recordCommand(itemId: string, command: string): void {
  const logData = loadLog();
  const entries = logData.entries[itemId] ?? [];

  // Append new entry
  entries.push({
    itemId,
    command,
    timestamp: new Date().toISOString(),
  });

  // Prune to MAX_ENTRIES_PER_ITEM (keep most recent)
  if (entries.length > MAX_ENTRIES_PER_ITEM) {
    logData.entries[itemId] = entries.slice(-MAX_ENTRIES_PER_ITEM);
  } else {
    logData.entries[itemId] = entries;
  }

  saveLog(logData);
}

/**
 * Get the most recently recorded command for a work item.
 *
 * @param itemId - The work item ID to query.
 * @returns The most recent CommandEntry, or null if no commands exist.
 */
export function getLastCommand(itemId: string): CommandEntry | null {
  const logData = loadLog();
  const entries = logData.entries[itemId];

  if (!entries || entries.length === 0) {
    return null;
  }

  // Return the last entry (most recent)
  return entries[entries.length - 1];
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Load the command log from disk.
 * Returns a fresh empty log if the file is missing, corrupt, or has the wrong format.
 */
function loadLog(): CommandLogData {
  const logPath = getLogPath();

  try {
    if (!existsSync(logPath)) {
      return { version: 1, entries: {} };
    }

    const raw = readFileSync(logPath, 'utf-8');
    if (!raw.trim()) {
      return { version: 1, entries: {} };
    }

    const parsed = JSON.parse(raw);

    // Validate structure — entries is a Record<string, CommandEntry[]>
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.entries !== 'object' ||
      parsed.entries === null ||
      Array.isArray(parsed.entries)
    ) {
      return { version: 1, entries: {} };
    }

    return { version: parsed.version ?? 1, entries: parsed.entries };
  } catch {
    // Corrupt file or read error — return fresh log
    return { version: 1, entries: {} };
  }
}

/**
 * Save the command log to disk atomically.
 *
 * Writes to a temporary file first, then renames it to the target path.
 * This prevents corruption from partial writes or concurrent access.
 */
function saveLog(logData: CommandLogData): void {
  const logPath = getLogPath();
  const dir = dirname(logPath);

  // Ensure directory exists
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Directory creation failed — fall through to direct write
    }
  }

  // Atomic write: temp file + rename
  const tempPath = logPath + '.tmp.' + process.pid;
  try {
    const content = JSON.stringify(logData, null, 2);
    writeFileSync(tempPath, content, 'utf-8');
    // On POSIX systems, rename is atomic — readers see either the old
    // or the new file, never a partially written one.
    renameSync(tempPath, logPath);
  } catch {
    // If atomic write fails, log the error but don't crash the plugin
    // The log will be re-read on next access
  } finally {
    // Clean up temp file if it still exists (rename failed or was skipped)
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {
      // Best effort cleanup
    }
  }
}
