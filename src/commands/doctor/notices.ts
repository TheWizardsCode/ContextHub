/**
 * Shared doctor notices and cache formatting helpers.
 *
 * Single responsibility: the cross-cutting, read-only pending-upgrade and
 * pending read-cache notices (detection, synthetic JSON findings and human
 * output) that the top-level `wl doctor` action appends to its own findings,
 * plus the small formatting helpers shared with the `cache` subcommand.
 *
 * Extracted from `src/commands/doctor.ts` (WL-0MW0841DG009640H) as a
 * move-only refactor: it imports only concrete sibling modules and never
 * imports from the registrar.
 */

import { listPendingMigrations } from '../../migrations/index.js';
import { dryRunHooks, detectHooksTargetDir } from '../../doctor/hook-upgrade.js';
import {
  pruneStateDir,
  resolveCacheDir,
  DEFAULT_STATE_MAX_FILES,
  DEFAULT_STATE_TTL_MS,
} from '../../read-cache.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Compact human-readable byte formatting for cache reports. */
export function formatCacheBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) bytes = 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(1)} ${unit}`;
}

export interface DoctorOptions {
  prefix?: string;
}

/**
 * Pending-upgrade state surfaced by the top-level `wl doctor` action:
 * schema migrations and git hooks that `wl doctor upgrade` would apply.
 */
export interface PendingUpgradeState {
  pendingMigrations: ReturnType<typeof listPendingMigrations>;
  outdatedHooks: string[];
  hasPendingUpgrades: boolean;
}

/**
 * Detect pending `wl doctor upgrade` work (schema migrations and outdated git
 * hooks) without applying anything (WL-0MUTVB271007YKJZ). Read-only and
 * best-effort: any failure degrades to "no pending upgrades" so `wl doctor`
 * never crashes on a missing DB, a non-git directory or an absent `.githooks/`.
 */
export function detectPendingUpgrades(): PendingUpgradeState {
  let pendingMigrations: ReturnType<typeof listPendingMigrations> = [];
  try {
    pendingMigrations = listPendingMigrations() ?? [];
  } catch (_e) {
    pendingMigrations = [];
  }

  let outdatedHooks: string[] = [];
  try {
    const hooksTargetDir = detectHooksTargetDir();
    const hooksResult = dryRunHooks('.githooks', hooksTargetDir);
    outdatedHooks = hooksResult.hooks
      .filter(h => h.status === 'outdated')
      .map(h => h.name);
  } catch (_e) {
    outdatedHooks = [];
  }

  return {
    pendingMigrations,
    outdatedHooks,
    hasPendingUpgrades: pendingMigrations.length > 0 || outdatedHooks.length > 0,
  };
}

/**
 * Build the synthetic JSON finding that carries pending-upgrade information.
 * Emitted additively into the existing findings array so the `wl doctor --json`
 * top-level shape (a raw array) and its consumers are unchanged.
 */
export function buildPendingUpgradeFinding(state: PendingUpgradeState): {
  checkId: string;
  type: string;
  severity: string;
  itemId: string | null;
  message: string;
  proposedFix: null;
  safe: boolean;
  context: Record<string, unknown>;
} {
  const migrationCount = state.pendingMigrations.length;
  const hookCount = state.outdatedHooks.length;
  const parts: string[] = [];
  if (migrationCount > 0) parts.push(`${migrationCount} pending migration${migrationCount === 1 ? '' : 's'}`);
  if (hookCount > 0) parts.push(`${hookCount} outdated hook${hookCount === 1 ? '' : 's'}`);
  return {
    checkId: 'upgrade.pending',
    type: 'pending-upgrade',
    severity: 'info',
    itemId: null,
    message: `Pending upgrades: ${parts.join(' and ')}. Run \`wl doctor upgrade\`.`,
    proposedFix: null,
    safe: false,
    context: {
      pendingMigrations: state.pendingMigrations,
      pendingMigrationCount: migrationCount,
      outdatedHooks: state.outdatedHooks,
      outdatedHookCount: hookCount,
    },
  };
}

/**
 * Print the advisory pending-upgrade notice in human-readable mode. Mirrors
 * `wl doctor upgrade --dry-run` wording so operators can preview or apply.
 */
export function printPendingUpgradeNotice(state: PendingUpgradeState): void {
  console.log('');
  console.log('Doctor: pending upgrades detected.');
  if (state.pendingMigrations.length > 0) {
    console.log(`Pending migrations (${state.pendingMigrations.length}):`);
    for (const m of state.pendingMigrations) {
      console.log(` - ${m.id}: ${m.description} (safe=${m.safe})`);
    }
  }
  if (state.outdatedHooks.length > 0) {
    console.log(`Outdated hooks (${state.outdatedHooks.length}):`);
    for (const name of state.outdatedHooks) {
      console.log(` - ${name}`);
    }
  }
  console.log('Run `wl doctor upgrade` to preview pending upgrades, or `wl doctor upgrade --confirm` to apply them.');
}

/**
 * Read-cache state that `wl doctor` should flag (F9 — WL-0MVFRRQ9W003KEFL):
 * the per-worklog-dir counter store has grown past what a dry-run prune would
 * reclaim. Read-only: a dry-run `pruneStateDir` never deletes anything.
 */
export interface PendingCacheState {
  pending: boolean;
  files: number;
  totalBytes: number;
  staleByTtl: number;
  overBound: number;
  maxFiles: number;
  ttlDays: number;
  stateDir: string;
}

/** Detect pending read-cache state cleanup (best-effort, never throws). */
export function detectPendingCacheState(): PendingCacheState {
  const none: PendingCacheState = {
    pending: false,
    files: 0,
    totalBytes: 0,
    staleByTtl: 0,
    overBound: 0,
    maxFiles: DEFAULT_STATE_MAX_FILES,
    ttlDays: DEFAULT_STATE_TTL_MS / DAY_MS,
    stateDir: '',
  };
  try {
    const result = pruneStateDir(resolveCacheDir(), { dryRun: true });
    return {
      pending: result.removed > 0,
      files: result.filesScanned,
      totalBytes: result.totalBytes,
      staleByTtl: result.staleByTtl,
      overBound: result.overBound,
      maxFiles: DEFAULT_STATE_MAX_FILES,
      ttlDays: DEFAULT_STATE_TTL_MS / DAY_MS,
      stateDir: result.stateDir,
    };
  } catch {
    return none;
  }
}

/** Print the pending read-cache notice in human-readable mode. */
export function printPendingCacheNotice(state: PendingCacheState): void {
  console.log('');
  console.log('Doctor: pending read-cache state cleanup detected.');
  console.log(
    `Read-cache state counters: ${state.files} file(s) — ${state.staleByTtl} stale by TTL, ` +
      `${state.overBound} over the ${state.maxFiles}-file bound (${formatCacheBytes(state.totalBytes)} total).`
  );
  console.log('Run `wl doctor cache --prune` to reclaim the space, or `wl doctor cache` for details.');
}
