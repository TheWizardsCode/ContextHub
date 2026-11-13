/**
 * Documentation contract for the downtime coordination representation
 * (WL-0MW2FDK83007TU6Y, AC6 of WL-0MW1VINII003IL7R).
 *
 * The leader block was added because the coordination file's `entries` array is
 * an OFFER list: a check-in removes the instance's own entry whenever its
 * window is empty, so the one instance permitted to dispatch could be absent
 * from the file entirely. The documentation originally claimed the opposite —
 * that a stable `instanceId` "writes exactly one machine entry" — which the
 * behaviour never guaranteed and which hid a machine-wide stop for eight hours
 * during the 2026-11-04 outage.
 *
 * This suite pins the corrected prose so docs and behaviour cannot drift
 * silently again:
 *
 *  - the corrected representation paragraph is present (offer list, a bounded
 *    `offers` array per entry since v2, zero entries while the window is empty,
 *    the `leader` block as the liveness record),
 *  - the stale "exactly one machine entry" claim is absent from every section
 *    of the page (it also appeared in the leader-election bullet and the
 *    migration section),
 *  - the identifiers the page names still exist in the module it points at, so
 *    a rename cannot rot the reference.
 *
 * v2 update (parent WL-0MWDDHQON0015T3P): the file still holds at most one
 * entry per instance, but that entry now carries up to three bucket offers, so
 * the prose assertions were widened from "one offer per instance" to "one
 * entry with a bounded offers array". The anti-stale-claim guard keeps the
 * "exactly one machine entry" prohibition; the v1-era "stores one entry per
 * instance" pattern is dropped because one entry per instance remains the v2
 * shape (the count of OFFERS is what changed).
 *
 * Behaviour itself is covered by `packages/herdr/src/coordination-leader.test.ts`;
 * this suite covers only the operator-facing half.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const DISPATCHER_DOC = path.join(REPO_ROOT, 'docs', 'dev', 'downtime-dispatcher.md');
const COORDINATION_MODULE = path.join(
  REPO_ROOT,
  'packages',
  'herdr',
  'src',
  'coordination.ts',
);

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

const dispatcherDoc = read(DISPATCHER_DOC);
const coordinationModule = read(COORDINATION_MODULE);

/**
 * Prose assertions run against a whitespace-flattened view so a reflow of the
 * paragraph (Markdown wrapping is not a contract) cannot fail a claim.
 */
const flatDoc = dispatcherDoc.replace(/\s+/g, ' ');

describe('downtime-dispatcher documents the coordination representation', () => {
  it('states that `entries` is an offer list with a bounded per-bucket offers array', () => {
    expect(flatDoc).toContain(
      'The machine file does **not** carry "exactly one entry per instance"',
    );
    expect(flatDoc).toContain('`entries` is an OFFER list');
    // v2: one entry per instance, carrying at most three offers.
    expect(flatDoc).toContain('an `instanceId` holds **at most one entry**');
    expect(flatDoc).toContain('(upsert, never a duplicate)');
    expect(flatDoc).toContain('carries a bounded `offers` array');
  });

  it('states that an instance may hold no entry and that the leader block records liveness', () => {
    // The behaviour the stale claim contradicted: no entry while the window is
    // empty, and an entry that survives a single offer dispatch until drained.
    expect(flatDoc).toContain('or **no** entry at all while its window is empty');
    expect(flatDoc).toContain(
      'a dispatched offer no longer drops the whole entry',
    );
    expect(flatDoc).toContain(
      "the top-level `leader` block, not an entry, is what records the lease holder's liveness",
    );
  });

  it('keeps the legacy-retirement guarantees: no double-dispatch and fail-safe reads', () => {
    expect(flatDoc).toContain('never double-dispatches from legacy data');
    expect(flatDoc).toContain('a stale legacy file can never resurrect an offer');
    expect(flatDoc).toContain('no dispatch this cycle');
  });

  it('keeps the migration section consistent with the same representation', () => {
    expect(flatDoc).toContain(
      'a stable `instanceId` writes at most one `entries` offer regardless of stale legacy file presence',
    );
    expect(flatDoc).toContain(
      'and none at all while its window is empty, in which case the top-level `leader` block (above) is what records it',
    );
  });

  it('keeps the leader block documented as evidence that is never an offer', () => {
    expect(flatDoc).toContain('The leader block (WL-0MW1VINII003IL7R).');
    expect(flatDoc).toContain('It is evidence, never an offer.');
    expect(flatDoc).toContain(
      '`getLeader()` returns `null` for an absent, malformed or **stale** block',
    );
  });

  it('introduces the machine file as an offer list, not a per-instance entry table', () => {
    expect(flatDoc).toContain('stores one entry per herdr instance');
    expect(flatDoc).toContain('plus a bounded `offers` array');
    expect(flatDoc).toContain(
      'and no entry at all for an instance whose window is empty',
    );
  });

  it('contains no stale "exactly one machine entry" claim anywhere on the page', () => {
    // The F6 wording the audit flagged (docs/dev/downtime-dispatcher.md:383) and
    // its siblings in the leader-election bullet and migration section.
    expect(dispatcherDoc).not.toMatch(/exactly one machine entry/i);
    expect(dispatcherDoc).not.toMatch(/single machine entry/i);
    expect(dispatcherDoc).not.toMatch(/one machine entry per/i);
    expect(dispatcherDoc).not.toMatch(/writes exactly one\b[^.]{0,40}\bentry/i);
    // v2 guard: the old single-offer claim is gone too (an entry now advertises
    // up to one nominee per bucket, never "exactly one offer").
    expect(dispatcherDoc).not.toMatch(/exactly one offer per (?:herdr )?instance/i);
  });

  it('names only identifiers that still exist in the coordination module', () => {
    // The page points at `packages/herdr/src/coordination.ts`; the symbols it
    // names there must survive a refactor, or the reference silently rots.
    expect(flatDoc).toContain('`packages/herdr/src/coordination.ts`');
    for (const symbol of [
      'removeEntry',
      'hasPeerOffer',
      'getLeader',
      'DEFAULT_LEADER_BLOCK_STALE_MS',
    ]) {
      expect(flatDoc).toContain(symbol);
    }
    // ... and the write path the prose describes still exists in the module.
    for (const symbol of [
      'upsertEntry',
      'removeEntry',
      'upsertLeader',
      'getLeader',
      'hasPeerOffer',
      'DEFAULT_LEADER_BLOCK_STALE_MS',
    ]) {
      expect(coordinationModule).toContain(symbol);
    }
  });
});
