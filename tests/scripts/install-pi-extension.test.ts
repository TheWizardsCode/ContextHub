import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

describe('install-pi-extension script', () => {
  /**
   * Copy the real install-pi-extension.sh to a temporary directory so the
   * guard logic evaluates the *copied* script's own REPO_ROOT (which is NOT
   * inside a worktree), avoiding the worktree guard firing on the worktree
   * checkout where the test file lives.
   */
  function installScriptInTempDir(root: string): string {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const realScript = path.join(repoRoot, 'scripts', 'install-pi-extension.sh');
    const scriptsDir = path.join(root, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const dest = path.join(scriptsDir, 'install-pi-extension.sh');
    fs.copyFileSync(realScript, dest);
    return dest;
  }

  it('creates global ~/.pi/agent/extensions symlink to worklog extension directory', () => {
    // Reproduce a built, non-worktree checkout in a neutral directory so the
    // worktree guard does NOT fire (the real worktree checkout path itself
    // contains `.worklog/worktrees/`, which would trigger the guard).
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-pi-ext-success-'));
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-pi-ext-home-'));

    // Built checkout fixture: extension source + dist/wl-integration/spawn.js.
    const extDir = path.join(tempDir, 'packages', 'tui', 'extensions');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'index.ts'), 'export {};\n');
    const distWlDir = path.join(tempDir, 'dist', 'wl-integration');
    fs.mkdirSync(distWlDir, { recursive: true });
    fs.writeFileSync(path.join(distWlDir, 'spawn.js'), 'module.exports = {};\n');

    const scriptPath = installScriptInTempDir(tempDir);

    const run = () =>
      spawnSync('bash', [scriptPath], {
        cwd: tempDir,
        stdio: 'pipe',
        env: { ...process.env, HOME: tempHome },
      });

    const result = run();
    expect(result.status).toBe(0);

    const linkPath = path.join(tempHome, '.pi', 'agent', 'extensions', 'worklog');
    expect(fs.existsSync(linkPath)).toBe(true);

    const stat = fs.lstatSync(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);

    const target = fs.readlinkSync(linkPath);
    expect(path.resolve(path.dirname(linkPath), target)).toBe(extDir);

    // Re-run to verify idempotent replacement path (no leftover backup files).
    const result2 = run();
    expect(result2.status).toBe(0);
    const statAfter = fs.lstatSync(linkPath);
    expect(statAfter.isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath))).toBe(extDir);
  });

  // ---------------------------------------------------------------------------
  // Guards added by WL-0MUSTNEQW003V3KO
  // ---------------------------------------------------------------------------

  /**
   * Run a copied install-pi-extension.sh from an arbitrary directory, with
   * isolated HOME / PI_GLOBAL_EXTENSIONS_DIR so that no real extension is
   * touched.  The fixture under `fixtureRoot` must contain a `scripts/`
   * directory with the script inside.
   *
   * Returns `{ result, homeDir }` where `homeDir` is the temp directory used
   * for both HOME and PI_GLOBAL_EXTENSIONS_DIR.  The guard-level tests assert
   * on `homeDir` — the script places `${TARGET_LINK}` at
   * `${PI_GLOBAL_EXTENSIONS_DIR}/worklog` (= `${homeDir}/worklog`).
   */
  function runScriptInFixture(
    fixtureRoot: string,
    overrides: Record<string, string> = {},
  ): { result: ReturnType<typeof spawnSync>; homeDir: string } {
    const scriptPath = path.join(fixtureRoot, 'scripts', 'install-pi-extension.sh');
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-pi-ext-fixture-home-'));
    const result = spawnSync('bash', [scriptPath], {
      cwd: fixtureRoot,
      stdio: 'pipe',
      env: { ...process.env, HOME: homeDir, PI_GLOBAL_EXTENSIONS_DIR: homeDir, ...overrides },
    });
    return { result, homeDir };
  }

  /**
   * Build a minimal fixture tree that the script recognises as a valid
   * repository containing the Pi extension source.
   *
   * @param root   - the root directory to create under (created if absent).
   * @param build  - when true, also create the dist/ output the extension needs.
   */
  function buildFixture(root: string, build = false): void {
    const extDir = path.join(root, 'packages', 'tui', 'extensions');
    fs.mkdirSync(extDir, { recursive: true });
    // Minimal file to convince the script that the extension source exists.
    fs.writeFileSync(path.join(extDir, 'index.ts'), 'export {};\n');

    const scriptsDir = path.join(root, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });

    if (build) {
      const distDir = path.join(root, 'dist');
      const distWlDir = path.join(distDir, 'wl-integration');
      fs.mkdirSync(distWlDir, { recursive: true });
      // Sentinel file that the extension loads at runtime.
      fs.writeFileSync(path.join(distWlDir, 'spawn.js'), 'module.exports = {};\n');
    }
  }

  it('skips installation and logs a clear message when REPO_ROOT contains .worklog/worktrees/', () => {
    // WL-0MUSTNEQW003V3KO — AC 1, 4: worktree guard must leave TARGET_DIR untouched.
    const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-pi-ext-wt-'));
    // The worktree path segment must appear in REPO_ROOT so the guard triggers.
    const fixtureRoot = path.join(tempBase, '.worklog', 'worktrees', 'wl-FAKE-worktree');

    buildFixture(fixtureRoot, true); // needs dist/ so the worktree guard fires first

    // Copy the real script into the fixture.
    const repoRoot = path.resolve(__dirname, '..', '..');
    const realScript = path.join(repoRoot, 'scripts', 'install-pi-extension.sh');
    fs.writeFileSync(
      path.join(fixtureRoot, 'scripts', 'install-pi-extension.sh'),
      fs.readFileSync(realScript, 'utf8'),
    );

    const { result, homeDir } = runScriptInFixture(fixtureRoot);
    expect(result.status).toBe(0);

    // stdout or stderr should mention the worktree skip.
    const output = String(result.stdout) + String(result.stderr);
    expect(output).toMatch(/worktree/i);

    // No symlink should have been created at ${PI_GLOBAL_EXTENSIONS_DIR}/worklog.
    expect(fs.existsSync(path.join(homeDir, 'worklog'))).toBe(false);
  });

  it('skips installation and warns when dist/wl-integration/spawn.js is missing', () => {
    // WL-0MUSTNEQW003V3KO — AC 2, 5: unbuilt-target guard must leave TARGET_DIR untouched.
    const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-pi-ext-unbuilt-'));
    const fixtureRoot = path.join(tempBase, 'my-repo'); // normal path — no worktree segment

    buildFixture(fixtureRoot, false); // NO dist/ output

    const repoRoot = path.resolve(__dirname, '..', '..');
    const realScript = path.join(repoRoot, 'scripts', 'install-pi-extension.sh');
    fs.writeFileSync(
      path.join(fixtureRoot, 'scripts', 'install-pi-extension.sh'),
      fs.readFileSync(realScript, 'utf8'),
    );

    const { result, homeDir } = runScriptInFixture(fixtureRoot);
    expect(result.status).toBe(0);

    // Should contain a warning about missing dist output.
    const output = String(result.stdout) + String(result.stderr);
    expect(output).toMatch(/dist/i);

    // No symlink should have been created.
    expect(fs.existsSync(path.join(homeDir, 'worklog'))).toBe(false);
  });
});
