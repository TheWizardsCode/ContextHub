/**
 * lib/scheduler.ts — Periodic request scheduler for the Worklog Pi extension.
 *
 * Provides:
 * - A minimal cron expression parser (5-field standard cron)
 * - A Scheduler class that periodically checks schedules and submits requests
 *   via pi.sendUserMessage() when the agent is idle
 * - A CLI command handler for managing schedules (/wl schedule)
 *
 * Cron format: minute hour day-of-month month day-of-week
 *   minute:       0-59
 *   hour:         0-23
 *   day-of-month: 1-31
 *   month:        1-12
 *   day-of-week:  0-7 (0 and 7 are Sunday)
 *
 * Supported syntax:
 *   *        - wildcard (every value)
 *   N        - exact value
 *   N,M      - list of values
 *   N-M      - range of values (inclusive)
 *   step(N)  - step with wildcard (e.g. asterisk-slash-5 = every 5 minutes)
 *   N-M/step - step with range (e.g. 1-30/10 = 1,11,21)
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { currentSettings } from './settings.js';

// ── Types ─────────────────────────────────────────────────────────────

/**
 * A schedule entry that maps a cron expression to a pi request.
 */
export interface ScheduleEntry {
  /** Unique identifier for this schedule. */
  id: string;
  /** Cron expression (5-field standard cron). */
  cron: string;
  /** The pi request text to submit when the schedule fires. */
  request: string;
  /** Optional human-readable label for display. */
  label?: string;
  /** Whether this schedule is enabled. */
  enabled: boolean;
}

/**
 * Raw schedule entry as stored in settings (before validation).
 */
export interface RawScheduleEntry {
  id?: string;
  cron: string;
  request: string;
  label?: string;
  enabled?: boolean;
}

/**
 * Options for the Scheduler constructor.
 */
export interface SchedulerOptions {
  /**
   * Custom function to check if the agent is idle.
   * Defaults to checking from the extension context.
   */
  isIdleFn?: () => boolean;
  /**
   * Custom tick interval in milliseconds.
   * Default: 30000 (30 seconds).
   */
  tickIntervalMs?: number;
  /**
   * Custom now function for testing.
   */
  nowFn?: () => Date;
}

// ── Cron expression parsing ───────────────────────────────────────────

/** Maximum valid values for each cron field. */
const FIELD_MAX: Record<number, number> = {
  0: 59, // minute
  1: 23, // hour
  2: 31, // day of month
  3: 12, // month
  4: 7,  // day of week (0-7, both 0 and 7 = Sunday)
};

/** Number of fields in a standard cron expression. */
const CRON_FIELDS = 5;

/**
 * Parse a single cron field value (e.g., "star-slash-15", "1-5", "1,3,5", "10").
 *
 * Returns an array of matching numeric values for the given field index.
 * Field index: 0=minute, 1=hour, 2=day-of-month, 3=month, 4=day-of-week.
 */
function parseCronField(field: string, fieldIndex: number): number[] {
  const max = FIELD_MAX[fieldIndex];
  const trimmed = field.trim();

  if (!trimmed) throw new Error(`Empty field at position ${fieldIndex}`);

  // Step pattern: */N or N-M/N
  const stepMatch = trimmed.match(/^(\*|\d+-\d+)\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[2], 10);
    if (step <= 0 || !Number.isFinite(step)) {
      throw new Error(`Invalid step value '${stepMatch[2]}' at position ${fieldIndex}`);
    }

    if (stepMatch[1] === '*') {
      // */N — step through all values
      const result: number[] = [];
      for (let i = 0; i <= max; i += step) {
        result.push(i);
      }
      return result;
    }

    // range/N — step through range
    const rangeParts = stepMatch[1].split('-');
    const rangeStart = parseInt(rangeParts[0], 10);
    const rangeEnd = parseInt(rangeParts[1], 10);
    if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) {
      throw new Error(`Invalid range '${stepMatch[1]}' at position ${fieldIndex}`);
    }
    const result: number[] = [];
    for (let i = rangeStart; i <= rangeEnd; i += step) {
      if (i >= 0 && i <= max) result.push(i);
    }
    return result;
  }

  // Comma-separated list: N,M or N-M,M or combinations
  if (trimmed.includes(',')) {
    return trimmed.split(',').flatMap(part => parseCronField(part, fieldIndex));
  }

  // Range: N-M
  const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`Invalid range '${trimmed}' at position ${fieldIndex}`);
    }
    const result: number[] = [];
    for (let i = start; i <= end; i++) {
      if (i >= 0 && i <= max) result.push(i);
    }
    return result;
  }

  // Wildcard
  if (trimmed === '*') {
    const result: number[] = [];
    for (let i = 0; i <= max; i++) {
      result.push(i);
    }
    return result;
  }

  // Single number
  const num = parseInt(trimmed, 10);
  if (!Number.isFinite(num) || num < 0 || num > max) {
    throw new Error(`Invalid value '${trimmed}' at position ${fieldIndex} (expected 0-${max})`);
  }
  return [num];
}

