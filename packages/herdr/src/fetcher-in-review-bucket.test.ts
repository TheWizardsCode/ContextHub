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
 * passed-fresh item (bucket 6) — a "medium before high" inversion.
 *
 * Since WL-0MUWDW0N6003KF6G priority is the primary sort key and the bucket
 * only breaks ties within a priority band; these tests keep verifying that
 * both fetch paths classify buckets identically (so a high item leads a medium
 * one), now through the priority-first comparator.
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

  it('fetchItemsByStage(in_review) ranks a high no-audit item before a medium failed-audit item (WL-0MUWDW0N6003KF6G)', async () => {
    // The producer-reported symptom: the audit bucket was primary, so a medium
    // failed (stale) audit (bucket 3) led a high no-audit item (bucket 4).
    // Priority is now the primary key; the bucket breaks ties inside a band.
    setExecFileAsync((async () => ({
      stdout: JSON.stringify({
        success: true,
        workItems: [
          {
            id: 'WL-medium-failed-stale',
            title: 'Medium failed stale',
            status: 'completed',
            stage: 'in_review',
            priority: 'medium',
            updatedAt: UPDATED_AT,
            auditResult: false,
            auditedAt: STALE_AUDITED_AT,
          },
          {
            id: 'WL-high-no-audit',
            title: 'High no audit',
            status: 'completed',
            stage: 'in_review',
            priority: 'high',
            updatedAt: UPDATED_AT,
            auditResult: null,
            auditedAt: null,
          },
          {
            id: 'WL-medium-no-audit',
            title: 'Medium no audit',
            status: 'completed',
            stage: 'in_review',
            priority: 'medium',
            updatedAt: UPDATED_AT,
            auditResult: null,
            auditedAt: null,
          },
        ],
      }),
      stderr: '',
    })) as never);

    const items = await fetchItemsByStage('in_review');

    expect(items.map((i) => i.id)).toEqual([
      'WL-high-no-audit',
      'WL-medium-failed-stale',
      'WL-medium-no-audit',
    ]);
  });

  it('fetchNextItems rescues an in-progress/in_review item that only exists in the mandatory wl list subset (WL-0MV6JGVPH009YDXB)', async () => {
    // An item being re-worked after review feedback keeps stage=in_review but
    // flips status to in-progress. It may fall OUTSIDE the wl next top-N
    // window — the mandatory `wl list` review subset (now `--status
    // completed,in-progress`) must still surface it regardless of count.
    const reworkedReview = {
      id: 'WL-reworked-review',
      title: 'Reworked review item',
      status: 'in-progress',
      stage: 'in_review',
      priority: 'medium',
      updatedAt: UPDATED_AT,
    };
    const windowItem = { id: 'WL-in-window', title: 'In window', status: 'open', stage: 'idea', priority: 'medium' };

    setExecFileAsync((async (_bin: string, args: string[]) => {
      if (args.includes('next')) {
        // The reworked item is NOT in the wl next top-N window — only the
        // window item is.
        return {
          stdout: JSON.stringify({ success: true, results: [{ workItem: windowItem }] }),
          stderr: '',
        };
      }
      if (args.includes('--priority')) {
        return { stdout: JSON.stringify({ success: true, workItems: [] }), stderr: '' };
      }
      // Mandatory review subset — now fetched with --status completed,in-progress.
      return {
        stdout: JSON.stringify({ success: true, workItems: [reworkedReview] }),
        stderr: '',
      };
    }) as never);

    // count=1: the mandatory in-progress/in_review item must be included, so
    // the window item is pushed out (mandatory items are never capped).
    const items = await fetchNextItems(1);
    const ids = items.map((i) => i.id);
    expect(ids).toContain('WL-reworked-review');
    expect(ids).not.toContain('WL-in-window');
  });

  it('fetchNextItems keeps an actively-worked in-progress item when the review queue saturates the window (WL-0MV6KV22S004NYIU)', async () => {
    // The reported symptom: 22 root in_review items saturate browseItemCount
    // (20), leaving zero "others" slots — an in-progress/plan_complete item
    // returned first by `wl next` was cut. Actively-worked items must be
    // mandatory regardless of review-queue depth.
    const activeItem = {
      id: 'WL-active-plan',
      title: 'Actively worked plan item',
      status: 'in-progress',
      stage: 'plan_complete',
      priority: 'medium',
      updatedAt: UPDATED_AT,
    };
    const reviewItems = Array.from({ length: 22 }, (_, i) => ({
      id: `WL-review-${i + 1}`,
      title: `Review ${i + 1}`,
      status: 'completed',
      stage: 'in_review',
      priority: 'medium',
      updatedAt: UPDATED_AT,
    }));
    const windowItem = { id: 'WL-other', title: 'Other', status: 'open', stage: 'idea', priority: 'medium' };

    setExecFileAsync((async (_bin: string, args: string[]) => {
      if (args.includes('next')) {
        // The active item leads the wl next window, and the "other" item is
        // also in the feed — but the 20-item selection window cuts both once
        // the 22 reviews are mandatory.
        return {
          stdout: JSON.stringify({
            success: true,
            results: [
              { workItem: activeItem },
              ...reviewItems.slice(0, 18).map((w) => ({ workItem: w })),
              { workItem: windowItem },
            ],
          }),
          stderr: '',
        };
      }
      if (args.includes('--priority')) {
        return { stdout: JSON.stringify({ success: true, workItems: [] }), stderr: '' };
      }
      if (args.includes('--stage')) {
        // Mandatory review subset: all 22 reviews (completed/in-progress).
        return { stdout: JSON.stringify({ success: true, workItems: reviewItems }), stderr: '' };
      }
      // Mandatory actively-worked in-progress subset.
      return { stdout: JSON.stringify({ success: true, workItems: [activeItem] }), stderr: '' };
    }) as never);

    // browseItemCount=20 with 22 reviews: the merged mandatory subsets plus
    // selection must guarantee the active item and every review survive, and
    // cut the non-mandatory other.
    const items = await fetchNextItems(20);
    const ids = items.map((i) => i.id);

    expect(ids).toContain('WL-active-plan');
    // All 22 mandatory reviews survive the cap too.
    expect(reviewItems.every((r) => ids.includes(r.id))).toBe(true);
    // The non-mandatory other item is cut.
    expect(ids).not.toContain('WL-other');
  });

  it('reviews arguments pass --status completed,in-progress for the mandatory review subset (WL-0MV6JGVPH009YDXB)', async () => {
    let reviewQuery: string[] | null = null;
    setExecFileAsync((async (_bin: string, args: string[]) => {
      if (args.includes('next')) {
        return { stdout: JSON.stringify({ success: true, results: [] }), stderr: '' };
      }
      if (args.includes('--priority')) {
        return { stdout: JSON.stringify({ success: true, workItems: [] }), stderr: '' };
      }
      // The mandatory review subset is the ONLY query carrying --stage; the
      // actively-worked in-progress subset (WL-0MV6KV22S004NYIU) is
      // stage-agnostic, so exclude it from the capture.
      if (args.includes('--stage')) {
        reviewQuery = args;
      }
      return { stdout: JSON.stringify({ success: true, workItems: [] }), stderr: '' };
    }) as never);

    await fetchNextItems(10);

    expect(reviewQuery).not.toBeNull();
    const statusIdx = reviewQuery!.indexOf('--status');
    expect(statusIdx).toBeGreaterThan(-1);
    const statusValue = reviewQuery![statusIdx + 1];
    expect(statusValue).toContain('in-progress');
    expect(statusValue).toContain('completed');
  });

  it('fetches actively-worked in-progress root items as a mandatory subset (WL-0MV6KV22S004NYIU)', async () => {
    const calls: string[][] = [];
    const activeItem = {
      id: 'WL-active',
      title: 'Active',
      status: 'in-progress',
      stage: 'plan_complete',
      priority: 'low',
      updatedAt: UPDATED_AT,
    };

    setExecFileAsync((async (_bin: string, args: string[]) => {
      calls.push(args);
      if (args.includes('next')) {
        // The active item is NOT in the wl next window (low priority).
        return { stdout: JSON.stringify({ success: true, results: [] }), stderr: '' };
      }
      if (args.includes('--priority')) {
        return { stdout: JSON.stringify({ success: true, workItems: [] }), stderr: '' };
      }
      if (args.includes('--stage')) {
        return { stdout: JSON.stringify({ success: true, workItems: [] }), stderr: '' };
      }
      // The stage-agnostic in-progress subset.
      return { stdout: JSON.stringify({ success: true, workItems: [activeItem] }), stderr: '' };
    }) as never);

    const items = await fetchNextItems(20);

    expect(items.map((i) => i.id)).toContain('WL-active');
    const activeQuery = calls.find((a) => a.includes('--status') && a.includes('in-progress') && !a.includes('--stage'));
    expect(activeQuery).toBeDefined();
    expect(activeQuery).toContain('--root-only');
  });
});
