import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  seedWorkItems,
  writeConfig,
  writeInitSemaphore,
  // getPackageVersion is provided by cli-helpers to read package.json
  // and keep tests in sync with the application's canonical version.
  // eslint-disable-next-line import/no-unresolved
  getPackageVersion
} from './cli-helpers.js';
import { initRepo, initBareRepo } from './git-helpers.js';
import { cleanupTempDir, createTempDir } from '../test-utils.js';

describe('CLI Init Tests', () => {
  const CANONICAL_GLOBAL_REFERENCE = '## Global agent guidance';
  const CANONICAL_REFERENCE_LINE = 'Read the global agent instructions at `~/.pi/agent/AGENTS.md`';
  const CANONICAL_PROJECT_SECTION = '## Project-specific guidance';

  it('should install the canonical global-reference structure in a fresh project', async () => {
    const tempState = enterTempDir();
    try {
      await execAsync(
        `tsx ${cliPath} init --project-name "Test Project" --prefix TEST --auto-export yes --auto-sync no --workflow-inline no --agents-template skip --stats-plugin-overwrite no`
      );

      const updated = fs.readFileSync('AGENTS.md', 'utf-8');
      expect(updated).toContain(CANONICAL_GLOBAL_REFERENCE);
      expect(updated).toContain(CANONICAL_REFERENCE_LINE);
      expect(updated).toContain(CANONICAL_PROJECT_SECTION);
      // The template is a reference, not a copy of the global instruction set.
      expect(updated).not.toContain('CRITICAL RULES');
      expect(updated).not.toContain('Follow the global AGENTS.md in addition to the rules below');
    } finally {
      leaveTempDir(tempState);
    }
  }, 45000);

  it('should insert the AGENTS.md global-reference template when an existing file is present', async () => {
    const tempState = enterTempDir();
    try {
      const existing = '## Local Rules\n\n- Do the local thing\n';
      fs.writeFileSync('AGENTS.md', existing, 'utf-8');

      await execAsync(
        `tsx ${cliPath} init --project-name "Test Project" --prefix TEST --auto-export yes --auto-sync no --workflow-inline no --agents-template append --stats-plugin-overwrite no`
      );

      const updated = fs.readFileSync('AGENTS.md', 'utf-8');
      const lines = updated.split(/\r?\n/).filter(line => line.trim().length > 0);
      // The canonical global-reference section is emitted first ...
      expect(lines[0]).toBe(CANONICAL_GLOBAL_REFERENCE);
      expect(updated).toContain(CANONICAL_REFERENCE_LINE);
      // ... and existing local rules are preserved below the reference.
      expect(updated.indexOf(CANONICAL_GLOBAL_REFERENCE)).toBeLessThan(updated.indexOf(existing.trim()));
      expect(updated).toContain(existing.trim());
    } finally {
      leaveTempDir(tempState);
    }
  }, 45000);

  it('should not duplicate the AGENTS.md global-reference on re-run', async () => {
    const tempState = enterTempDir();
    try {
      const existing = `## Global agent guidance\n\n${CANONICAL_REFERENCE_LINE}\n\n## Project-specific guidance\n\n- Keep it\n`;
      fs.writeFileSync('AGENTS.md', existing, 'utf-8');

      await execAsync(
        `tsx ${cliPath} init --project-name "Test Project" --prefix TEST --auto-export yes --auto-sync no --workflow-inline no --agents-template append --stats-plugin-overwrite no`
      );

      const updated = fs.readFileSync('AGENTS.md', 'utf-8');
      const referenceMatches = updated.split(/\r?\n/).filter(line => line.trim() === CANONICAL_GLOBAL_REFERENCE).length;
      expect(referenceMatches).toBe(1);
      expect(updated).toContain('- Keep it');
    } finally {
      leaveTempDir(tempState);
    }
  }, 45000);
  it('should create semaphore when config exists but semaphore does not', async () => {
    const tempState = enterTempDir();
    try {
      fs.mkdirSync('.worklog', { recursive: true });
      fs.writeFileSync(
        '.worklog/config.yaml',
        [
          'projectName: Test Project',
          'prefix: TEST',
          'statuses:',
          '  - value: open',
          '    label: Open',
          '  - value: in-progress',
          '    label: In Progress',
          '  - value: blocked',
          '    label: Blocked',
          '  - value: completed',
          '    label: Completed',
          '  - value: deleted',
          '    label: Deleted',
          'stages:',
          '  - value: ""',
          '    label: Undefined',
          '  - value: idea',
          '    label: Idea',
          '  - value: prd_complete',
          '    label: PRD Complete',
          '  - value: plan_complete',
          '    label: Plan Complete',
          '  - value: in_progress',
          '    label: In Progress',
          '  - value: in_review',
          '    label: In Review',
          '  - value: done',
          '    label: Done',
          'statusStageCompatibility:',
          '  open: ["", idea, prd_complete, plan_complete, in_progress]',
          '  in-progress: [in_progress]',
          '  blocked: ["", idea, prd_complete, plan_complete, in_progress]',
          '  completed: [in_review, done]',
          '  deleted: [""]'
        ].join('\n'),
        'utf-8'
      );

      const { stdout } = await execAsync(`tsx ${cliPath} --json init`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.message).toContain('already exists');
      // version should match package.json
      expect(result.version).toBe(getPackageVersion());
      expect(result.initializedAt).toBeDefined();

      expect(fs.existsSync('.worklog/initialized')).toBe(true);
      const semaphore = JSON.parse(fs.readFileSync('.worklog/initialized', 'utf-8'));
      expect(semaphore.version).toBe(getPackageVersion());
      expect(semaphore.initializedAt).toBeDefined();
    } finally {
      leaveTempDir(tempState);
    }
  }, 45000);

  it('should allow init command without initialization', async () => {
    const tempState = enterTempDir();
    try {
      fs.rmSync('.worklog', { recursive: true, force: true });
      try {
        await execAsync(`tsx ${cliPath} --json init`, { timeout: 1000 });
      } catch (error: any) {
        const errorOutput = error.stdout || error.stderr || '';
        expect(errorOutput).not.toContain('not initialized');
      }
    } finally {
      leaveTempDir(tempState);
    }
  });

  it('should sync remote work items on init in new checkout', async () => {
    const sourceRepo = createTempDir();
    const remoteRepo = createTempDir();
    const cloneRepo = createTempDir();

    try {
      await initRepo(sourceRepo);

      await initBareRepo(remoteRepo);
      await execAsync(`git remote add origin ${remoteRepo}`, { cwd: sourceRepo });
      await execAsync('git push -u origin HEAD', { cwd: sourceRepo });

      writeConfig(sourceRepo, 'Sync Test', 'SYNC');
      writeInitSemaphore(sourceRepo);

      seedWorkItems(sourceRepo, [
        { title: 'Seed item' },
      ]);
      await execAsync(`tsx ${cliPath} sync`, { cwd: sourceRepo });

      await execAsync(`git clone ${remoteRepo} ${cloneRepo}`);
      await execAsync('git config user.email "test@example.com"', { cwd: cloneRepo });
      await execAsync('git config user.name "Test User"', { cwd: cloneRepo });

      writeConfig(cloneRepo, 'Sync Test', 'SYNC');

      await execAsync(
        `tsx ${cliPath} init --project-name "Sync Test" --prefix SYNC --auto-export yes --auto-sync no --workflow-inline no --agents-template skip --stats-plugin-overwrite no`,
        { cwd: cloneRepo }
      );

      const { stdout } = await execAsync(`tsx ${cliPath} --json list`, { cwd: cloneRepo });
      const listResult = JSON.parse(stdout);
      expect(listResult.success).toBe(true);
      expect(listResult.workItems).toHaveLength(1);
      expect(listResult.workItems[0].title).toBe('Seed item');
    } finally {
      cleanupTempDir(sourceRepo);
      cleanupTempDir(remoteRepo);
      cleanupTempDir(cloneRepo);
    }
  }, 60000);

  // Removed: outside-repo .worklog simulation (not part of the target scenario).

  it('should place .worklog in main repo when initializing', async () => {
    const tempDir = createTempDir();
    try {
      // Initialize a git repo
      // Initialize repo with a fast empty commit
      await initRepo(tempDir);

      // Initialize worklog in the main repo
      await execAsync(
        `tsx ${cliPath} init --project-name "Main Repo" --prefix MAIN --auto-export yes --auto-sync no --workflow-inline no --agents-template skip --stats-plugin-overwrite no`,
        { cwd: tempDir }
      );

      // Check that .worklog was created in the main repo
      expect(fs.existsSync(path.join(tempDir, '.worklog'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '.worklog', 'config.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '.worklog', 'initialized'))).toBe(true);
    } finally {
      cleanupTempDir(tempDir);
    }
  }, 45000);

  it('should find main repo .worklog when in subdirectory', async () => {
    const tempDir = createTempDir();
    try {
      // Initialize a git repo
      await initRepo(tempDir);

      // Initialize worklog in the main repo
      await execAsync(
        `tsx ${cliPath} init --project-name "Main Repo" --prefix MAIN --auto-export yes --auto-sync no --workflow-inline no --agents-template skip --stats-plugin-overwrite no`,
        { cwd: tempDir }
      );

      // Create a subdirectory in the repo
      const subDir = path.join(tempDir, 'src', 'components');
      fs.mkdirSync(subDir, { recursive: true });

      // Create a work item from the subdirectory - should use main repo's .worklog
      const createResult = await execAsync(
        `tsx ${cliPath} --json create --title "Item from subdirectory"`,
        { cwd: subDir }
      );
      const createData = JSON.parse(createResult.stdout);
      expect(createData.success).toBe(true);

      // List items from the subdirectory - should find the item created via subdirectory
      const listResult = await execAsync(
        `tsx ${cliPath} --json list`,
        { cwd: subDir }
      );
      const listData = JSON.parse(listResult.stdout);
      expect(listData.workItems).toHaveLength(1);
      expect(listData.workItems[0].title).toBe('Item from subdirectory');

      // Also verify from main repo
      const mainListResult = await execAsync(
        `tsx ${cliPath} --json list`,
        { cwd: tempDir }
      );
      const mainListData = JSON.parse(mainListResult.stdout);
      expect(mainListData.workItems).toHaveLength(1);
      expect(mainListData.workItems[0].title).toBe('Item from subdirectory');
    } finally {
      cleanupTempDir(tempDir);
    }
  }, 45000);

  it('should write .githooks/pre-push containing worktree guards on fresh init', async () => {
    const tempDir = createTempDir();
    try {
      await initRepo(tempDir);

      await execAsync(
        `tsx ${cliPath} init --project-name "Guard Test" --prefix GUARD --auto-export yes --auto-sync no --workflow-inline no --agents-template skip --stats-plugin-overwrite no`,
        { cwd: tempDir }
      );

      const hookPath = path.join(tempDir, '.githooks', 'pre-push');
      expect(fs.existsSync(hookPath)).toBe(true);
      const hook = fs.readFileSync(hookPath, 'utf-8');
      expect(hook).toContain('git-common-dir');
      expect(hook).toContain('tmp-worktree');

      // Generated hook matches the committed canonical hook (modulo trailing newline)
      const committed = fs.readFileSync(path.join(process.cwd(), '.githooks', 'pre-push'), 'utf-8');
      const stripTrailingNewline = (s: string) => (s.endsWith('\n') ? s.slice(0, -1) : s);
      expect(stripTrailingNewline(hook)).toBe(stripTrailingNewline(committed));
    } finally {
      cleanupTempDir(tempDir);
    }
  }, 45000);

  // ---------------------------------------------------------------------
  // Standalone workflow behavior (AC3 of WL-0MSIXMKOX0052514): without a
  // SorraAgents global install, wl init's N/B/M workflow choices must keep
  // their current behavior. These tests lock in the standalone path so the
  // future delegation change cannot silently alter it.
  // ---------------------------------------------------------------------
  it('should inline WORKFLOW content into AGENTS.md with --workflow-inline yes (basic)', async () => {
    const tempState = enterTempDir();
    try {
      const existing = '## Project Rules\n\n- Local rule\n';
      fs.writeFileSync('AGENTS.md', existing, 'utf-8');

      await execAsync(
        `tsx ${cliPath} init --project-name "Test Project" --prefix TEST --auto-export yes --auto-sync no --workflow-inline yes --agents-template skip --stats-plugin-overwrite no`
      );

      const updated = fs.readFileSync('AGENTS.md', 'utf-8');
      expect(updated).toContain('<!-- WORKFLOW: start -->');
      expect(updated).toContain('<!-- WORKFLOW: end -->');
      // Pre-existing content is preserved below the inlined workflow block.
      expect(updated).toContain(existing.trim());
      expect(updated.indexOf('<!-- WORKFLOW: start -->')).toBeLessThan(
        updated.indexOf(existing.trim())
      );
    } finally {
      leaveTempDir(tempState);
    }
  }, 45000);

  it('should not write WORKFLOW content with --workflow-inline no (none)', async () => {
    const tempState = enterTempDir();
    try {
      const existing = '## Project Rules\n\n- Local rule\n';
      fs.writeFileSync('AGENTS.md', existing, 'utf-8');

      await execAsync(
        `tsx ${cliPath} init --project-name "Test Project" --prefix TEST --auto-export yes --auto-sync no --workflow-inline no --agents-template skip --stats-plugin-overwrite no`
      );

      const updated = fs.readFileSync('AGENTS.md', 'utf-8');
      expect(updated).not.toContain('<!-- WORKFLOW: start -->');
      expect(updated).not.toContain('<!-- WORKFLOW: end -->');
      // Standalone 'none' leaves the project AGENTS.md untouched.
      expect(updated).toBe(existing);
    } finally {
      leaveTempDir(tempState);
    }
  }, 45000);

  it('should not duplicate the WORKFLOW marker when --workflow-inline yes is re-run', async () => {
    const tempState = enterTempDir();
    try {
      const existing = '## Project Rules\n\n- Local rule\n';
      fs.writeFileSync('AGENTS.md', existing, 'utf-8');

      const cmd = `tsx ${cliPath} init --project-name "Test Project" --prefix TEST --auto-export yes --auto-sync no --workflow-inline yes --agents-template skip --stats-plugin-overwrite no`;
      await execAsync(cmd);
      await execAsync(cmd);

      const updated = fs.readFileSync('AGENTS.md', 'utf-8');
      const markers = updated
        .split(/\r?\n/)
        .filter(line => line.trim() === '<!-- WORKFLOW: start -->').length;
      expect(markers).toBe(1);
    } finally {
      leaveTempDir(tempState);
    }
  }, 45000);

  // ---------------------------------------------------------------------
  // Scheduled-prompts provisioning (WL-0MSS1Q5ER007QDKX AC1): `wl init`
  // copies templates/scheduled-prompts.json into
  // .worklog/scheduled-prompts.json on first init (create-if-absent) and
  // never clobbers an existing file on re-run — user edits and
  // lastTriggeredAt state are preserved.
  // ---------------------------------------------------------------------
  it('should provision .worklog/scheduled-prompts.json with the base set on first init', async () => {
    const tempState = enterTempDir();
    try {
      await execAsync(
        `tsx ${cliPath} init --project-name "Test Project" --prefix TEST --auto-export yes --auto-sync no --workflow-inline no --agents-template skip --stats-plugin-overwrite no`
      );

      const configPath = path.join('.worklog', 'scheduled-prompts.json');
      expect(fs.existsSync(configPath)).toBe(true);
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(Array.isArray(config.entries)).toBe(true);
      // The base set starts with /skill:refactor (intervalDays 3)
      // and /skill:standup (intervalDays 1), both lastTriggeredAt null.
      expect(config.entries).toEqual([
        {
          id: '/skill:refactor',
          prompt: '/skill:refactor',
          intervalDays: 3,
          lastTriggeredAt: null,
        },
        {
          id: '/skill:standup',
          prompt: '/skill:standup',
          intervalDays: 1,
          lastTriggeredAt: null,
        },
      ]);
    } finally {
      leaveTempDir(tempState);
    }
  }, 45000);

  it('should never clobber an existing scheduled-prompts.json on re-init (create-if-absent)', async () => {
    const tempState = enterTempDir();
    try {
      const cmd = `tsx ${cliPath} init --project-name "Test Project" --prefix TEST --auto-export yes --auto-sync no --workflow-inline no --agents-template skip --stats-plugin-overwrite no`;
      await execAsync(cmd);

      // Simulate operator edits + runtime state: a new entry and a set
      // lastTriggeredAt on the base entry.
      const configPath = path.join('.worklog', 'scheduled-prompts.json');
      const edited = {
        entries: [
          {
            id: '/skill:refactor',
            prompt: '/skill:refactor',
            intervalDays: 3,
            lastTriggeredAt: '2026-08-17T12:00:00.000Z',
          },
          { id: 'custom', prompt: '/skill:code-review', intervalDays: 1, lastTriggeredAt: null },
        ],
      };
      fs.writeFileSync(configPath, JSON.stringify(edited, null, 2), 'utf-8');

      // Re-running init must NOT overwrite the edited file.
      await execAsync(cmd);

      const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(after).toEqual(edited);
    } finally {
      leaveTempDir(tempState);
    }
  }, 45000);
});