/**
 * Parse a cron expression string into arrays of valid values for each field.
 *
 * @param expr - 5-field cron expression
 * @returns Array of 5 number arrays, each containing matching values
 * @throws Error if the expression is invalid
 */
export function parseCronExpression(expr: string): number[][] {
  const fields = expr.trim().split(/\s+/);

  if (fields.length !== CRON_FIELDS) {
    throw new Error(
      `Invalid cron expression: expected ${CRON_FIELDS} fields, got ${fields.length}. ` +
      'Format: minute hour day-of-month month day-of-week',
    );
  }

  return fields.map((field, index) => parseCronField(field, index));
}

/**
 * Check if a cron expression matches a given date.
 *
 * @param expr - 5-field cron expression
 * @param date - The date to check
 * @returns true if the cron expression matches the date's fields
 * @throws Error if the cron expression is invalid
 */
export function cronMatch(expr: string, date: Date): boolean {
  const parsed = parseCronExpression(expr);

  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dayOfMonth = date.getUTCDate();
  const month = date.getUTCMonth() + 1; // getUTCMonth() is 0-indexed
  const dayOfWeek = date.getUTCDay(); // 0=Sunday

  // Check each field
  if (!parsed[0].includes(minute)) return false;
  if (!parsed[1].includes(hour)) return false;
  if (!parsed[2].includes(dayOfMonth)) return false;
  if (!parsed[3].includes(month)) return false;

  // Day of week: 0 and 7 both represent Sunday
  if (!parsed[4].includes(dayOfWeek) && !(dayOfWeek === 0 && parsed[4].includes(7))) {
    return false;
  }

  return true;
}

/**
 * Validate a cron expression string.
 *
 * Returns true if the expression is a valid 5-field cron expression,
 * false otherwise (no throw).
 */
export function validateCronExpression(expr: string): boolean {
  if (!expr || typeof expr !== 'string') return false;
  try {
    parseCronExpression(expr);
    return true;
  } catch {
    return false;
  }
}

// ── Schedule entry management ─────────────────────────────────────────

let _idCounter = 0;

/**
 * Generate a unique schedule ID.
 */
function generateId(): string {
  _idCounter++;
  return `sched-${Date.now().toString(36)}-${_idCounter}`;
}

/**
 * Parse and validate a raw schedule entry from settings.
 *
 * @param raw - Raw schedule entry from settings
 * @returns A validated ScheduleEntry
 * @throws Error if the entry is invalid
 */
export function parseScheduleEntry(raw: RawScheduleEntry): ScheduleEntry {
  if (!raw.cron || typeof raw.cron !== 'string') {
    throw new Error('Schedule entry missing required field: cron');
  }
  if (!raw.request || typeof raw.request !== 'string') {
    throw new Error('Schedule entry missing required field: request');
  }

  // Validate cron expression
  if (!validateCronExpression(raw.cron)) {
    throw new Error(`Invalid cron expression: '${raw.cron}'`);
  }

  return {
    id: raw.id || generateId(),
    cron: raw.cron,
    request: raw.request,
    label: raw.label || undefined,
    enabled: raw.enabled !== false, // default to true
  };
}

/**
 * Get the current schedules from settings.
 */
export function getSchedules(): ScheduleEntry[] {
  const raw = currentSettings.schedules;
  if (!raw || !Array.isArray(raw)) return [];

  return raw
    .map((entry: any) => {
      try {
        return parseScheduleEntry(entry);
      } catch {
        // Skip invalid entries
        return null;
      }
    })
    .filter((entry: ScheduleEntry | null): entry is ScheduleEntry => entry !== null);
}

// ── Settings persistence ──────────────────────────────────────────────

/**
 * Persist schedules to settings.
 *
 * This is a lightweight wrapper that uses the config module's update
 * mechanism. Injected via the schedule command handler.
 */
let _persistSchedules: ((schedules: RawScheduleEntry[]) => void) | null = null;

/**
 * Set the persistence function for schedules.
 * Called by the extension during initialization.
 */
export function setSchedulePersister(
  persister: (schedules: RawScheduleEntry[]) => void,
): void {
  _persistSchedules = persister;
}

/**
 * Save schedules to persistent settings.
 */
function saveSchedules(schedules: RawScheduleEntry[]): void {
  if (_persistSchedules) {
    _persistSchedules(schedules);
  }
}

// ── Scheduler class ───────────────────────────────────────────────────

/**
 * Periodic request scheduler.
 *
 * Manages a background interval that periodically checks configured schedules
 * and submits pi requests when the agent is idle.
 *
 * Tracks agent idle state internally via pi lifecycle events. The scheduler
 * only fires when the agent is confirmed idle (no active streaming, no tool
 * execution in progress).
 */
