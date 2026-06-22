/**
 * Settings loader for the Worklog Pi extension.
 *
 * Reads settings from Pi's canonical settings files under the `context-hub`
 * namespace. Resolution order (later wins):
 *   1. Built-in defaults (DEFAULT_SETTINGS)
 *   2. Global settings:  ~/.pi/agent/settings.json → { "context-hub": { ... } }
 *   3. Project settings: <cwd>/.pi/settings.json    → { "context-hub": { ... } }
 *
 * Settings are persisted to the project's .pi/settings.json when changed via
 * the `/wl settings` command.
 *
 * Follows the same namespaced-read pattern established by
 * @zosmaai/pi-llm-wiki (see packages/llm-wiki/lib/task-config.ts).
 *
 * Config entry schema:
 * - browseItemCount (number): Number of work items to show in the browse list (1–50, default: 5)
 * - showIcons (boolean): Whether to show emoji icons in the browse list (default: true)
 * - showActivityIndicator (boolean): Whether to show the activity indicator in the footer (default: true)
 * - showHelpText (boolean): Whether to show the help text line in the browse selection overlay (default: true)
 * - autoInjectEnabled (boolean): Whether to auto-inject relevant work items before agent turns (default: true)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

/**
 * Settings interface for the Worklog Pi extension.
 */
export interface Settings {
  /** Number of work items to show in the browse list (1–50). */
  browseItemCount: number;
  /** Whether to show emoji icons in the browse list and preview widget. */
  showIcons: boolean;
  /** Whether to show the activity indicator in the footer (⏵ prefix). */
  showActivityIndicator: boolean;
  /** Whether to show the help text line in the browse selection overlay. */
  showHelpText: boolean;
  /** Whether to auto-inject relevant work items into the system prompt before agent turns. */
  autoInjectEnabled: boolean;
}

/**
 * Default settings used when settings files are missing or values are not set.
 */
export const DEFAULT_SETTINGS: Settings = {
  browseItemCount: 5,
  showIcons: true,
  showActivityIndicator: true,
  showHelpText: true,
  autoInjectEnabled: true,
};

/** Namespace key used in Pi settings files for Worklog extension settings. */
const SETTINGS_NAMESPACE = 'context-hub';

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
 * Read a JSON settings file as a plain object.
 *
 * Returns `{}` when the file is absent or corrupt. Uses a single
 * try/catch (no `existsSync` pre-check) so there is no check-then-use
 * race: a missing file throws ENOENT, which the catch treats the same
 * as an empty file.
 */
function readSettingsObject(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // Missing or corrupt settings file: start from an empty object.
  }
  return {};
}

/**
 * Read settings from a Pi settings file under the `context-hub` namespace.
 *
 * Extracts and validates only the Worklog extension settings fields from
 * the namespaced section. Non-Worklog keys and other namespaces are ignored.
 *
 * @param path - Path to the Pi settings file
 * @returns Partial settings if the file has a `context-hub` section, or `{}`
 */
function readNamespacedSettings(path: string): Partial<Settings> {
  const raw = readSettingsObject(path);
  const section = raw[SETTINGS_NAMESPACE];
  if (!section || typeof section !== 'object') return {};
  const ns = section as Record<string, unknown>;

  // Only include values that are explicitly set in the namespace section.
  // Missing values should not override defaults or values from other sources
  // (global → project resolution chain).
  const result: Partial<Settings> = {};

  if (ns.browseItemCount !== undefined) {
    result.browseItemCount = validateNumber(ns.browseItemCount, DEFAULT_SETTINGS.browseItemCount, 1, 50);
  }
  if (ns.showIcons !== undefined) {
    result.showIcons = validateBoolean(ns.showIcons, DEFAULT_SETTINGS.showIcons);
  }
  if (ns.showActivityIndicator !== undefined) {
    result.showActivityIndicator = validateBoolean(ns.showActivityIndicator, DEFAULT_SETTINGS.showActivityIndicator);
  }
  if (ns.showHelpText !== undefined) {
    result.showHelpText = validateBoolean(ns.showHelpText, DEFAULT_SETTINGS.showHelpText);
  }
  if (ns.autoInjectEnabled !== undefined) {
    result.autoInjectEnabled = validateBoolean(ns.autoInjectEnabled, DEFAULT_SETTINGS.autoInjectEnabled);
  }

  return result;
}

/**
 * Load and validate settings from Pi's canonical settings files.
 *
 * Resolution order:
 *   1. Built-in defaults (DEFAULT_SETTINGS)
 *   2. Global settings:  ~/.pi/agent/settings.json → { "context-hub": { ... } }
 *   3. Project settings: <cwd>/.pi/settings.json    → { "context-hub": { ... } }
 *
 * Later sources override earlier ones (project wins over global, etc.).
 *
 * @param cwd - Project working directory (defaults to process.cwd())
 * @param agentDir - Pi agent directory (defaults to getAgentDir())
 * @returns A fully populated Settings object (no partials, never undefined)
 */
export function loadSettings(cwd?: string, agentDir?: string): Settings {
  const projectDir = cwd ?? process.cwd();

  // Resolve the Pi agent global settings directory.
  // If getAgentDir() is unavailable (e.g., outside Pi runtime), skip global.
  const globalDir: string =
    agentDir ??
    (() => {
      try {
        return getAgentDir();
      } catch {
        return '';
      }
    })();

  const globalPath = globalDir ? join(globalDir, 'settings.json') : '';
  const projectPath = join(projectDir, '.pi', 'settings.json');

  return {
    ...DEFAULT_SETTINGS,
    ...(globalPath ? readNamespacedSettings(globalPath) : {}),
    ...readNamespacedSettings(projectPath),
  };
}

/**
 * Persist settings to the project's `.pi/settings.json` under the
 * `context-hub` namespace.
 *
 * Reads the existing file (if any), merges the provided settings into the
 * `context-hub` section while preserving other namespaces and keys, and
 * writes the result back. Creates the `.pi/` directory if it does not exist.
 *
 * @param partial - Partial settings to persist
 * @param cwd - Project working directory (defaults to process.cwd())
 */
export function persistSettings(partial: Partial<Settings>, cwd?: string): void {
  const projectDir = cwd ?? process.cwd();
  const settingsPath = join(projectDir, '.pi', 'settings.json');

  try {
    const raw = readSettingsObject(settingsPath);

    const existing = raw[SETTINGS_NAMESPACE];
    const section: Record<string, unknown> =
      existing && typeof existing === 'object'
        ? { ...(existing as Record<string, unknown>) }
        : {};

    // Update only the provided keys
    if (partial.browseItemCount !== undefined) section.browseItemCount = partial.browseItemCount;
    if (partial.showIcons !== undefined) section.showIcons = partial.showIcons;
    if (partial.showActivityIndicator !== undefined) section.showActivityIndicator = partial.showActivityIndicator;
    if (partial.showHelpText !== undefined) section.showHelpText = partial.showHelpText;
    if (partial.autoInjectEnabled !== undefined) section.autoInjectEnabled = partial.autoInjectEnabled;

    raw[SETTINGS_NAMESPACE] = section;

    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
  } catch (err) {
    console.error('[settings-config] Failed to persist settings:', err);
  }
}
