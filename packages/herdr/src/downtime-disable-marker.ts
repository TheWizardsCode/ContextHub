/**
 * Durable per-worklog-root downtime-disable marker (parent WL-0MT4BWUHW008LIFE).
 *
 * The `d` shortcut's per-instance override is in-memory and resets on plugin
 * restart (per-instance scoping, WL-0MSZ4NSOE007AQEF). To make a disable
 * survive a pane/plugin restart without touching the shared settings file,
 * toggle() writes a small marker file at the worklog root:
 *
 *   `<cwd>/.herdr-downtime-disabled`
 *
 * On worker construction the marker is read back: its presence restores
 * `override = false` (disabled) unless an explicit `override` is provided to
 * createDowntimeWorker (explicit wins, marker is the fallback).
 *
 * All IO here is best-effort and non-fatal: toggle() must never crash the TUI
 * because the marker could not be written (e.g. read-only FS), and an absent
 * marker must never throw on removal. Synchronous fs is used deliberately so
 * the toggle() contract stays synchronous {void} and the marker state is
 * deterministic for callers and tests.
 */
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Marker file name, placed directly in the worklog root (cwd). */
export const DOWNTIME_DISABLE_MARKER_FILE = '.herdr-downtime-disabled';

/** Absolute path of the disable marker for a given worklog root. */
export function disableMarkerPath(cwd: string): string {
  return join(cwd, DOWNTIME_DISABLE_MARKER_FILE);
}

/** True when the disable marker exists in the worklog root (fail-closed on fs errors). */
export function disableMarkerExists(cwd: string): boolean {
  try {
    return existsSync(disableMarkerPath(cwd));
  } catch {
    return false;
  }
}

/**
 * Write the disable marker (no-op when it already exists). Best-effort:
 * a failed write (e.g. cwd missing, read-only FS) is swallowed — the
 * in-memory override still applies for this process lifetime.
 */
export function writeDisableMarker(cwd: string): void {
  try {
    const path = disableMarkerPath(cwd);
    if (!existsSync(path)) writeFileSync(path, '', 'utf8');
  } catch {
    // Non-fatal: toggle must never crash on marker IO.
  }
}

/**
 * Remove the disable marker (no-op when absent). Best-effort: a failed
 * removal never throws.
 */
export function removeDisableMarker(cwd: string): void {
  try {
    rmSync(disableMarkerPath(cwd), { force: true });
  } catch {
    // Non-fatal: toggle must never crash on marker IO.
  }
}