export class Scheduler {
  private _interval: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _lastFires: Map<string, number> = new Map();
  private _options: Required<SchedulerOptions>;
  private _pi: ExtensionAPI;
  private _agentBusy = false;

  constructor(
    pi: ExtensionAPI,
    options: SchedulerOptions = {},
  ) {
    this._pi = pi;
    this._options = {
      isIdleFn: options.isIdleFn ?? (() => !this._agentBusy),
      tickIntervalMs: options.tickIntervalMs ?? 30000,
      nowFn: options.nowFn ?? (() => new Date()),
    };

    // Track agent idle state via pi lifecycle events
    pi.on('turn_start', () => {
      this._agentBusy = true;
    });

    pi.on('message_end', () => {
      this._agentBusy = false;
    });

    pi.on('tool_execution_start', () => {
      this._agentBusy = true;
    });

    pi.on('tool_execution_end', () => {
      this._agentBusy = false;
    });
  }

  /**
   * Start the scheduler. Creates a background interval that periodically
   * checks schedules and submits requests when the agent is idle.
   *
   * Safe to call multiple times — subsequent calls are no-ops if already
   * running.
   */
  start(): void {
    if (this._running) return;
    this._running = true;
    this._interval = setInterval(() => {
      void this.tick();
    }, this._options.tickIntervalMs);
  }

  /**
   * Stop the scheduler. Clears the background interval.
   *
   * Safe to call even if the scheduler is not running.
   */
  stop(): void {
    this._running = false;
    if (this._interval !== null) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  /**
   * Check if the scheduler is currently running.
   */
  isRunning(): boolean {
    return this._running;
  }

  /**
   * Execute a single tick: check all schedules and fire any that match.
   *
   * Exposed as a public method so it can be called in tests without
   * waiting for the interval.
   */
  async tick(): Promise<void> {
    const now = this._options.nowFn();
    const schedules = getSchedules();
    const currentMinuteKey = this._getMinuteKey(now);

    for (const schedule of schedules) {
      if (!schedule.enabled) continue;

      try {
        if (!cronMatch(schedule.cron, now)) continue;
      } catch {
        // Invalid cron expression in stored schedule — skip silently
        continue;
      }

      // Check if already fired in this minute
      const lastFireKey = `${schedule.id}:${currentMinuteKey}`;
      if (this._lastFires.has(lastFireKey)) continue;

      // Mark as fired to prevent duplicate
      this._lastFires.set(lastFireKey, now.getTime());

      // Check if agent is idle
      if (!this._options.isIdleFn()) continue;

      // Submit the request through pi's normal message flow
      this._pi.sendUserMessage(schedule.request, { deliverAs: 'steer' });
    }
  }

  /**
   * Clear tracked last-fire times. Used in tests to simulate advancing time.
   */
  clearLastFires(): void {
    this._lastFires.clear();
  }

  /**
   * Get a minute-level key string for duplicate-fire detection.
   * Format: "YYYY-MM-DDTHH:mm"
   */
  private _getMinuteKey(date: Date): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    const h = String(date.getUTCHours()).padStart(2, '0');
    const min = String(date.getUTCMinutes()).padStart(2, '0');
    return `${y}-${m}-${d}T${h}:${min}`;
  }
}

// ── CLI command handler ───────────────────────────────────────────────

/**
 * Help text for the /wl schedule command.
 */
const SCHEDULE_HELP = `Usage: /wl schedule <subcommand> [args]

Subcommands:
  list                          List all configured schedules
  add <cron> <request>          Add a new schedule
    [--label <label>]             Optional label for display
  remove <id>                   Remove a schedule by its ID
  toggle <id>                   Enable or disable a schedule by its ID
  help                          Show this help text

Examples:
  /wl schedule add "0 1 * * *" "Run daily audit" --label "Daily audit"
  /wl schedule add "*/15 * * * *" "Check work items"
  /wl schedule list
  /wl schedule remove sched-abc123-1
  /wl schedule toggle sched-abc123-1

Cron format: minute hour day-of-month month day-of-week
  *  *  *  *  *  command to execute
  |  |  |  |  └─ day of week (0-7, 0 and 7 are Sunday)
  |  |  |  └──── month (1-12)
  |  |  └─────── day of month (1-31)
  |  └────────── hour (0-23)
  └───────────── minute (0-59)

Supported syntax: *, N, N-M, N,M, */N, N-M/N`;

/**
 * Handle the /wl schedule command.
 *
 * @param args - The raw argument string after "/wl schedule"
 * @returns A user-facing message string describing the result
 */
