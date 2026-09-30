/**
 * Unit tests for the shared audit-gap classifier
 * (`classifyAuditGap` in @worklog/shared/icons, WL-0MUBVH9FV0027COG).
 *
 * These pin the precedence (waiver > fresh own audit > derived parent
 * coverage > uncovered) and prove the helper delegates freshness to the
 * single shared `isAuditFresh` predicate rather than re-implementing it.
 */

import { describe, it, expect } from 'vitest';
import { classifyAuditGap, isAuditFresh } from '@worklog/shared/icons';

const NOW = '2026-09-28T12:00:00.000Z';
const LONG_AGO = '2026-01-01T00:00:00.000Z';
const WAIVER = { reason: 'legacy', author: 'producer', waivedAt: NOW };

describe('classifyAuditGap', () => {
  it('returns none for a fresh own audit', () => {
    expect(
      classifyAuditGap({ ownAudit: { auditedAt: NOW }, updatedAt: NOW }),
    ).toBe('none');
  });

  it('returns uncovered for a root with no audit', () => {
    expect(classifyAuditGap({ updatedAt: NOW })).toBe('uncovered');
  });

  it('returns uncovered for a root with a stale audit', () => {
    expect(
      classifyAuditGap({ ownAudit: { auditedAt: LONG_AGO }, updatedAt: NOW }),
    ).toBe('uncovered');
  });

  it('returns waived for a waived root with no audit', () => {
    expect(classifyAuditGap({ updatedAt: NOW, auditWaiver: WAIVER })).toBe('waived');
  });

  it('waiver takes precedence over a stale audit', () => {
    expect(
      classifyAuditGap({
        ownAudit: { auditedAt: LONG_AGO },
        updatedAt: NOW,
        auditWaiver: WAIVER,
      }),
    ).toBe('waived');
  });

  it('returns covered for a child whose direct parent has a fresh audit', () => {
    expect(
      classifyAuditGap({
        updatedAt: NOW,
        parentId: 'TEST-PARENT',
        parentAudit: { auditedAt: NOW, updatedAt: NOW },
      }),
    ).toBe('covered');
  });

  it('returns uncovered for a child whose parent audit is stale', () => {
    expect(
      classifyAuditGap({
        updatedAt: NOW,
        parentId: 'TEST-PARENT',
        parentAudit: { auditedAt: LONG_AGO, updatedAt: NOW },
      }),
    ).toBe('uncovered');
  });

  it('returns uncovered for a child with no parent audit state', () => {
    expect(classifyAuditGap({ updatedAt: NOW, parentId: 'TEST-PARENT' })).toBe('uncovered');
  });

  it('derived coverage wins over a stale own audit', () => {
    expect(
      classifyAuditGap({
        ownAudit: { auditedAt: LONG_AGO },
        updatedAt: NOW,
        parentId: 'TEST-PARENT',
        parentAudit: { auditedAt: NOW, updatedAt: NOW },
      }),
    ).toBe('covered');
  });

  it('waiver takes precedence over derived coverage', () => {
    expect(
      classifyAuditGap({
        updatedAt: NOW,
        parentId: 'TEST-PARENT',
        auditWaiver: WAIVER,
        parentAudit: { auditedAt: NOW, updatedAt: NOW },
      }),
    ).toBe('waived');
  });

  it('delegates the primary gate to isAuditFresh (fingerprint match = fresh)', () => {
    const auditedAt = LONG_AGO; // time gate alone would call this stale
    expect(isAuditFresh(auditedAt, NOW)).toBe(false);
    expect(
      classifyAuditGap({
        ownAudit: { auditedAt, fingerprint: 'fp-match' },
        updatedAt: NOW,
        currentFingerprint: 'fp-match',
      }),
    ).toBe('none');
  });

  it('delegates the primary gate to isAuditFresh (fingerprint mismatch = uncovered)', () => {
    expect(
      classifyAuditGap({
        ownAudit: { auditedAt: NOW, fingerprint: 'stored' },
        updatedAt: NOW,
        currentFingerprint: 'current',
      }),
    ).toBe('uncovered');
  });
});
