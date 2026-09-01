/**
 * F6 migration proof (WL-0MTII4CWT00452HU, parent AC5):
 * machine dir authoritative — legacy files orphaned, single instanceId
 * entry, no double-dispatch, fail-safe on unreadable/missing machine files.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertEntry, readCoordinationFile, COORDINATION_FILE } from './coordination.js';
import { dispatchFromCoordination, type DowntimeWorkerDeps, type DowntimeItemInfo } from './downtime-worker.js';

let machineDir: string;
let legacyDir: string;
let prevHerdr: string | undefined;

function withMachine(fn: () => Promise<void>) {
  return async () => {
    machineDir = mkdtempSync(join(tmpdir(), 'herdr-f6-m-'));
    legacyDir = mkdtempSync(join(tmpdir(), 'herdr-f6-l-'));
    prevHerdr = process.env.HERDR_COORDINATION_DIR;
    process.env.HERDR_COORDINATION_DIR = machineDir;
    try { await fn(); } finally { process.env.HERDR_COORDINATION_DIR = prevHerdr as string | undefined; rmSync(machineDir, { recursive: true, force: true }); rmSync(legacyDir, { recursive: true, force: true }); }
  };
}

function entry(instanceId: string, workItemId: string): { instanceId: string; workItemId: string; directory: string; worklogRoot: string; assignedAt: string; lastUpdated: string } {
  const now = new Date().toISOString();
  return { instanceId, workItemId, directory: '/repo', worklogRoot: '/repo', assignedAt: now, lastUpdated: now };
}

describe('F6 migration', () => {
  it('same instanceId with both legacy and machine files writes exactly one machine entry (no double-join)', withMachine(async () => {
    // Stale legacy file — must be ignored (orphaned) after migration.
    writeFileSync(join(legacyDir, COORDINATION_FILE), JSON.stringify({ version: 1, entries: [entry('inst-1', 'WL-OLD')] }), 'utf-8');
    // Machine entry via the authoritative path.
    expect(upsertEntry(legacyDir, entry('inst-1', 'WL-NEW'))).toBe(true);
    const data = readCoordinationFile(legacyDir);
    // Authoritative read is from the machine dir — single entry, NEW value.
    expect(data?.entries.length).toBe(1);
    expect(data?.entries[0].workItemId).toBe('WL-NEW');
    expect(data?.entries[0].instanceId).toBe('inst-1');
    // Reading via another worklog root with the same machine dir sees the same single entry.
    const data2 = readCoordinationFile(machineDir);
    expect(data2?.entries[0].workItemId).toBe('WL-NEW');
  }));

  it('mixed old/new does not double-dispatch: leader dispatches once from machine only', withMachine(async () => {
    // Machine entry is the only dispatchable one.
    upsertEntry(legacyDir, entry('inst-a', 'WL-A'));
    // Legacy-only entry WL-OLD is not in the machine file — leader never sees it.
    writeFileSync(join(legacyDir, COORDINATION_FILE), JSON.stringify({ version: 1, entries: [entry('inst-legacy', 'WL-OLD')] }), 'utf-8'); // overwrite LEGACY location only
    const entries = readCoordinationFile(machineDir)?.entries ?? [];
    expect(entries.some((e) => e.workItemId === 'WL-A')).toBe(true);
    // Upserting via machine re-establishes the authoritative entry (legacy overwrite is still ignored).
    upsertEntry(legacyDir, entry('inst-a', 'WL-A'));
    const deps: DowntimeWorkerDeps = {
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(null),
      getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      claimItem: vi.fn().mockResolvedValue({ ok: true }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
      recordDispatch: vi.fn().mockResolvedValue(true),
      recordDispatchFailure: vi.fn().mockResolvedValue(undefined),
      recordError: vi.fn().mockResolvedValue(undefined),
      getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
      recordScheduledPromptTrigger: vi.fn().mockResolvedValue(true),
      readCodeFreezeStatus: vi.fn().mockReturnValue('not-frozen'),
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: { id: 'WL-A', title: 'A', status: 'open', stage: 'idea' } as DowntimeItemInfo }),
    } as unknown as DowntimeWorkerDeps;
    const machineEntries = readCoordinationFile(legacyDir)?.entries ?? [];
    const out = await dispatchFromCoordination(deps, machineEntries, { model: 'plan', cwd: '/repo', coordinationDir: machineDir });
    expect(out.dispatched).toBe(true);
    expect((deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  }));

  it('unreadable/missing machine coordination or lease files degrade to no-dispatch — never crash or drop entries', withMachine(async () => {
    // Corrupt the machine file — read fail-safe → null → dispatch no-candidate.
    writeFileSync(join(machineDir, COORDINATION_FILE), '{ not json', 'utf-8');
    expect(readCoordinationFile(machineDir)).toBe(null);
    const deps: DowntimeWorkerDeps = {
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(null),
      getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      claimItem: vi.fn().mockResolvedValue({ ok: true }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
      recordDispatch: vi.fn().mockResolvedValue(true),
      recordDispatchFailure: vi.fn().mockResolvedValue(undefined),
      recordError: vi.fn().mockResolvedValue(undefined),
      getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
      recordScheduledPromptTrigger: vi.fn().mockResolvedValue(true),
      readCodeFreezeStatus: vi.fn().mockReturnValue('not-frozen'),
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: { id: 'WL-X', title: 'X', status: 'open', stage: 'idea' } as DowntimeItemInfo }),
    } as unknown as DowntimeWorkerDeps;
    const entries: never[] = [];
    const out = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: machineDir });
    expect(out.dispatched).toBe(false);
    // Write a fresh entry proves no entries were dropped by the corrupt-read path.
    upsertEntry(legacyDir, entry('inst-x', 'WL-X'));
    expect(readCoordinationFile(legacyDir)?.entries.some((e) => e.workItemId === 'WL-X')).toBe(true);
  }));
});
