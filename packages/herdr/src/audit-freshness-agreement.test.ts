/**
 * packages/herdr/src/audit-freshness-agreement.test.ts
 *
 * Cross-consumer agreement for audit freshness (WL-0MUBVH7ZR009PP80 AC4).
 *
 * `isAuditFresh` in `@worklog/shared/icons` is the single freshness
 * definition. This suite pins that the icon path (`stageDisplayIcon`), the
 * downtime-dispatch path (`selectAuditCandidate`) and the `in_review`
 * ordering path (`inReviewBucket`) all reach the same verdict as
 * `isAuditFresh` for fresh / just-persisted / stale / missing-audit inputs —
 * including the one-sided boundary (audit before vs after `updatedAt`).
 */

import { describe, it, expect } from 'vitest';
import { isAuditFresh, stageDisplayIcon } from '@worklog/shared/icons';
import { inReviewBucket } from './grouping.js';
import { selectAuditCandidate, type AuditCandidate } from './downtime-worker.js';

const BASE = Date.parse('2026-01-10T10:00:00.000Z');
const at = (offsetMs: number): string => new Date(BASE + offsetMs).toISOString();
// Within the dispatch 7-day recency window so selection is governed by
// freshness only.
const NOW = BASE + 1_000;

interface Fixture {
  name: string;
  auditedAt: string | null;
  updatedAt: string;
  fresh: boolean;
  /** `inReviewBucket` (failed audit) expected bucket. */
  bucket: 2 | 3 | 4;
  /** `stageDisplayIcon` glyph: ❌ = fresh failed audit, 🔍 = stale/no audit. */
  icon: string;
}

const AUDIT_NOT_READY = '\u{274C}'; // ❌
const IN_REVIEW_STAGE = '\u{1F50D}'; // 🔍

const FIXTURES: Fixture[] = [
  { name: 'just-persisted (auditedAt === updatedAt)', auditedAt: at(0), updatedAt: at(0), fresh: true, bucket: 2, icon: AUDIT_NOT_READY },
  { name: 'audit 30 s after updatedAt', auditedAt: at(30_000), updatedAt: at(0), fresh: true, bucket: 2, icon: AUDIT_NOT_READY },
  { name: 'audit 30 s before updatedAt', auditedAt: at(-30_000), updatedAt: at(0), fresh: true, bucket: 2, icon: AUDIT_NOT_READY },
  { name: 'audit 120 s before updatedAt (stale)', auditedAt: at(-120_000), updatedAt: at(0), fresh: false, bucket: 3, icon: IN_REVIEW_STAGE },
  { name: 'audit 120 s after updatedAt (fresh, one-sided)', auditedAt: at(120_000), updatedAt: at(0), fresh: true, bucket: 2, icon: AUDIT_NOT_READY },
  { name: 'missing audit', auditedAt: null, updatedAt: at(0), fresh: false, bucket: 4, icon: IN_REVIEW_STAGE },
];

describe('audit-freshness agreement across icon / dispatch / ordering consumers (WL-0MUBVH7ZR009PP80)', () => {
  it.each(FIXTURES)('$name → isAuditFresh agrees with each consumer', (fixture) => {
    // 1. Canonical predicate.
    expect(isAuditFresh(fixture.auditedAt, fixture.updatedAt)).toBe(fixture.fresh);

    // 2. Icon path.
    expect(
      stageDisplayIcon({
        stage: 'in_review',
        auditResult: false,
        auditedAt: fixture.auditedAt,
        updatedAt: fixture.updatedAt,
      }),
    ).toBe(fixture.icon);

    // 3. in_review ordering path.
    expect(
      inReviewBucket({
        stage: 'in_review',
        auditResult: false,
        auditedAt: fixture.auditedAt,
        updatedAt: fixture.updatedAt,
      }),
    ).toBe(fixture.bucket);

    // 4. Downtime-dispatch path: a fresh audit is never selected for
    //    re-dispatch; a stale/missing one is.
    const candidate: AuditCandidate = {
      id: 'WL-AGREE',
      title: fixture.name,
      auditedAt: fixture.auditedAt,
      updatedAt: fixture.updatedAt,
      sortIndex: 0,
    };
    const selected = selectAuditCandidate([candidate], NOW);
    if (fixture.fresh) {
      expect(selected).toBeNull();
    } else {
      expect(selected?.id).toBe('WL-AGREE');
    }
  });
});
