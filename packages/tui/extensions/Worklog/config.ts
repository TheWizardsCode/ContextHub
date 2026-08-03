/**
 * config.ts — Hot-reloadable configuration manager for the Worklog extension.
 *
 * Provides a reactive configuration wrapper around the static settings
 * loader (settings-config.ts). Supports lazy loading, runtime updates,
 * change notification, and file watching for external config edits.
 *
 * Usage:
 *   const config = new WorklogConfig();
 *   config.load(cwd);          // load from disk (lazy: called by get())
 *   const s = config.get();    // read-only snapshot
 *   config.update({ ... });    // merge, persist, notify
 *   const dispose = config.onChange(() => { ... });  // subscribe
 *   dispose();                 // unsubscribe
 *   config.watchFile(path);    // watch file for external changes
 *   config.dispose();          // release all watchers
 */

import { watch } from 'node:fs';
import { resolvePiDir } from '../../../../src/worklog-paths.js';
import { loadSettings, persistSettings, validateNumber, validateBoolean, DEFAULT_SETTINGS, CONFIG_VERSION, type Settings } from './settings-config.js';

/**
 * Reactive configuration manager with hot-reload support.
 *
 * - Lazy loading: config is loaded from disk on first access, not at
 *   construction time.
 * - Runtime updates: update() merges partial settings, persists them, and
 *   notifies all onChange subscribers.
 * - Change notification: subscribers are notified synchronously via onChange().
 * - File watching: watchFile() uses fs.watch to detect external edits.
 */
export class WorklogConfig {
  private _config: Settings = { ...DEFAULT_SETTINGS };
  private _loaded = false;
  private _watchers = new Set<() => void>();
  private _fsWatchers = new Set<ReturnType<typeof watch>>();
  private _projectDir = '';
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Load configuration from disk for the given project directory.
   *
   * The project directory is resolved repo-root aware via resolvePiDir()
   * (see src/worklog-paths.ts) and cached in `_projectDir` so loading,
   * persistence and file watching all target the same settings file.
   * Delegates to loadSettings() from settings-config.ts, which merges
   * default, global, and project-level settings (project wins).
   * Subsequent calls reload from disk and notify subscribers if values
   * actually changed.
   *
   * @param cwd - Project working directory (defaults to process.cwd())
   */
  load(cwd?: string): void {
    // Resolve the settings directory once: nearest .pi/settings.json wins,
    // falling back to the git repo root (mirrors .worklog discovery).
    this._projectDir = resolvePiDir(cwd ?? process.cwd());
    const newConfig = loadSettings(this._projectDir);
    // Apply migrations to bring older config versions up to current
    this._migrate(newConfig);
    const changed = JSON.stringify(this._config) !== JSON.stringify(newConfig);
    this._config = newConfig;
    this._loaded = true;
    if (changed) {
      this._notifyWatchers();
    }
  }

  /**
   * Get the current configuration as a readonly snapshot.
   *
   * Loads from disk on first access (lazy loading) if load() has not been
   * called explicitly. Returns a shallow copy so callers cannot mutate
   * internal state.
   */
  get(): Readonly<Settings> {
    if (!this._loaded) {
      this._config = loadSettings(this._projectDir || undefined);
      this._loaded = true;
    }
    // Return a shallow copy to prevent mutation of internal state
    return Object.freeze({ ...this._config });
  }

  /**
   * Update configuration with partial values.
   *
   * Merges the provided partial settings into the current configuration,
   * persists them to the project's .pi/settings.json under the context-hub
   * namespace, and notifies all registered onChange subscribers.
   *
   * Each value is validated before being applied. Invalid values are
   * replaced with defaults (graceful degradation, no throw).
   * Unknown keys are silently ignored.
   *
   * @param partial - Partial settings to merge
   */
  update(partial: Partial<Settings>): void {
    if (!partial || typeof partial !== 'object') return;
    if (!this._loaded) {
      this._config = loadSettings(this._projectDir || undefined);
      this._loaded = true;
    }

    // Validate and apply each provided value
    const validated: Partial<Settings> = {};

    if (partial.browseItemCount !== undefined) {
      validated.browseItemCount = validateNumber(
        partial.browseItemCount,
        DEFAULT_SETTINGS.browseItemCount,
        1,
        50,
      );
    }
    if (partial.showIcons !== undefined) {
      validated.showIcons = validateBoolean(partial.showIcons, DEFAULT_SETTINGS.showIcons);
    }
    if (partial.showActivityIndicator !== undefined) {
      validated.showActivityIndicator = validateBoolean(
        partial.showActivityIndicator,
        DEFAULT_SETTINGS.showActivityIndicator,
      );
    }
    if (partial.showHelpText !== undefined) {
      validated.showHelpText = validateBoolean(partial.showHelpText, DEFAULT_SETTINGS.showHelpText);
    }
    if (partial.autoInjectEnabled !== undefined) {
      validated.autoInjectEnabled = validateBoolean(
        partial.autoInjectEnabled,
        DEFAULT_SETTINGS.autoInjectEnabled,
      );
    }
    if (partial.guardrailsEnabled !== undefined) {
      validated.guardrailsEnabled = validateBoolean(
        partial.guardrailsEnabled,
        DEFAULT_SETTINGS.guardrailsEnabled,
      );
    }
    if (partial.autoSyncIntervalSeconds !== undefined) {
      validated.autoSyncIntervalSeconds = validateNumber(
        partial.autoSyncIntervalSeconds,
        DEFAULT_SETTINGS.autoSyncIntervalSeconds,
        0,
        300,
      );
    }
    if (partial.recovery !== undefined) {
      // Recovery config is passed through as-is; individual category validation
      // is handled by the recovery module at usage time. Invalid values in the
      // recovery config degrade gracefully (fall back to defaults per category).
      validated.recovery = partial.recovery;
    }
    if (partial.schedules !== undefined) {
      // Schedules are passed through as-is; validation happens in the scheduler module
      validated.schedules = partial.schedules;
    }

    this._config = { ...this._config, ...validated };
    persistSettings(validated, this._projectDir || undefined);
    this._notifyWatchers();
  }

