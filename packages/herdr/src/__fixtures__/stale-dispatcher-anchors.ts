// packages/herdr/src/__fixtures__/stale-dispatcher-anchors.ts
//
// Shared regression fixture — the recorded PRE-FIX stale Dispatcher anchor
// state (parent WL-0MWH50EN4007C6YH, measured 2026-11-15 with the w6A
// workspace gone and both anchor files still pointing at it):
//
//   downtime-dispatch-anchor.json            {"paneId":"w6A:p1","workspaceId":"w6A"}
//   downtime-dispatch-tab-anchors.json       {"workspaceId":"w6A","byPrefix":{"WL":{"tabId":"w6A:t2","paneId":"w6A:p5"}}}
//
// Committed by the test-only guard item WL-0MWHCUL35004I9SW so the behaviour
// we must not regress (dead pane with a live workspace re-resolves; an
// unreadable herdr fails closed and provisions nothing; two racing callers
// create exactly one workspace) is pinned against today's tree BEFORE the
// fix, and the sibling fix item (WL-0MWHCUTDM003B39Q) seeds the exact same
// state via `seedStaleAnchorState(dir)` — the pre-fix state is reused
// verbatim, never re-measured, and no test reads `~/.herdr`.
//
// Test-only (excluded from the herdr tsconfig via `src/__fixtures__`),
// mirroring `coordination-v1-entry.ts` / `coordination-v2-offers.ts`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DISPATCHER_ANCHOR_FILE,
  DISPATCHER_TAB_ANCHORS_FILE,
} from '../dispatcher-anchor.contract.js';
import type {
  DispatcherAnchor,
  DispatcherTabAnchors,
} from '../dispatcher-anchor.contract.js';

/** Recorded pre-fix single-anchor file, byte-for-byte. */
export const STALE_ANCHOR_JSON = '{"paneId":"w6A:p1","workspaceId":"w6A"}';

/** Recorded pre-fix per-prefix tab-anchors file, byte-for-byte. */
export const STALE_TAB_ANCHORS_JSON =
  '{"workspaceId":"w6A","byPrefix":{"WL":{"tabId":"w6A:t2","paneId":"w6A:p5"}}}';

/** Parsed form of {@link STALE_ANCHOR_JSON}. */
export const STALE_ANCHOR: DispatcherAnchor = JSON.parse(STALE_ANCHOR_JSON);

/** Parsed form of {@link STALE_TAB_ANCHORS_JSON}. */
export const STALE_TAB_ANCHORS: DispatcherTabAnchors = JSON.parse(STALE_TAB_ANCHORS_JSON);

/**
 * Write the recorded pre-fix stale anchor state into `dir` (the machine
 * coordination dir under test) — both files, both ids `w6A`, verbatim.
 */
export function seedStaleAnchorState(dir: string): void {
  fs.writeFileSync(path.join(dir, DISPATCHER_ANCHOR_FILE), STALE_ANCHOR_JSON, 'utf-8');
  fs.writeFileSync(path.join(dir, DISPATCHER_TAB_ANCHORS_FILE), STALE_TAB_ANCHORS_JSON, 'utf-8');
}
