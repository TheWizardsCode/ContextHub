/**
 * In Review bucket ordering across the two worklist fetch paths
 * (WL-0MUWDW0N6003KF6G).
 *
 * The 6-bucket in_review sort classifies an item as passed-fresh (bucket 6)
 * when its stored audit content fingerprint matches the item's current
 * fingerprint, even when the 60 s time gate would call it stale. `fetchItemsByStage`
 * reads `wl list --json` (which emits both fingerprints) and `fetchNextItems`
 * merges `wl next` (which does NOT emit fingerprints) with the mandatory
 * `wl list` review subset. Without forwarding the fingerprints from the
 * mandatory subset, the default worklist classified the fingerprint-fresh item
 * as passed-stale (bucket 5) and ranked it ahead of a higher-priority
 * passed-fresh item (bucket 6) — the reported "medium before high" symptom.
 *
 * Run: npx vitest run packages/herdr/src/fetcher-in-review-bucket.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  fetchItemsByStage,
  fetchNextItems,
  setExecFileAsync,
  resetExecFileAsync,
  resetWorklogDir,
} from './fetcher.js';

const UPDATED_AT = '2026-10-10T10:00:00.000Z';
/** 20 minutes before updatedAt → stale under the time gate. */
const STALE_AUDITED_AT = '2026-10-10T09:40:00.000Z';
const FINGERPRINT = 'sha256-match';

/** Medium item: audit fresh only via the content fingerprint (time-stale). */
function mediumFpFresh(withFingerprint: boolean): Record<string, unknown> {
  return {
    id: 'WL-medium-fp-fresh',
    title: 'Medium fingerprint-fresh',
    status: 'completed',
    stage: 'in_review',
    priority: 'medium',
    updatedAt: UPDATED_AT,
    auditResult: true,
    auditedAt: STALE_AUDITED_AT,
    ...(withFingerprint ? { fingerprint: FINGERPRINT, currentFingerprint: FINGERPRINT } : {}),
  };
}

/** High item: audit fresh by time (bucket 6). */
function highTimeFresh(): Record<string, unknown> {
  return {
    id: 'WL-high-time-fresh',
    title: 'High time-fresh',
    status: 'completed',
    stage: 'in_review',
    priority: 'high',
    updatedAt: UPDATED_AT,
    auditResult: true,
    auditedAt: UPDATED_AT,
  };
}

beforeEach(() => {
  resetExecFileAsync();
  resetWorklogDir();
});

afterEach(() => {
  resetExecFileAsync();
  resetWorklogDir();
});

describe('in_review bucket ordering across fetch paths (WL-0MUWDW0N6003KF6G)', () => {
  it('fetchItemsByStage(in_review) ranks a high passed-fresh item before a fingerprint-fresh medium item', async () => {
    setExecFileAsync((async () => ({
      stdout: JSON.stringify({ success: true, workItems: [mediumFpFresh(true), highTimeFresh()] }),
      stderr: '',
    })) as never);

    const items = await fetchItemsByStage('in_review');

    expect(items.map((i) => i.id)).toEqual(['WL-high-time-fresh', 'WL-medium-fp-fresh']);
  });

  it('fetchNextItems enriches wl-next items with fingerprints from the mandatory wl list subset', async () => {
    // `wl next` (no fingerprints) + mandatory `wl list` review subset (with
    // fingerprints). Deduplication keeps the first occurrence, so the
    // fingerprint metadata must be copied across before regrouping.
    setExecFileAsync((async (_bin: string, args: string[]) => {
      if (args.includes('next')) {
        return {
          stdout: JSON.stringify({
            success: true,
            results: [{ workItem: mediumFpFresh(false) }, { workItem: highTimeFresh() }],
          }),
          stderr: '',
        };
      }
      if (args.includes('--priority')) {
        // Critical mandatory subset — empty for this fixture.
        return { stdout: JSON.stringify({ success: true, workItems: [] }), stderr: '' };
      }
      // Mandatory completed/in_review subset — carries the fingerprints.
      return {
        stdout: JSON.stringify({ success: true, workItems: [mediumFpFresh(true), highTimeFresh()] }),
        stderr: '',
      };
    }) as never);

    const items = await fetchNextItems(10);
    const inReviewOrder = items.filter((i) => i.stage === 'in_review').map((i) => i.id);

    expect(inReviewOrder).toEqual(['WL-high-time-fresh', 'WL-medium-fp-fresh']);
  });
});
