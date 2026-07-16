/**
 * Test: Every --json command returns valid JSON with no preamble
 *
 * Comprehensive validation that every `wl` CLI command that supports
 * the --json flag produces pure, parseable JSON output with no leading
 * or trailing non-JSON content.
 *
 * This is an additive test — it does NOT modify or replace the existing
 * json-output-shape.test.ts file, which validates structural shape
 * consistency. This file validates output purity (valid JSON, no
 * preamble, no trailing text).
 *
 * See WL-0MRJ2R8LJ003LA8V.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
  seedWorkItems,
} from './cli-helpers.js';

const _exec = promisify(execCallback);

/**
 * Derive the mock-bin directory from the known project structure.
 * cliPath is <projectRoot>/src/cli.ts, so projectRoot = dirname(dirname(cliPath)).
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');
const mockBinDir = path.join(projectRoot, 'tests', 'cli', 'mock-bin');

/**
 * Validate that the given stdout string:
 * 1. Is not empty
 * 2. Starts with { or [ (no leading non-JSON preamble)
 * 3. Ends with } or ] (no trailing non-JSON content)
 * 4. Parses as valid JSON
 *
 * Returns the parsed JSON for optional shape assertions.
 */
function expectValidJson(stdout: string): any {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);

  const firstChar = trimmed[0];
  const lastChar = trimmed[trimmed.length - 1];

  // Must start with { or [ — no leading text
  expect(['{', '[']).toContain(firstChar);
  // Must end with } or ] — no trailing text
  expect(['}', ']']).toContain(lastChar);

  // Must be parseable
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e: any) {
    // Include the output in the assertion message for debugging
    expect.fail(`JSON.parse failed: ${e.message}\nOutput was:\n${trimmed.substring(0, 500)}`);
  }
  return parsed;
}

/**
 * Helper: Get an item id from creating a seeded item then retrieving
 * the first item from the list command.
 */
let nextItemId = 1;

function uniqueTitle(): string {
  return `Valid JSON test item ${nextItemId++}`;
}

