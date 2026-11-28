/**
 * packages/herdr/src/dispatcher-start-log.test.ts — the once-per-start
 * running-code freshness record and stale-runtime warning
 * (WL-0MWWMPDVM009LTQR).
 *
 * Covers the acceptance criteria directly:
 *  - a dispatcher start writes ONE `kind: 'dispatcher-start'` log record
 *    carrying the loaded source commit and process start time;
 *  - every subsequent coordination-log entry carries the same source fields
 *    while the ambient identity is configured, so a dispatch record can be
 *    tied to a source commit without `ps` archaeology;
 *  - a stale runtime produces exactly ONE actionable warning;
 *  - every failure path is fail-open (no throw, no crash).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendCoordinationLogEntry, readCoordinationLogEntries } from './downtime-log.js';
import { logDispatcherStart } from './dispatcher-start-log.js';
import {
  configureDispatcherSourceIdentity,
  resetDispatcherSourceIdentityForTests,
  type RuntimeSourceIdentity,
} from './source-identity.js';

const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const AT = '2026-11-24T13:00:00.000Z';

function identity(overrides: Partial<RuntimeSourceIdentity> = {}): RuntimeSourceIdentity {
  return {
    commit: COMMIT,
    shortCommit: COMMIT.slice(0, 9),
    committedAt: '2026-11-24T12:19:00.000Z',
    startedAt: '2026-11-24T12:00:00.000Z',
    stale: false,
    ...overrides,
  };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatcher-start-log-'));
});

afterEach(() => {
  resetDispatcherSourceIdentityForTests();
  rmSync(root, { recursive: true, force: true });
});

describe('logDispatcherStart', () => {
  it('records ONE dispatcher-start entry with the loaded source identity', async () => {
    const appended: { cwd: string; entry: Record<string, unknown> }[] = [];
    await logDispatcherStart('instance-1', root, identity(), {
      append: async (cwd, entry) => {
        appended.push({ cwd, entry: entry as unknown as Record<string, unknown> });
      },
      now: () => Date.parse(AT),
      warn: () => undefined,
    });
    expect(appended).toHaveLength(1);
    expect(appended[0].cwd).toBe(root);
    expect(appended[0].entry).toMatchObject({
      kind: 'dispatcher-start',
      operation: 'start',
      instanceId: 'instance-1',
      sourceCommit: COMMIT,
      sourceStartedAt: '2026-11-24T12:00:00.000Z',
      sourceStale: false,
      at: AT,
    });
  });

  it('emits exactly ONE actionable warning for a stale runtime', async () => {
    const warnings: string[] = [];
    await logDispatcherStart('instance-1', root, identity({ stale: true }), {
      append: async () => undefined,
      now: () => Date.parse(AT),
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('stale code');
    expect(warnings[0]).toContain('Restart the Worklog plugin pane');
  });

  it('emits no warning for a current runtime', async () => {
    const warnings: string[] = [];
    await logDispatcherStart('instance-1', root, identity(), {
      append: async () => undefined,
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
  });

  it('still records the start (without source fields) when identity is unavailable', async () => {
    const appended: Record<string, unknown>[] = [];
    await logDispatcherStart('instance-1', root, null, {
      append: async (_cwd, entry) => {
        appended.push(entry as unknown as Record<string, unknown>);
      },
      warn: () => {
        throw new Error('must not warn without an identity');
      },
    });
    expect(appended).toHaveLength(1);
    expect(appended[0].kind).toBe('dispatcher-start');
    expect(appended[0]).not.toHaveProperty('sourceCommit');
  });

  it('never throws when the log write fails (fail-closed)', async () => {
    const warnings: string[] = [];
    await expect(
      logDispatcherStart('instance-1', root, identity({ stale: true }), {
        append: async () => {
          throw new Error('disk full');
        },
        warn: (message) => warnings.push(message),
      }),
    ).resolves.toBeUndefined();
    // The warning is independent of the log write and still lands.
    expect(warnings).toHaveLength(1);
  });

  it('writes a readable dispatcher-start record to the real coordination log', async () => {
    await logDispatcherStart('instance-1', root, identity(), {
      now: () => Date.parse(AT),
      warn: () => undefined,
    });
    const entries = await readCoordinationLogEntries(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'dispatcher-start',
      operation: 'start',
      instanceId: 'instance-1',
      sourceCommit: COMMIT,
      at: AT,
    });
  });
});

describe('coordination-log freshness annotation', () => {
  it('attaches the source identity to every entry while configured', async () => {
    configureDispatcherSourceIdentity(identity({ stale: true }));
    await appendCoordinationLogEntry(root, {
      kind: 'decision',
      operation: 'dispatch',
      outcome: 'dispatched',
      instanceId: 'instance-1',
      reason: 'dispatched',
      at: AT,
    });
    const [entry] = await readCoordinationLogEntries(root);
    expect(entry).toMatchObject({
      reason: 'dispatched',
      sourceCommit: COMMIT,
      sourceStartedAt: '2026-11-24T12:00:00.000Z',
      sourceStale: true,
    });
  });

  it('keeps the pre-feature log shape when no identity is configured', async () => {
    await appendCoordinationLogEntry(root, {
      kind: 'decision',
      operation: 'no-dispatch',
      instanceId: 'instance-1',
      reason: 'no-candidate',
      at: AT,
    });
    const [entry] = await readCoordinationLogEntries(root);
    expect(entry).toMatchObject({ reason: 'no-candidate' });
    expect(entry).not.toHaveProperty('sourceCommit');
    expect(entry).not.toHaveProperty('sourceStartedAt');
    expect(entry).not.toHaveProperty('sourceStale');
  });

  it('lets an explicit entry value win over the ambient identity', async () => {
    configureDispatcherSourceIdentity(identity());
    await appendCoordinationLogEntry(root, {
      kind: 'dispatcher-start',
      operation: 'start',
      instanceId: 'instance-1',
      sourceCommit: 'ffffffffffffffffffffffffffffffffffffffff',
      at: AT,
    });
    const [entry] = await readCoordinationLogEntries(root);
    expect(entry.sourceCommit).toBe('ffffffffffffffffffffffffffffffffffffffff');
  });
});