export function scheduleCliCommand(args: string): string {
  const trimmed = (args || '').trim();
  const parts = trimmed.split(/\s+/);

  const subcommand = parts[0]?.toLowerCase() || 'list';

  switch (subcommand) {
    case 'list': {
      const schedules = getSchedules();
      if (schedules.length === 0) {
        return 'No schedules configured. Use "add" to create one.';
      }

      const lines = schedules.map((s, i) => {
        const status = s.enabled ? '✓' : '✗';
        const label = s.label ? ` "${s.label}"` : '';
        return `${i + 1}. [${status}] ${s.id}${label}\n   Cron: ${s.cron}\n   Request: ${s.request}`;
      });
      return lines.join('\n\n');
    }

    case 'add': {
      // Parse: add "<cron>" "<request>" [--label <label>]
      // The cron and request may be quoted. Use a simple manual parser.
      const addArgs = parseQuotedArgs(trimmed.slice(3).trim());
      if (addArgs.length < 2) {
        return 'Error: Usage: add "<cron>" "<request>" [--label <label>]';
      }

      const cronStr = addArgs[0];
      const requestStr = addArgs[1];
      const labelIdx = addArgs.indexOf('--label');
      const labelStr = labelIdx >= 0 && labelIdx + 1 < addArgs.length ? addArgs[labelIdx + 1] : undefined;

      if (!validateCronExpression(cronStr)) {
        return `Error: Invalid cron expression: '${cronStr}'`;
      }

      const currentSchedules = getSchedules();
      const newEntry: RawScheduleEntry = {
        cron: cronStr,
        request: requestStr,
        enabled: true,
        label: labelStr,
      };

      try {
        const validated = parseScheduleEntry(newEntry);
        currentSchedules.push(validated);
        saveSchedules(currentSchedules);
        return `Schedule added: ${validated.id} — Cron: ${cronStr}, Request: ${requestStr}`;
      } catch (err: any) {
        return `Error adding schedule: ${err.message}`;
      }
    }

    case 'remove': {
      if (parts.length < 2) {
        return 'Error: Usage: remove <id>';
      }
      const removeId = parts[1];
      const currentSchedules = getSchedules();
      const index = currentSchedules.findIndex(s => s.id === removeId);
      if (index === -1) {
        return `Error: Schedule '${removeId}' not found`;
      }
      const removed = currentSchedules.splice(index, 1)[0];
      saveSchedules(currentSchedules);
      return `Schedule removed: ${removed.id} (${removed.cron})`;
    }

    case 'toggle': {
      if (parts.length < 2) {
        return 'Error: Usage: toggle <id>';
      }
      const toggleId = parts[1];
      const currentSchedules = getSchedules();
      const found = currentSchedules.find(s => s.id === toggleId);
      if (!found) {
        return `Error: Schedule '${toggleId}' not found`;
      }
      found.enabled = !found.enabled;
      saveSchedules(currentSchedules);
      return `Schedule ${toggleId} is now ${found.enabled ? 'enabled' : 'disabled'}`;
    }

    case 'help': {
      return SCHEDULE_HELP;
    }

    default: {
      return `Unknown subcommand: '${subcommand}'.\n\n${SCHEDULE_HELP}`;
    }
  }
}

/**
 * Parse quoted arguments from a command string.
 *
 * Handles double-quoted strings (with escaped quotes) and unquoted tokens.
 *
 * @param input - The input string to parse
 * @returns Array of argument strings
 */
function parseQuotedArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < input.length) {
    const c = input[i];

    if (inQuotes) {
      if (c === '\\' && i + 1 < input.length && input[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        // End of quoted string
        inQuotes = false;
        i++;
        continue;
      }
      current += c;
      i++;
      continue;
    }

    // Not in quotes
    if (c === '"') {
      if (current.trim()) {
        args.push(current.trim());
      }
      current = '';
      inQuotes = true;
      i++;
      continue;
    }

    if (c === ' ') {
      if (current.trim()) {
        args.push(current.trim());
      }
      current = '';
      i++;
      continue;
    }

    current += c;
    i++;
  }

  // Flush remaining
  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

// ── Extension lifecycle integration ───────────────────────────────────

/**
 * Register the periodic request scheduler with a pi extension instance.
 *
 * This function:
 * 1. Starts the scheduler on session_start
 * 2. Stops the scheduler on session_shutdown
 *
 * NOTE: The /wl schedule subcommand is registered by index.ts as part of
 * the existing /wl command handler. This function only handles the
 * background lifecycle.
 *
 * @returns The created Scheduler instance (useful for testing)
 */
export function registerScheduler(
  pi: ExtensionAPI,
  options: SchedulerOptions = {},
): Scheduler {
  const scheduler = new Scheduler(pi, options);

  // Start scheduler on session_start
  pi.on('session_start', () => {
    scheduler.start();
  });

  // Stop scheduler on session_shutdown
  pi.on('session_shutdown', () => {
    scheduler.stop();
  });

  return scheduler;
}