describe('valid-json-output', () => {
  let state: { tempDir: string; originalCwd: string };
  // Store item ids for commands that need them
  let itemId: string;
  let secondItemId: string;

  beforeEach(async () => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Valid JSON Test', 'VJT');
    writeInitSemaphore(state.tempDir);

    // Seed 3 work items for list/search/next/dep tests
    seedWorkItems(state.tempDir, [
      { title: 'Alpha item', status: 'open', priority: 'medium', stage: 'idea' },
      { title: 'Beta item', status: 'open', priority: 'high', stage: 'in_progress' },
      { title: 'Gamma item', status: 'open', priority: 'low', stage: 'plan_complete' },
    ]);

    // Create a specific item we can reference by id
    const { stdout: createStdout } = await execAsync(
      `tsx ${cliPath} --json create -t "${uniqueTitle()}"`,
    );
    const created = expectValidJson(createStdout);
    itemId = created.workItem.id;
    expect(itemId).toBeDefined();

    // Create a second item for dependency tests
    const { stdout: createStdout2 } = await execAsync(
      `tsx ${cliPath} --json create -t "${uniqueTitle()}"`,
    );
    const created2 = expectValidJson(createStdout2);
    secondItemId = created2.workItem.id;
    expect(secondItemId).toBeDefined();
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  // ──────────────────────────────────────────────
  // Group 1: Basic CRUD + status commands
  // ──────────────────────────────────────────────

  describe('basic CRUD and status commands', () => {
    it('status --json outputs valid JSON with no preamble', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json status`);
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(result.initialized).toBe(true);
    });

    it('list --json outputs valid JSON with no preamble', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json list`);
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(Array.isArray(result.workItems)).toBe(true);
      expect(result.count).toBeGreaterThanOrEqual(4); // 3 seeded + 2 created
    });

    it('show --json outputs valid JSON with no preamble', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json show ${itemId}`);
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem).toBeDefined();
      expect(result.workItem.id).toBe(itemId);
    });

    it('create --json outputs valid JSON with no preamble', async () => {
      const title = uniqueTitle();
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json create -t "${title}" -d "Created during valid-json test"`,
      );
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem).toBeDefined();
      expect(result.workItem.title).toBe(title);
    });

    it('update --json outputs valid JSON with no preamble', async () => {
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${itemId} --priority high --stage in_progress`,
      );
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem).toBeDefined();
      expect(result.workItem.priority).toBe('high');
    });

    it('delete --json outputs valid JSON with no preamble', async () => {
      // Create a dedicated item for deletion
      const { stdout: createStdout } = await execAsync(
        `tsx ${cliPath} --json create -t "${uniqueTitle()}"`,
      );
      const created = expectValidJson(createStdout);
      const deleteId = created.workItem.id;

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json delete ${deleteId} --no-sync`,
      );
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(result.deletedId).toBe(deleteId);
    });

    it('close --json outputs valid JSON with no preamble', async () => {
      // Create a dedicated item for closing
      const { stdout: createStdout } = await execAsync(
        `tsx ${cliPath} --json create -t "${uniqueTitle()}"`,
      );
      const created = expectValidJson(createStdout);
      const closeId = created.workItem.id;

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json close ${closeId} -r "Closing for valid-json test"`,
      );
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(result.results).toBeDefined();
      expect(Array.isArray(result.results)).toBe(true);
      expect(result.results[0].id).toBe(closeId);
    });

    it('search --json outputs valid JSON with no preamble', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json search "item"`);
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      // May have either workItems or results key depending on version
      expect(result.workItems ?? result.results).toBeDefined();
    });

    it('next --json outputs valid JSON with no preamble', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json next`);
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem).toBeDefined();
      expect(result.reason).toBeDefined();
    });

    it('next --json -n 2 outputs valid JSON with no preamble (multiple)', async () => {
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json next -n 2 --include-in-progress`,
      );
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      // Multiple items: may be workItems or results
      const items = result.workItems ?? result.results;
      expect(Array.isArray(items)).toBe(true);
      expect(result.count).toBeGreaterThanOrEqual(0);
    });

    it('in-progress --json outputs valid JSON with no preamble', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json in-progress`);
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(Array.isArray(result.workItems)).toBe(true);
    });

    it('recent --json outputs valid JSON with no preamble', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json recent -n 5`);
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(Array.isArray(result.workItems)).toBe(true);
      expect(result.count).toBeGreaterThanOrEqual(0);
    });
  });

  // ──────────────────────────────────────────────
  // Group 2: Sub-commands (comment, dep)
  // ──────────────────────────────────────────────

  describe('sub-command families', () => {
    it('comment add --json outputs valid JSON with no preamble', async () => {
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json comment add ${itemId} -a tester -c "Valid JSON test comment"`,
      );
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(result.comment).toBeDefined();
      expect(result.comment.workItemId).toBe(itemId);
    });

    it('comment list --json outputs valid JSON with no preamble', async () => {
      // Add a comment first
      await execAsync(
        `tsx ${cliPath} comment add ${itemId} -a tester -c "A test comment"`,
      );

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json comment list ${itemId}`,
      );
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(Array.isArray(result.comments)).toBe(true);
      expect(result.count).toBeGreaterThanOrEqual(0);
    });

    it('dep add --json outputs valid JSON with no preamble', async () => {
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json dep add ${secondItemId} ${itemId}`,
      );
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      // dep add may return `edge` or `removed` keys
      expect(result.edge ?? result.success).toBeTruthy();
    });

    it('dep list --json outputs valid JSON with no preamble', async () => {
      // Add a dependency first
      await execAsync(`tsx ${cliPath} dep add ${secondItemId} ${itemId}`);

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json dep list ${itemId}`,
      );
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(result.inbound).toBeDefined();
      expect(result.outbound).toBeDefined();
    });

    it('dep rm --json outputs valid JSON with no preamble', async () => {
      // Add a dependency first
      await execAsync(`tsx ${cliPath} dep add ${secondItemId} ${itemId}`);

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json dep rm ${secondItemId} ${itemId}`,
      );
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // Group 3: Management commands
  // ──────────────────────────────────────────────

  describe('management commands', () => {
    it('reviewed --json outputs valid JSON with no preamble', async () => {
      // reviewed toggles needsProducerReview, then back
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json reviewed ${itemId}`,
      );
      let result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem).toBeDefined();
      expect(result.workItem.id).toBe(itemId);

      // Toggle back to original state
      const { stdout: stdout2 } = await execAsync(
        `tsx ${cliPath} --json reviewed ${itemId}`,
      );
      result = expectValidJson(stdout2);
      expect(result.success).toBe(true);
    });

    it('re-sort --json outputs valid JSON with no preamble', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json re-sort`);
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
    });

    it('unlock --json outputs valid JSON with no preamble', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json unlock`);
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
    });

    it('export --json outputs valid JSON with no preamble', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json export`);
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(result.itemsCount).toBeGreaterThanOrEqual(0);
      expect(result.commentsCount).toBeGreaterThanOrEqual(0);
    });

    it('import --json outputs valid JSON with no preamble', async () => {
      // First export to create the JSONL file
      await execAsync(`tsx ${cliPath} --json export`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json import`);
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(result.itemsCount).toBeGreaterThanOrEqual(0);
      expect(result.commentsCount).toBeGreaterThanOrEqual(0);
    });
  });

  // ──────────────────────────────────────────────
  // Group 4: Content/display commands
  // ──────────────────────────────────────────────

  describe('content and display commands', () => {
    it('audit-show --json outputs valid JSON with no preamble', async () => {
      // audit-show reads an existing audit result from the database.
      // It does NOT run a new audit. When no audit exists, it should
      // return valid JSON. Note: in the in-process harness, --json
      // parsing may vary; the critical assertion is that the output
      // is parseable JSON with no preamble text.
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json audit-show ${itemId}`,
      );
      const result = expectValidJson(stdout);
      // The output should have success or be parseable JSON
      expect(result).toBeDefined();
    });

    it('audit-set --json outputs valid JSON with no preamble', async () => {
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json audit-set ${itemId} --ready-to-close yes --summary "Audit test" --raw-output "Test output"`,
      );
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(result.audit).toBeDefined();
    });

    it('completion --json outputs valid JSON with no preamble (no args)', async () => {
      // completion without args lists available shells
      const { stdout } = await execAsync(`tsx ${cliPath} --json completion`);
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(result.availableShells).toBeDefined();
      expect(result.availableShells).toContain('bash');
    });

    it('plugins --json outputs valid JSON with no preamble', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json plugins`);
      const result = expectValidJson(stdout);
      expect(result.plugins !== undefined || result.success !== undefined).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // Group 5: Error paths
  // ──────────────────────────────────────────────

  describe('error paths', () => {
    it('show NONEXISTENT --json outputs valid JSON (via stderr) with no preamble', async () => {
      // Use a real subprocess because the in-process test harness restores
      // console.error before the beforeExit handler fires, masking runtime
      // messages that real consumers would see on stderr.  Subprocess capture
      // includes everything up to process exit, including beforeExit handlers.
      const env = { ...process.env, PATH: `${mockBinDir}:${process.env.PATH || ''}` };
      let childStdout = '';
      let childStderr = '';
      try {
        const res = await _exec(`tsx ${cliPath} --json show NONEXISTENT-ID`, {
          cwd: state.tempDir,
          env,
          timeout: 15000,
        } as any);
        childStdout = (res as any).stdout ?? '';
        childStderr = (res as any).stderr ?? '';
      } catch (e: any) {
        childStdout = e.stdout ?? '';
        childStderr = e.stderr ?? '';
      }

      // Error output should appear on stderr (via output.error)
      const output = childStderr || childStdout;
      const trimmed = output.trim();
      expect(trimmed.length).toBeGreaterThan(0);

      // Error output with --json should be pure JSON on stderr
      expect(['{', '[']).toContain(trimmed[0]);
      expect(['}', ']']).toContain(trimmed[trimmed.length - 1]);
      const result = JSON.parse(trimmed);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      // Crucially, stderr must not contain any [runtime] messages from the
      // beforeExit handler — those are debug-level noise that break
      // interoperability for scripts consuming --json output.
      expect(childStderr).not.toContain('[runtime]');
    });

    it('update NONEXISTENT --json outputs valid JSON with no preamble', async () => {
      // Use subprocess to catch beforeExit messages (same rationale as show)
      const env = { ...process.env, PATH: `${mockBinDir}:${process.env.PATH || ''}` };
      let childStdout = '';
      let childStderr = '';
      try {
        const res = await _exec(`tsx ${cliPath} --json update NONEXISTENT-ID --priority high`, {
          cwd: state.tempDir,
          env,
          timeout: 15000,
        } as any);
        childStdout = (res as any).stdout ?? '';
        childStderr = (res as any).stderr ?? '';
      } catch (e: any) {
        childStdout = e.stdout ?? '';
        childStderr = e.stderr ?? '';
      }

      const output = childStderr || childStdout;
      const trimmed = output.trim();
      expect(trimmed.length).toBeGreaterThan(0);

      // Error output should be valid JSON with no preamble
      expect(['{', '[']).toContain(trimmed[0]);
      expect(['}', ']']).toContain(trimmed[trimmed.length - 1]);
      const parsed = JSON.parse(trimmed);
      expect(parsed.success).toBe(false);
      // Error may be at top level (output.error) or in results[0].error (output.json)
      const hasError = parsed.error !== undefined ||
        (Array.isArray(parsed.results) && parsed.results[0]?.error !== undefined);
      expect(hasError).toBe(true);

      // Verify no [runtime] messages on stderr
      expect(childStderr).not.toContain('[runtime]');
    });

    it('delete NONEXISTENT --json outputs valid JSON with no preamble', async () => {
      // Use subprocess to catch beforeExit messages (same rationale as show)
      const env = { ...process.env, PATH: `${mockBinDir}:${process.env.PATH || ''}` };
      let childStdout = '';
      let childStderr = '';
      try {
        const res = await _exec(`tsx ${cliPath} --json delete NONEXISTENT-ID --no-sync`, {
          cwd: state.tempDir,
          env,
          timeout: 15000,
        } as any);
        childStdout = (res as any).stdout ?? '';
        childStderr = (res as any).stderr ?? '';
      } catch (e: any) {
        childStdout = e.stdout ?? '';
        childStderr = e.stderr ?? '';
      }

      const output = childStderr || childStdout;
      const trimmed = output.trim();
      expect(trimmed.length).toBeGreaterThan(0);

      // Error output should be valid JSON with no preamble
      expect(['{', '[']).toContain(trimmed[0]);
      expect(['}', ']']).toContain(trimmed[trimmed.length - 1]);
      const parsed = JSON.parse(trimmed);
      expect(parsed.success).toBe(false);
      // Error may be at top level (output.error) or in results[0].error (output.json)
      const hasError = parsed.error !== undefined ||
        (Array.isArray(parsed.results) && parsed.results[0]?.error !== undefined);
      expect(hasError).toBe(true);

      // Verify no [runtime] messages on stderr
      expect(childStderr).not.toContain('[runtime]');
    });

    it('close NONEXISTENT --json outputs valid JSON with no preamble', async () => {
      // Use subprocess to catch beforeExit messages (same rationale as show)
      const env = { ...process.env, PATH: `${mockBinDir}:${process.env.PATH || ''}` };
      let childStdout = '';
      let childStderr = '';
      try {
        const res = await _exec(`tsx ${cliPath} --json close NONEXISTENT-ID -r "test"`, {
          cwd: state.tempDir,
          env,
          timeout: 15000,
        } as any);
        childStdout = (res as any).stdout ?? '';
        childStderr = (res as any).stderr ?? '';
      } catch (e: any) {
        childStdout = e.stdout ?? '';
        childStderr = e.stderr ?? '';
      }

      const output = childStderr || childStdout;
      const trimmed = output.trim();
      expect(trimmed.length).toBeGreaterThan(0);

      // Error output should be valid JSON with no preamble
      expect(['{', '[']).toContain(trimmed[0]);
      expect(['}', ']']).toContain(trimmed[trimmed.length - 1]);
      const parsed = JSON.parse(trimmed);
      expect(parsed.success).toBe(false);
      // Error may be at top level (output.error) or in results[0].error (output.json)
      const hasError = parsed.error !== undefined ||
        (Array.isArray(parsed.results) && parsed.results[0]?.error !== undefined);
      expect(hasError).toBe(true);

      // Verify no [runtime] messages on stderr
      expect(childStderr).not.toContain('[runtime]');
    });
  });

  // ──────────────────────────────────────────────
  // Group 6: Doctor commands (simple checks)
  // ──────────────────────────────────────────────

  describe('doctor commands', () => {
    it('doctor check --json outputs valid JSON with no preamble', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json doctor check`);
      const result = expectValidJson(stdout);
      // doctor check returns various shapes depending on findings
      expect(result).toBeDefined();
    });

    it('doctor migrate --json outputs valid JSON with no preamble', async () => {
      // doctor migrate handles JSONL → SQLite migration.
      // In a fresh SQLite-only setup with no JSONL file, it reports success
      // (nothing to migrate) with valid JSON output.
      const { stdout } = await execAsync(`tsx ${cliPath} --json doctor migrate`);
      const result = expectValidJson(stdout);
      expect(result).toBeDefined();
    });

    it('doctor stage-sync --json outputs valid JSON with no preamble', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json doctor stage-sync`);
      const result = expectValidJson(stdout);
      expect(result).toBeDefined();
    });
  });

  // ──────────────────────────────────────────────
  // Group 7: Migrate command
  // ──────────────────────────────────────────────

  describe('migrate command', () => {
    it('migrate sort-index --dry-run --json outputs valid JSON with no preamble', async () => {
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json migrate sort-index --dry-run`,
      );
      const result = expectValidJson(stdout);
      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.count).toBeGreaterThanOrEqual(0);
    });
  });

  // ──────────────────────────────────────────────
  // Group 8: Hard-to-test commands (documented skips)

  // ──────────────────────────────────────────────
  // Group 8: Hard-to-test commands (documented skips)
  // ──────────────────────────────────────────────

  describe('commands requiring special setup (skipped with reasons)', () => {
    it.skip('init --json — skipped: requires clean directory without .worklog', () => {
      // `wl init` is tested separately in tests/cli/init.test.ts.
      // It requires a directory with no existing .worklog to run fully.
      // The existing init tests cover JSON output in their own test file.
    });

    it.skip('sync --json — skipped: requires git remote with .worklog refs', () => {
      // `wl sync` requires a configured git remote with worklog data refs.
      // It is tested separately in tests/cli/sync.test.ts.
      // Testing sync with --json in this harness would need a full mock git
      // environment with worklog refs.
    });

    it.skip('github push/pull --json — skipped: requires full github mock', () => {
      // `wl github` commands require the gh CLI mock and a configured remote.
      // They are tested separately in the github-* test files
      // (tests/cli/github-*.test.ts).
    });

    it.skip('audit --json — skipped: requires Pi agent infrastructure', () => {
      // `wl audit` runs an audit via the Pi agent (runPiAudit).
      // This requires a running Pi agent which is not available in the
      // standard test environment. The JSON output from the audit command
      // is tested in the existing audit-specific test files.
    });
  });
});
