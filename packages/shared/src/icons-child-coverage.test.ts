/**
 * packages/shared/src/icons-child-coverage.test.ts — Derived child-audit
 * coverage (WL-0MUBVH8QG0020H9L).
 *
 * A child (`parentId` set) is COVERED iff its direct parent (depth 1) has a
 * fresh audit, decided by the single shared `isAuditFresh` predicate over the
 * parent's `auditedAt`/`updatedAt`/`fingerprint`/`currentFingerprint`. Nothing
 * is persisted and no schema migration is introduced (AC1).
 *
 * The display helpers (`stageDisplayIcon`, `getIconPrefixParts`) render the
 * parent's audit-result symbol for a covered child — greyed by the renderer —
 * and fall back to `[COVERED]` in `noIcons` mode (AC3). An item's OWN audit
 * result always wins over inherited coverage, a stale parent audit reverts a
 * previously covered child to the plain stage icon, and uncovered children
 * stay honest (plain stage icon) (AC4/AC5).
 *
 * Run: npx vitest run packages/shared/src/icons-child-coverage.test.ts
 */
import { describe, it, expect } from 'vitest';
// The repo-wide guard (WL-0MT2GMTAZ003VKVL) forbids importing an `icons.js`
// path directly; import the package re-export instead.
import {
  getIconPrefix,
  getIconPrefixParts,
  isCoveredByParent,
  stageDisplayIcon,
  type ParentAuditState,
} from '@worklog/shared/icons';

// Shared, dependency-free glyph constants (see icons.ts).
const AUDIT_READY = '\u{2705}'; // ✅
const AUDIT_NOT_READY = '\u{274C}'; // ❌
const AUDIT_UNKNOWN = '\u{2753}'; // ❓
const AUDIT_STALE_PASSED = '\u{23F3}'; // ⏳
const STAGE_IN_REVIEW = '\u{1F50D}'; // 🔍

// Parent audit fixtures. The default time gate (60 s) is used because no
// fingerprints are supplied.
const FRESH_PARENT: ParentAuditState = {
  auditResult: true,
  auditedAt: '2026-08-02T10:00:30.000Z',
  updatedAt: '2026-08-02T10:00:00.000Z',
};
const STALE_PARENT: ParentAuditState = {
  auditResult: true,
  auditedAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-02T10:00:00.000Z',
};

/** A completed/in_review child with no own audit. */
function child(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stage: 'in_review',
    parentId: 'WL-PARENT',
    auditResult: null,
    auditedAt: null,
    updatedAt: '2026-08-02T10:00:00.000Z',
    parentAudit: FRESH_PARENT,
    ...over,
  };
}

describe('isCoveredByParent — derived coverage via the shared isAuditFresh predicate (AC1)', () => {
  it('returns false for a root item (no parentId)', () => {
    expect(isCoveredByParent({ parentId: null }, FRESH_PARENT)).toBe(false);
    expect(isCoveredByParent({}, FRESH_PARENT)).toBe(false);
  });

  it('returns false when the parent audit state is unavailable (never guesses)', () => {
    expect(isCoveredByParent({ parentId: 'WL-P' }, undefined)).toBe(false);
    expect(isCoveredByParent({ parentId: 'WL-P' }, null)).toBe(false);
  });

  it('returns true when the direct parent has a fresh audit (time gate)', () => {
    expect(isCoveredByParent({ parentId: 'WL-P' }, FRESH_PARENT)).toBe(true);
  });

  it('returns false when the direct parent audit is stale', () => {
    expect(isCoveredByParent({ parentId: 'WL-P' }, STALE_PARENT)).toBe(false);
  });

  it('uses the fingerprint gate when both fingerprints are present (fresh despite old updatedAt)', () => {
    const parent: ParentAuditState = {
      auditResult: true,
      auditedAt: '2026-08-02T10:00:00.000Z',
      updatedAt: '2026-08-03T10:00:00.000Z', // far later
      fingerprint: 'abc123',
      currentFingerprint: 'abc123',
    };
    expect(isCoveredByParent({ parentId: 'WL-P' }, parent)).toBe(true);
  });

  it('returns false when the parent fingerprint mismatches (content changed)', () => {
    const parent: ParentAuditState = {
      auditResult: true,
      auditedAt: '2026-08-02T10:00:00.000Z',
      updatedAt: '2026-08-02T10:00:00.000Z',
      fingerprint: 'old',
      currentFingerprint: 'new',
    };
    expect(isCoveredByParent({ parentId: 'WL-P' }, parent)).toBe(false);
  });

  it('returns false when the parent has no audit at all', () => {
    expect(isCoveredByParent({ parentId: 'WL-P' }, { auditedAt: null })).toBe(false);
  });
});

