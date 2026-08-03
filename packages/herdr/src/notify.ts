/**
 * packages/herdr/src/notify.ts — Fire-and-forget Herdr toast notifications
 *
 * Provides a tiny wrapper around the `herdr notification show` CLI so the
 * worklist pane can surface transient feedback (refresh/sync outcomes,
 * sent/skipped command feedback, errors) as Herdr toasts instead of
 * appending a status line to the bottom of the pane output.
 *
 * The pane runs as a standalone process (`npx tsx src/index.ts`) inside a
 * Herdr pane pty, so it cannot call pi's `ctx.ui.notify()` directly — it
 * must invoke the notification system via the `herdr` CLI subprocess.
 *
 * Key design decisions:
 *  - Fire-and-forget: `spawn` with stdio ignored; the pane never blocks.
 *  - Failure-tolerant: a missing binary, non-zero exit, `shown: false`, or a
 *    rate-limited `busy` response is silently tolerated (no crash, no retry).
 *  - Default position `bottom-right` (the only positions Herdr supports for
 *    `notification show` are the four corners).
 *  - `child.unref()` so a toast never keeps the pane process alive.
 */

import { spawn } from 'node:child_process';

// ── Types ───────────────────────────────────────────────────────────────

/** Positions supported by `herdr notification show` (corner-only). */
export type ToastPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** Options for {@link showToast}. */
export interface ToastOptions {
  /** Optional body text (displayed under the title). */
  body?: string;
  /** Toast position. Defaults to `bottom-right`. */
  position?: ToastPosition;
}

// ── Implementation ──────────────────────────────────────────────────────

/**
 * Show a Herdr toast via `herdr notification show`.
 *
 * Fire-and-forget: never blocks, never throws, and tolerates every failure
 * mode silently (missing `herdr` binary, non-zero exit, `shown: false`,
 * rate-limited `busy`). A single toast replaces any previous toast.
 *
 * @param title - Toast title (required by the CLI).
 * @param options - Optional body text and/or position.
 */
export function showToast(title: string, options?: ToastOptions): void {
  const position = options?.position ?? 'bottom-right';
  const args = ['notification', 'show', title];
  if (options?.body) {
    args.push('--body', options.body);
  }
  args.push('--position', position);

  try {
    const child = spawn('herdr', args, { stdio: 'ignore' });
    // Tolerate ENOENT / spawn failures silently
    child.on('error', () => {
      /* ignore */
    });
    // Don't keep the pane process alive for a toast
    child.unref?.();
  } catch {
    // spawn itself throwing is tolerated (worst-case fallback)
  }
}
