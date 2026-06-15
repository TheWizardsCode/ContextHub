/**
 * Settings loader for the Worklog Pi extension.
 *
 * Reads `settings.json` from the extension directory at initialization,
 * validates the schema with graceful degradation for missing/malformed files,
 * and provides defaults for missing values.
 *
 * Follows the same pattern as `shortcut-config.ts`.
 *
 * Config entry schema:
 * - browseItemCount (number): Number of work items to show in the browse list (1–50, default: 5)
 * - showIcons (boolean): Whether to show emoji icons in the browse list (default: true)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Settings interface for the Worklog Pi extension.
 */
export interface Settings {
  /** Number of work items to show in the browse list (1–50). */
  browseItemCount: number;
  /** Whether to show emoji icons in the browse list and preview widget. */
  showIcons: boolean;
}

/**
 * Default settings used when settings.json is missing or invalid.
 */
export const DEFAULT_SETTINGS: Settings = {
  browseItemCount: 5,
  showIcons: true,
};

/**
 * Validate a parsed value as a number, clamping to [min, max].
 *
 * Returns the clamped number if valid, or `defaultValue` if the input is
 * not a valid finite number (including strings like "abc", null, undefined).
 */
function validateNumber(
  value: unknown,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.max(min, Math.min(max, parsed));
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(min, Math.min(max, value));
  }
  return defaultValue;
}

/**
 * Validate a parsed value as a boolean.
 *
 * Accepts actual `true`/`false`, or the strings `"true"`/`"false"`.
 * Returns `defaultValue` for any other value.
 */
function validateBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return defaultValue;
}

/**
 * Load and validate settings from settings.json.
 *
 * - Missing file → returns DEFAULT_SETTINGS (graceful degradation)
 * - Malformed JSON → returns DEFAULT_SETTINGS with console.error (no crash)
 * - Partial file → missing fields are filled from DEFAULT_SETTINGS
 * - Invalid values → clamped or replaced with defaults
 *
 * @returns A Settings object with all fields populated
 */
export function loadSettings(): Settings {
  const configPath = join(__dirname, 'settings.json');

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    // File not found — graceful degradation, return defaults
    return { ...DEFAULT_SETTINGS };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[settings-config] Malformed settings.json: unable to parse JSON');
    return { ...DEFAULT_SETTINGS };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    console.error('[settings-config] settings.json must be a JSON object');
    return { ...DEFAULT_SETTINGS };
  }

  return {
    browseItemCount: validateNumber(
      parsed.browseItemCount,
      DEFAULT_SETTINGS.browseItemCount,
      1,
      50,
    ),
    showIcons: validateBoolean(
      parsed.showIcons,
      DEFAULT_SETTINGS.showIcons,
    ),
  };
}
