/**
 * packages/herdr/src/dispatcher-anchor.provision.ts — shared
 * find-or-provision-under-lock helper (WL-0MWHWH68L007L7IO AC1).
 *
 * Single responsibility: the ONE coordination-lock + double-check + create +
 * persist sequence shared by all three placement strategies —
 * `getItemTabAnchor` (project workspace + item-ID tab), `getDispatcherTabAnchor`
 * (per-prefix Dispatcher tab) and `getDispatcherAnchor` (machine-wide anchor,
 * via `provisionDispatcherAnchorUnderLock`). Each strategy supplies its own
 * resolver (`find`), creator (`create`), persistence hooks and fail-closed
 * detail vocabulary; this module owns the lock lifecycle exactly once, so a
 * naming/placement change (e.g. the Dispatcher adopt-or-clean or the Ship
 * tab) lands in one place instead of three parallel provisioning paths.
 *
 * Algorithm (moved verbatim from the per-strategy lock sections, no
 * coordination-semantics change):
 *
 *  1. **Fast path (no lock)** — `find()` resolves an existing live anchor.
 *     `found` → adopted; `unknown` (unreadable boundary) → fail closed.
 *  2. **Lock held elsewhere** — a single raced `find()` re-check adopts a
 *     racing caller's result; any miss fails closed (never creates). The
 *     raced-unknown boundary is reported separately from a plain miss so a
 *     transparent herdr is never conflated with "no anchor" (missing ≠
 *     unreadable).
 *  3. **Lock acquired** — in-lock `find()` double-check (a racing caller may
 *     have provisioned between our fast path and the lock); `none` → `create()`
 *     then the `adoptCreated` persistence hook (fail-closed: a `false`
 *     result fails the provisioning, exactly like the per-prefix persist and
 *     the anchor file write).
 *
 * Layering: imports the coordination lock primitive from `./coordination.js`
 * and the failure-detail vocabulary from `dispatcher-anchor.contract.js`; it
 * never imports the `dispatcher-anchor.js` barrel, so the barrel can re-export
 * the resolvers without creating a cycle. It also never imports
 * `pane-close-herdr.ts` — the herdr pane-list parse stays in the shared
 * `pane-discovery.ts` contract (AC2).
 */

import { tryAcquireCoordLock } from './coordination.js';
import type { PlacementFailureDetail } from './dispatcher-anchor.contract.js';

/** Outcome of resolving an existing live anchor. */
export type ProvisionFind<T> =
  | { status: 'found'; value: T }
  | { status: 'none' }
  | { status: 'unknown' };

/** Per-strategy hooks and fail-closed vocabulary for one provision cycle. */
export interface FindOrProvisionUnderLockOptions<T> {
  /** Machine coordination dir (the lock file lives here). */
  dir: string;
  /** Resolve an existing live anchor (fast path, raced re-check, in-lock double-check). */
  find(): Promise<ProvisionFind<T>>;
  /** Create the anchor when `find` reports none; `null` → provisioning fails closed. */
  create(): Promise<T | null>;
  /** Best-effort adopt-persist for a FOUND anchor (e.g. the per-prefix map rewrite). */
  adoptFound?(value: T): void;
  /** Fail-closed adopt-persist for a CREATED anchor; `false` → fail closed. */
  adoptCreated?(value: T): boolean | Promise<boolean>;
  /** Fail-closed boundary reporter (optional; absent callers stay silent). */
  report?(detail: PlacementFailureDetail): void;
  /** Reported when the fast path cannot be read. */
  fastUnknownDetail: PlacementFailureDetail;
  /** Reported when the lock is held and the raced re-check is unreadable. */
  racedUnknownDetail: PlacementFailureDetail;
  /** Reported when the lock is held and the raced re-check finds nothing. */
  racedMissDetail: PlacementFailureDetail;
  /** Reported when the in-lock double-check cannot be read. */
  inLockUnknownDetail: PlacementFailureDetail;
  /** Reported when `create()` returns null or `adoptCreated` fails. */
  createFailDetail: PlacementFailureDetail;
}

/**
 * Find or provision an anchor under the coordination lock — the single
 * lock lifecycle shared by every placement strategy (AC1).
 *
 * Returns the anchor (found, raced-adopted, double-checked or created) or
 * `null` on any fail-closed boundary. Never throws.
 */
export async function findOrProvisionUnderLock<T>(
  opts: FindOrProvisionUnderLockOptions<T>,
): Promise<T | null> {
  // 1. Fast path — no lock. A live anchor is adopted; the lock is only
  //    consulted when nothing exists (never for an unreadable boundary).
  const fast = await opts.find();
  if (fast.status === 'unknown') {
    opts.report?.(opts.fastUnknownDetail);
    return null;
  }
  if (fast.status === 'found') {
    opts.adoptFound?.(fast.value);
    return fast.value;
  }

  // 2. Provision under the coordination lock with a double-check.
  const release = tryAcquireCoordLock(opts.dir);
  if (release === null) {
    // Another holder is provisioning — adopt their result on a single raced
    // re-check, else fail closed (the raced-unknown boundary is reported
    // separately from a plain miss: missing ≠ unreadable).
    const raced = await opts.find();
    if (raced.status === 'found') {
      opts.adoptFound?.(raced.value);
      return raced.value;
    }
    opts.report?.(raced.status === 'unknown' ? opts.racedUnknownDetail : opts.racedMissDetail);
    return null;
  }
  try {
    // In-lock double-check: a racing caller may have provisioned between our
    // fast-path miss and acquiring the lock — never create over their work.
    const inside = await opts.find();
    if (inside.status === 'unknown') {
      opts.report?.(opts.inLockUnknownDetail);
      return null;
    }
    if (inside.status === 'found') {
      opts.adoptFound?.(inside.value);
      return inside.value;
    }

    // inside.status === 'none' → create (never focus-stealing).
    let created: T | null = null;
    try {
      created = await opts.create();
    } catch {
      created = null; // fail-closed — the caller reports via createFailDetail
    }
    if (created === null) {
      opts.report?.(opts.createFailDetail);
      return null;
    }
    if ((await opts.adoptCreated?.(created)) === false) {
      opts.report?.(opts.createFailDetail);
      return null;
    }
    return created;
  } finally {
    release();
  }
}