  /**
   * Register a callback that is invoked whenever the configuration changes.
   *
   * Callbacks are invoked synchronously after update() or when external
   * file changes are detected via watchFile().
   *
   * @param callback - Function to call on config change
   * @returns A disposer function that unregisters the callback
   */
  onChange(callback: () => void): () => void {
    this._watchers.add(callback);
    return () => {
      this._watchers.delete(callback);
    };
  }

  /**
   * Watch a settings file for external changes using fs.watch.
   *
   * When the file changes, the config is reloaded from disk and onChange
   * subscribers are notified. Changes are debounced by ~300ms to coalesce
   * rapid writes (e.g., editor auto-save).
   *
   * @param path - Absolute path to the settings file to watch
   */
  watchFile(path: string): void {
    try {
      const fsWatcher = watch(path, (eventType) => {
        if (eventType === 'change' || eventType === 'rename') {
          this._debouncedReload();
        }
      });
      this._fsWatchers.add(fsWatcher);
    } catch {
      // File may not exist yet; silently ignore — watchFile can be called
      // again when the file is known to exist.
    }
  }

  /**
   * Release all resources: dispose all file watchers and clear subscribers.
   *
   * After calling dispose(), the config instance should not be reused.
   */
  dispose(): void {
    for (const w of this._fsWatchers) {
      try {
        w.close();
      } catch {
        // Ignore close errors on stale watchers
      }
    }
    this._fsWatchers.clear();
    this._watchers.clear();
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }

  /**
   * Reload config from disk with debouncing.
   */
  private _debouncedReload(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      if (this._projectDir) {
        const newConfig = loadSettings(this._projectDir);
        this._migrate(newConfig);
        const changed = JSON.stringify(this._config) !== JSON.stringify(newConfig);
        if (changed) {
          this._config = newConfig;
          this._notifyWatchers();
        }
      }
    }, 300);
  }

  // ── Migration support ─────────────────────────────────────────────

  /**
   * Run config migration: transforms config from older versions to the
   * current format. Mutates the config object in-place.
   *
   * Migrations are registered in the MIGRATORS map keyed by version.
   * The config is stepped through each intermediate version until it
   * reaches CONFIG_VERSION.
   */
  private _migrate(config: Settings): void {
    const version = config.version ?? 0;
    if (version >= CONFIG_VERSION) return; // already current

    let currentVersion = version;
    while (currentVersion < CONFIG_VERSION) {
      const migrator = MIGRATORS[currentVersion];
      if (migrator) {
        migrator(config);
        console.log(`[WorklogConfig] Migrated config from v${currentVersion} to v${currentVersion + 1}`);
      }
      currentVersion++;
    }
    config.version = CONFIG_VERSION;
  }

  /**
   * Notify all registered onChange subscribers.
   */
  private _notifyWatchers(): void {
    for (const cb of this._watchers) {
      try {
        cb();
      } catch (err) {
        console.error('[WorklogConfig] onChange callback error:', err);
      }
    }
  }
}

/**
 * A migrator function that transforms a Settings object from one version
 * to the next. Mutates the config in-place.
 */
type Migrator = (config: Settings) => void;

/**
 * Registry of migrators keyed by the source version.
 * MIGRATORS[v] transforms config from version v → v+1.
 *
 * v0 → v1: Initial version, no-op (defaults are sufficient).
 * For future schema changes, add new entries here.
 */
const MIGRATORS: Record<number, Migrator> = {
  // v0 → v1: Placeholder for initial migration. No changes needed
  // because the current schema matches the implicit v0 defaults.
  0: (_config: Settings) => {
    // No-op: all fields have sensible defaults.
  },
};

/**
 * Shared singleton instance of WorklogConfig used by the extension runtime.
 *
 * Extension components should subscribe to changes via:
 *   worklogConfig.onChange(() => { ... });
 *
 * The /wl settings command handler should delegate to:
 *   worklogConfig.update({ ... });
 */
export const worklogConfig = new WorklogConfig();
