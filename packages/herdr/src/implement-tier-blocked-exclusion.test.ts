/**
 * End-to-end fixture test for the implement tier's dependency-blocked
 * exclusion (WL-0MSMYP1CB003XVTZ, closes the parent AC8 coverage gap):
 * creates a REAL blocked fixture in a temp worklog and proves the exact
 * implement-tier invocation — `wl next --stage plan_complete --risk low
 * --effort small -n 10 --json` (packages/herdr/src/index.ts
 * getNextImplementCandidate) — never yields the dependency-blocked item.
 * Feeding the real CLI output through the implement tier's own parser
 * (`parseImplementCandidatesOutput`) and selector
 * (`selectImplementCandidate`) proves a blocked candidate can never be
 * dispatched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execAsync, writeConfig, writeInitSemaphore, cliPath } from '../../../tests/cli/cli-helpers.js';
import { createTempDir, cleanupTempDir } from '../../../tests/test-utils.js';
import { parseImplementCandidatesOutput, selectImplementCandidate } from './downtime-worker.js';

describe('implement tier dependency-blocked exclusion (fixture, WL-0MSMYP1CB003XVTZ)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    writeConfig(tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempDir);
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  async function createItemGetId(args: string[]): Promise<string> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json create ${args.join(' ')}`, { cwd: tempDir });
    const parsed = JSON.parse(stdout);
    return parsed.workItem.id;
  }

  it(
    'the implement-tier invocation never yields a dependency-blocked candidate, so dispatch can never select one',
    async () => {
      // Fixture: a high-priority eligible blocker and an eligible item that
      // depends on it. While the blocker is open, the dependent is
      // dependency-blocked and must be excluded by wl next's default
      // (includeBlocked=false) — the same exclusion the implement tier
      // relies on (never passing --include-blocked).
      const blockerId = await createItemGetId(['-t', '"Blocker"', '-p', 'high', '--stage', 'plan_complete', '--risk', 'Low', '--effort', 'Small', '--no-re-sort']);
      const blockedId = await createItemGetId(['-t', '"Blocked"', '--stage', 'plan_complete', '--risk', 'Low', '--effort', 'Small', '--no-re-sort']);
      await execAsync(`tsx ${cliPath} --json dep add ${blockedId} ${blockerId}`, { cwd: tempDir });

      // The exact implement-tier invocation (packages/herdr/src/index.ts).
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json next --stage plan_complete --risk low --effort small -n 10`,
        { cwd: tempDir },
      );

      // Feed the real CLI output through the implement tier's own parser
      // and selector — the blocked candidate must never reach dispatch.
      const candidates = parseImplementCandidatesOutput(stdout);
      expect(candidates).not.toBeNull();
      const ids = (candidates ?? []).map((c) => c.id);
      expect(ids).toContain(blockerId);
      expect(ids).not.toContain(blockedId);

      const selected = selectImplementCandidate(candidates ?? [], new Set());
      expect(selected).not.toBeNull();
      expect(selected?.id).toBe(blockerId);
      expect(selected?.id).not.toBe(blockedId);
    },
    60_000,
  );
});