describe('stageDisplayIcon — covered child renders the parent audit symbol (AC3)', () => {
  it('renders the passing parent verdict (✅)', () => {
    expect(stageDisplayIcon(child())).toBe(AUDIT_READY);
  });

  it('renders the failing parent verdict (❌)', () => {
    expect(stageDisplayIcon(child({ parentAudit: { ...FRESH_PARENT, auditResult: false } }))).toBe(
      AUDIT_NOT_READY,
    );
  });

  it('renders the unknown parent verdict (❓) when the parent audit result is null', () => {
    expect(stageDisplayIcon(child({ parentAudit: { ...FRESH_PARENT, auditResult: null } }))).toBe(
      AUDIT_UNKNOWN,
    );
  });

  it('falls back to the plain in_review stage icon for an uncovered child', () => {
    // No parent audit state at all → genuinely uncovered.
    expect(stageDisplayIcon(child({ parentAudit: null }))).toBe(STAGE_IN_REVIEW);
    // Stale parent audit → uncovered.
    expect(stageDisplayIcon(child({ parentAudit: STALE_PARENT }))).toBe(STAGE_IN_REVIEW);
  });

  it('reverts a previously covered child to uncovered when the parent audit becomes stale (AC5c)', () => {
    expect(stageDisplayIcon(child({ parentAudit: FRESH_PARENT }))).toBe(AUDIT_READY);
    expect(stageDisplayIcon(child({ parentAudit: STALE_PARENT }))).toBe(STAGE_IN_REVIEW);
  });

  it('never applies coverage to a root item', () => {
    expect(stageDisplayIcon(child({ parentId: null }))).toBe(STAGE_IN_REVIEW);
  });

  it('renders the [COVERED] text fallback in noIcons mode so coverage is never dropped', () => {
    expect(stageDisplayIcon(child(), { noIcons: true })).toBe('[COVERED]');
  });
});

describe('stageDisplayIcon — an item\'s own audit always wins over inherited coverage (AC5d)', () => {
  it('shows the child\'s own fresh audit result, not the parent\'s', () => {
    const own = child({
      auditResult: false, // own fresh failed verdict
      auditedAt: '2026-08-02T10:00:30.000Z',
      parentAudit: { ...FRESH_PARENT, auditResult: true },
    });
    expect(stageDisplayIcon(own)).toBe(AUDIT_NOT_READY);
  });

  it('shows the child\'s own stale-passed hourglass, not the parent\'s verdict', () => {
    const own = child({
      auditResult: true,
      auditedAt: '2026-08-01T10:00:00.000Z', // stale
      parentAudit: { ...FRESH_PARENT, auditResult: false },
    });
    expect(stageDisplayIcon(own)).toBe(AUDIT_STALE_PASSED);
  });

  it('keeps a child\'s own stale-failed audit honest rather than inheriting coverage', () => {
    const own = child({
      auditResult: false,
      auditedAt: '2026-08-01T10:00:00.000Z', // stale
      parentAudit: FRESH_PARENT,
    });
    // Existing behaviour: a stale-failed own audit shows the plain stage icon.
    expect(stageDisplayIcon(own)).toBe(STAGE_IN_REVIEW);
  });
});

describe('getIconPrefixParts — exposes the stage icon range for dimming (AC3)', () => {
  const coveredChild = {
    status: 'completed',
    stage: 'in_review',
    parentId: 'WL-PARENT',
    auditResult: null,
    auditedAt: null,
    updatedAt: '2026-08-02T10:00:00.000Z',
    parentAudit: FRESH_PARENT,
  };

  it('points the stage range at the covered (parent) audit symbol', () => {
    const parts = getIconPrefixParts(coveredChild);
    expect(parts.text.slice(parts.stageStart, parts.stageEnd)).toBe(AUDIT_READY);
    expect(parts.text).toBe(getIconPrefix(coveredChild));
  });

  it('points the stage range at the plain stage icon for an uncovered child', () => {
    const parts = getIconPrefixParts({ ...coveredChild, parentId: null });
    expect(parts.text.slice(parts.stageStart, parts.stageEnd)).toBe(STAGE_IN_REVIEW);
  });

  it('exposes the [COVERED] fallback in noIcons mode', () => {
    const parts = getIconPrefixParts(coveredChild, { noIcons: true });
    expect(parts.text.slice(parts.stageStart, parts.stageEnd)).toBe('[COVERED]');
  });
});
