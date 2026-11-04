/**
 * Unit tests for the extracted `wl doctor migrate` registration seam
 * (`src/commands/doctor/migrate.ts`, WL-0MW084KKS003X4TJ).
 *
 * No dedicated migrate CLI suite exists, so this file pins the extracted
 * module's own contract: it registers the same command surface on the parent
 * `doctor` command, and the moved action still behaves as before when driven
 * through the narrow injected context (default/absent JSONL, import into an
 * empty database, merge into a populated one, and `--delete`) — never through
 * the registrar or the full `PluginContext`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { WorklogDatabase } from '../src/database.js';
import { exportToJsonl } from '../src/jsonl.js';
import { registerMigrateCommand, type MigrateCommandContext } from '../src/commands/doctor/migrate.js';
import {
  createTempDir,
  cleanupTempDir,
  createTempDbPath,
  createTempJsonlPath,
} from './test-utils.js';

describe('registerMigrateCommand', () => {
  let tempDir: string;
  let db: WorklogDatabase;
  let dataPath: string;

  /** Build a `doctor` command whose injected context captures JSON payloads. */
  function buildProgram(
    dbInstance: WorklogDatabase,
    onJson: (data: unknown) => void,
  ): { program: Command; ctx: MigrateCommandContext } {
    const program = new Command();
    const doctor = program.command('doctor');
    const ctx: MigrateCommandContext = {
      output: { json: onJson },
      dataPath,
      utils: {
        requireInitialized: () => {},
        getDatabase: () => dbInstance,
        isJsonMode: () => true,
      },
    };
    registerMigrateCommand(doctor, ctx);
    return { program, ctx };
  }

  beforeEach(() => {
    tempDir = createTempDir();
    const dbPath = createTempDbPath(tempDir);
    dataPath = createTempJsonlPath(tempDir);
    if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath);
    db = new WorklogDatabase('MIGT', dbPath, dataPath, true, false);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  it('registers the migrate subcommand with unchanged description and flags', () => {
    const { ctx } = buildProgram(db, () => {});
    const doctor = new Command();
    registerMigrateCommand(doctor, ctx);

    const migrate = doctor.commands.find((c) => c.name() === 'migrate');
    expect(migrate).toBeDefined();
    expect(migrate!.description()).toBe(
      'Migrate from persistent JSONL to SQLite-only architecture (ephemeral JSONL pattern)',
    );
    expect(migrate!.options.map((o) => o.flags)).toEqual([
      '-f, --file <filepath>',
      '--prefix <prefix>',
      '--delete',
    ]);
  });

  it('reports "no migration needed" when the JSONL file is absent', async () => {
    const payloads: any[] = [];
    const missing = path.join(tempDir, 'does-not-exist.jsonl');
    const { program } = buildProgram(db, (d) => payloads.push(d));

    await program.parseAsync(['node', 'wl', 'doctor', 'migrate', '--file', missing]);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      success: true,
      message: 'No JSONL file found. Your data is already in SQLite format.',
      migrated: false,
    });
  });

  it('imports every JSONL record into an empty database and keeps the file', async () => {
    // Fixture comes from a separate source store so the target db is empty.
    const sourceDir = path.join(tempDir, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    const source = new WorklogDatabase(
      'MIGS',
      path.join(sourceDir, 'source.db'),
      path.join(sourceDir, 'source.jsonl'),
      true,
      false,
    );
    const imported = source.create({ title: 'Imported item', status: 'open' });
    const importedComment = source.createComment({
      workItemId: imported.id,
      author: 'tester',
      comment: 'a comment',
    })!;
    exportToJsonl(source.getAll(), source.getAllComments(), dataPath);
    source.close();
    expect(fs.existsSync(dataPath)).toBe(true);

    const payloads: any[] = [];
    const { program } = buildProgram(db, (d) => payloads.push(d));

    await program.parseAsync(['node', 'wl', 'doctor', 'migrate', '--file', dataPath]);

    expect(payloads).toHaveLength(1);
    expect(payloads[0].migrated).toBe(true);
    expect(payloads[0].itemsImported).toBe(1);
    expect(payloads[0].commentsImported).toBe(1);
    expect(payloads[0].file).toBe(dataPath);
    expect(db.getAll().map((i) => i.title)).toEqual(['Imported item']);
    expect(db.getAllComments().map((c) => c.id)).toContain(importedComment.id);
    // Without `--delete` the JSONL source is preserved.
    expect(fs.existsSync(dataPath)).toBe(true);
  });

  it('merges into a populated database instead of replacing local rows', async () => {
    const sourceDir = path.join(tempDir, 'source-merge');
    fs.mkdirSync(sourceDir, { recursive: true });
    const source = new WorklogDatabase(
      'MIGS',
      path.join(sourceDir, 'source.db'),
      path.join(sourceDir, 'source.jsonl'),
      true,
      false,
    );
    source.create({ title: 'From JSONL' });
    exportToJsonl(source.getAll(), source.getAllComments(), dataPath);
    source.close();

    const local = db.create({ title: 'Local only' });
    expect(db.getAll().map((i) => i.title)).toEqual(['Local only']);

    const payloads: any[] = [];
    const { program } = buildProgram(db, (d) => payloads.push(d));

    await program.parseAsync(['node', 'wl', 'doctor', 'migrate', '--file', dataPath]);

    const payload = payloads[0];
    expect(payload.migrated).toBe(true);
    expect(payload.message).toContain('Merged 1 work items');
    expect(payload.itemsMerged).toBe(0); // no conflicting edits, both survive
    const titles = db.getAll().map((i) => i.title).sort();
    expect(titles).toEqual(['From JSONL', 'Local only']);
    expect(db.get(local.id)).toBeDefined();
  });

  it('deletes the JSONL file only when --delete is passed', async () => {
    const sourceDir = path.join(tempDir, 'source-delete');
    fs.mkdirSync(sourceDir, { recursive: true });
    const source = new WorklogDatabase(
      'MIGS',
      path.join(sourceDir, 'source.db'),
      path.join(sourceDir, 'source.jsonl'),
      true,
      false,
    );
    source.create({ title: 'Imported item' });
    exportToJsonl(source.getAll(), source.getAllComments(), dataPath);
    source.close();

    const payloads: any[] = [];
    const { program } = buildProgram(db, (d) => payloads.push(d));

    await program.parseAsync(['node', 'wl', 'doctor', 'migrate', '--file', dataPath, '--delete']);

    expect(payloads[0].migrated).toBe(true);
    expect(fs.existsSync(dataPath)).toBe(false);
  });
});
