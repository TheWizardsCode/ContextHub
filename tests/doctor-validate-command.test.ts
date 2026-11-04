/**
 * Unit tests for the extracted root `wl doctor` action seam
 * (`src/commands/doctor/validate.ts`, WL-0MW084SFD009WBWB).
 *
 * `tests/cli/doctor-*.test.ts` and `tests/doctor-*.test.ts` remain the
 * behaviour gate for the root action end to end through the real CLI (unchanged
 * by the extraction). This file pins the extracted module's own contract: it
 * attaches the root action to the parent `doctor` command (whose definition
 * stays in the registrar) and the action still validates, reports, and fixes
 * through the narrow injected context, never the registrar or the full
 * `PluginContext`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { WorklogDatabase } from '../src/database.js';
import {
  registerValidateCommand,
  type ValidateCommandContext,
} from '../src/commands/doctor/validate.js';
import type { WorklogConfig } from '../src/types.js';
import {
  createTempDir,
  cleanupTempDir,
  createTempDbPath,
  createTempJsonlPath,
} from './test-utils.js';

/**
 * The status/stage rules the injected `getConfig` returns — the production
 * shape without the retired `in_progress` stage, so status/stage validation is
 * quiet for the items these tests seed and only the priority findings under
 * test are reported.
 */
const config: WorklogConfig = {
  projectName: 'Test Project',
  prefix: 'TEST',
  statuses: [
    { value: 'open', label: 'Open' },
    { value: 'in-progress', label: 'In Progress' },
    { value: 'completed', label: 'Completed' },
    { value: 'deleted', label: 'Deleted' },
  ],
  stages: [
    { value: '', label: 'Undefined' },
    { value: 'idea', label: 'Idea' },
    { value: 'plan_complete', label: 'Plan Complete' },
    { value: 'in_review', label: 'In Review' },
  ],
  statusStageCompatibility: {
    open: ['', 'idea', 'plan_complete'],
    'in-progress': ['plan_complete'],
    completed: ['in_review'],
    deleted: [''],
  },
};

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
    issueType: 'task',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    ...overrides,
  };
}

describe('registerValidateCommand', () => {
  let tempDir: string;
  let db: WorklogDatabase;
  let dataPath: string;

  /**
   * Register the root action on a fresh `doctor` command carrying only the
   * flags the action reads (`--fix`); the full command definition stays in the
   * registrar and is exercised by the unchanged CLI suites.
   */
  function buildProgram(jsonMode: boolean): {
    program: Command;
    payloads: any[];
    errors: Array<{ message: string; jsonData?: unknown }>;
  } {
    const payloads: any[] = [];
    const errors: Array<{ message: string; jsonData?: unknown }> = [];
    const program = new Command();
    const doctor = program.command('doctor').option('--fix', 'Apply safe fixes');
    const ctx: ValidateCommandContext = {
      output: {
        json: (data) => payloads.push(data),
        error: (message, jsonData) => errors.push({ message, jsonData }),
      },
      dataPath,
      utils: {
        requireInitialized: () => {},
        getDatabase: () => db,
        getConfig: () => config,
        isJsonMode: () => jsonMode,
      },
    };
    registerValidateCommand(doctor, ctx);
    return { program, payloads, errors };
  }

  beforeEach(() => {
    tempDir = createTempDir();
    dataPath = createTempJsonlPath(tempDir);
    db = new WorklogDatabase('TEST', createTempDbPath(tempDir), dataPath, true, true);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  it('reports a mappable invalid priority as a safe, fixable finding in the JSON payload', async () => {
    db.import([makeItem('TEST-BADPRIORITY', { priority: 'P1' })], [], []);

    const { program, payloads, errors } = buildProgram(true);
    await program.parseAsync(['node', 'wl', 'doctor']);

    expect(errors).toEqual([]);
    expect(payloads).toHaveLength(1);
    const findings = payloads[0];
    expect(Array.isArray(findings)).toBe(true);
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: 'priority.invalid',
        type: 'invalid-priority',
        severity: 'warning',
        itemId: 'TEST-BADPRIORITY',
        message: 'Invalid priority "P1" (maps to "high" via P* mapping)',
        proposedFix: { priority: 'high' },
        safe: true,
      }),
    );
    // Reporting never mutates the store.
    expect(db.get('TEST-BADPRIORITY')!.priority).toBe('P1');
  });

  it('applies the safe fix under --fix and drops it from the reported findings', async () => {
    db.import([makeItem('TEST-BADPRIORITY', { priority: 'P1' })], [], []);

    const { program, payloads } = buildProgram(true);
    await program.parseAsync(['node', 'wl', 'doctor', '--fix']);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).not.toContainEqual(
      expect.objectContaining({ checkId: 'priority.invalid', itemId: 'TEST-BADPRIORITY' }),
    );
    expect(db.get('TEST-BADPRIORITY')!.priority).toBe('high');
  });

  it('keeps a non-mappable priority finding for manual review under --fix in JSON mode', async () => {
    db.import([makeItem('TEST-UNMAPPABLE', { priority: 'urgent' })], [], []);

    const { program, payloads } = buildProgram(true);
    await program.parseAsync(['node', 'wl', 'doctor', '--fix']);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toContainEqual(
      expect.objectContaining({
        checkId: 'priority.invalid',
        itemId: 'TEST-UNMAPPABLE',
        proposedFix: null,
        safe: false,
        context: expect.objectContaining({ current: 'urgent', mapped: null, requiresManualFix: true }),
      }),
    );
    // JSON mode never prompts, so nothing is written for a non-safe finding.
    expect(db.get('TEST-UNMAPPABLE')!.priority).toBe('urgent');
  });

  it('renders the human-readable findings report outside JSON mode', async () => {
    db.import([makeItem('TEST-BADPRIORITY', { priority: 'P1' })], [], []);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    try {
      const { program, payloads } = buildProgram(false);
      await program.parseAsync(['node', 'wl', 'doctor']);

      // Human mode never emits a JSON payload.
      expect(payloads).toEqual([]);
      const output = logs.join('\n');
      expect(output).toContain('Doctor: validation findings');
      expect(output).toContain('Rules source: docs/validation/status-stage-inventory.md');
      expect(output).toContain('TEST-BADPRIORITY');
      expect(output).toContain('  - Invalid priority "P1" (maps to "high" via P* mapping)');
      expect(output).toContain('    Suggested: {"priority":"high"}');
    } finally {
      logSpy.mockRestore();
    }
  });
});
