/**
 * Unit tests for the extracted `wl doctor foreign-items` registration seam
 * (`src/commands/doctor/foreign-items.ts`, WL-0MW084MT9006M7MC).
 *
 * The process-level CLI suites (`tests/cli/doctor-foreign-items*.test.ts`)
 * remain the behaviour gate for the command surface end to end. This file
 * pins the extracted module's own contract: it registers the same command
 * surface on the parent `doctor` command and its action still behaves as
 * before when driven through the narrow injected context — dry-run reporting
 * without mutating the database, and refusing `--push` without `--apply`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { WorklogDatabase } from '../src/database.js';
import {
  registerForeignItemsCommand,
  type ForeignItemsCommandContext,
} from '../src/commands/doctor/foreign-items.js';
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
    stage: '',
    issueType: '',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    ...overrides,
  };
}

describe('registerForeignItemsCommand', () => {
  let tempDir: string;
  let db: WorklogDatabase;
  let jsonlPath: string;

  /** Register the subcommand on a fresh `doctor` command with a capturing context. */
  function buildProgram(onJson: (data: unknown) => void): { program: Command; ctx: ForeignItemsCommandContext } {
    const program = new Command();
    const doctor = program.command('doctor');
    const ctx: ForeignItemsCommandContext = {
      output: { json: onJson },
      dataPath: jsonlPath,
      utils: {
        requireInitialized: () => {},
        getConfig: () => ({ projectName: 'Test Project', prefix: 'TEST' }),
        getDatabase: () => db,
        isJsonMode: () => true,
      },
    };
    registerForeignItemsCommand(doctor, ctx);
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

  it('registers the foreign-items subcommand with unchanged description and flags', () => {
    const program = new Command();
    const doctor = program.command('doctor');
    registerForeignItemsCommand(doctor, {
      output: { json: () => {} },
      dataPath: jsonlPath,
      utils: {
        requireInitialized: () => {},
        getConfig: () => null,
        getDatabase: () => db,
        isJsonMode: () => false,
      },
    });

    const foreignItems = doctor.commands.find((c) => c.name() === 'foreign-items');
    expect(foreignItems).toBeDefined();
    expect(foreignItems!.description()).toBe(
      'Report work items whose ID prefix does not match the project prefix',
    );
    expect(foreignItems!.options.map((o) => o.flags)).toEqual([
      '--dry-run',
      '--apply',
      '--push',
      '--prefix <prefix>',
    ]);
  });

  it('dry-run reports foreign items as JSON and leaves the database untouched', async () => {
    db.import(
      [
        makeItem('TEST-001'),
        makeItem('WL-101'),
        makeItem('WL-102', { status: 'deleted' }),
        makeItem('OB-0MN9CZ48N0053L9Q'),
      ],
      [],
      [],
    );

    const payloads: any[] = [];
    const { program } = buildProgram((data) => payloads.push(data));

    await program.parseAsync(['node', 'wl', 'doctor', 'foreign-items', '--dry-run']);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      dryRun: true,
      prefix: 'TEST',
      totalItems: 4,
      foreignCount: 3,
      deletedForeignCount: 1,
      nonDeletedForeignCount: 2,
    });
    expect(payloads[0].byPrefix.WL).toEqual({
      count: 2,
      deleted: 1,
      nonDeleted: 1,
      ids: ['WL-101', 'WL-102'],
    });
    expect(payloads[0].byPrefix.OB).toEqual({
      count: 1,
      deleted: 0,
      nonDeleted: 1,
      ids: ['OB-0MN9CZ48N0053L9Q'],
    });
    // Dry-run must never mutate the store.
    expect(db.getAll().map((i) => i.id).sort()).toEqual([
      'OB-0MN9CZ48N0053L9Q',
      'TEST-001',
      'WL-101',
      'WL-102',
    ]);
  });

  it('refuses --push without --apply and keeps foreign items in the database', async () => {
    db.import([makeItem('TEST-001'), makeItem('WL-101')], [], []);

    const payloads: any[] = [];
    const { program } = buildProgram((data) => payloads.push(data));

    await program.parseAsync(['node', 'wl', 'doctor', 'foreign-items', '--push']);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      success: false,
      error: '--push requires --apply: the remote ref can only be rewritten after foreign items are removed from the database.',
    });
    expect(db.getAll().map((i) => i.id).sort()).toEqual(['TEST-001', 'WL-101']);
  });
});
