/**
 * Unit tests for the extracted `wl doctor stage-sync` registration seam
 * (`src/commands/doctor/stage-sync.ts`, WL-0MW084OJQ006AL6M).
 *
 * `tests/cli/doctor-stage-sync.test.ts` remains the behaviour gate for the
 * subcommand end to end through the real CLI (unchanged by the extraction).
 * This file pins the extracted module's own contract: it registers the same
 * command surface on the parent `doctor` command and its action still behaves
 * as before when driven through the narrow injected context — a dry-run report
 * that mutates nothing, and an `--apply` run that fixes the stale items.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { WorklogDatabase } from '../src/database.js';
import {
  registerStageSyncCommand,
  type StageSyncCommandContext,
} from '../src/commands/doctor/stage-sync.js';
import { createTempDir, cleanupTempDir, createTempDbPath, createTempJsonlPath } from './test-utils.js';

function makeItem(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    title: `item ${id}`,
    description: `description for ${id}`,
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    tags: [],
    assignee: '',
    stage: 'idea',
    issueType: '',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    ...overrides,
  };
}

describe('registerStageSyncCommand', () => {
  let tempDir: string;
  let db: WorklogDatabase;
  let jsonlPath: string;

  /** Register the subcommand on a fresh `doctor` command with a capturing context. */
  function buildProgram(onJson: (data: unknown) => void): { program: Command; ctx: StageSyncCommandContext } {
    const program = new Command();
    const doctor = program.command('doctor');
    const ctx: StageSyncCommandContext = {
      output: { json: onJson },
      dataPath: jsonlPath,
      utils: {
        requireInitialized: () => {},
        getDatabase: () => db,
        isJsonMode: () => true,
      },
    };
    registerStageSyncCommand(doctor, ctx);
    return { program, ctx };
  }

  beforeEach(() => {
    tempDir = createTempDir();
    jsonlPath = createTempJsonlPath(tempDir);
    db = new WorklogDatabase('TEST', createTempDbPath(tempDir), jsonlPath, true, true);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  it('registers the stage-sync subcommand with unchanged description and flags', () => {
    const program = new Command();
    const doctor = program.command('doctor');
    registerStageSyncCommand(doctor, {
      output: { json: () => {} },
      dataPath: jsonlPath,
      utils: {
        requireInitialized: () => {},
        getDatabase: () => db,
        isJsonMode: () => false,
      },
    });

    const stageSync = doctor.commands.find((c) => c.name() === 'stage-sync');
    expect(stageSync).toBeDefined();
    expect(stageSync!.description()).toBe('Detect and fix stale status/stage combinations');
    expect(stageSync!.options.map((o) => o.flags)).toEqual(['--apply', '--prefix <prefix>']);
  });

  it('dry-run reports stale combinations as JSON and leaves the database untouched', async () => {
    db.import(
      [
        makeItem('TEST-OK', { status: 'completed', stage: 'done' }),
        makeItem('TEST-STALE', { status: 'completed', stage: 'idea' }),
      ],
      [],
      [],
    );

    const payloads: any[] = [];
    const { program } = buildProgram((data) => payloads.push(data));

    await program.parseAsync(['node', 'wl', 'doctor', 'stage-sync']);

    expect(payloads).toHaveLength(1);
    const payload = payloads[0];
    expect(payload.dryRun).toBe(true);
    expect(payload.totalItems).toBe(2);
    expect(payload.staleCount).toBe(1);
    expect(payload.staleItems).toContainEqual({
      id: 'TEST-STALE',
      title: 'item TEST-STALE',
      current: { status: 'completed', stage: 'idea' },
      proposed: { status: 'completed', stage: 'done' },
    });

    // Dry-run must not write.
    expect(db.get('TEST-STALE')!.stage).toBe('idea');
  });

  it('--apply fixes the stale items and reports the fix in JSON', async () => {
    db.import(
      [
        makeItem('TEST-OK', { status: 'completed', stage: 'done' }),
        makeItem('TEST-STALE', { status: 'in-progress', stage: 'idea' }),
      ],
      [],
      [],
    );

    const payloads: any[] = [];
    const { program } = buildProgram((data) => payloads.push(data));

    await program.parseAsync(['node', 'wl', 'doctor', 'stage-sync', '--apply']);

    expect(payloads).toHaveLength(1);
    const payload = payloads[0];
    expect(payload.fixApplied).toBe(true);
    expect(payload.totalItems).toBe(2);
    expect(payload.staleCount).toBe(1);
    expect(payload.fixedCount).toBe(1);
    expect(payload.fixed).toContainEqual({
      id: 'TEST-STALE',
      title: 'item TEST-STALE',
      from: { status: 'in-progress', stage: 'idea' },
      to: { status: 'open', stage: 'idea' },
    });
    expect(payload.errors).toEqual([]);

    const fixed = db.get('TEST-STALE')!;
    expect(fixed.status).toBe('open');
    expect(fixed.stage).toBe('idea');
  });
});
