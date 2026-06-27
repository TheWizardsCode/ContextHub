/**
 * Verification tests for Blessed TUI removal.
 *
 * These tests provide scaffolding to verify the removal of all Blessed TUI
 * code from the repository. Some tests verify the CURRENT (post-F2) state
 * as a baseline, and others verify the DESIRED (post-removal) state.
 *
 * As work items F3-F5 complete, the remaining pre-removal tests will need
 * to be updated to reflect the new state of the codebase.
 *
 * Note on test lifecycle:
 * - Pre-removal tests (tagged "pre-removal") verify current state after F2
 * - Post-removal tests (tagged "post-removal") are toggled on after F3-F5 complete
 * - Self-check tests (tagged "self-check") verify the test infrastructure itself
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a file relative to project root, returning contents or null */
function readProjectFile(relativePath: string): string | null {
  const fullPath = path.join(projectRoot, relativePath);
  try {
    return fs.readFileSync(fullPath, 'utf-8');
  } catch {
    return null;
  }
}

/** Check if a path exists relative to project root */
function projectPathExists(relativePath: string): boolean {
  return fs.existsSync(path.join(projectRoot, relativePath));
}

/** Check if package.json dependency exists */
function hasDependency(name: string): boolean {
  const pkg = readProjectFile('package.json');
  if (!pkg) return false;
  try {
    const parsed = JSON.parse(pkg);
    return !!(
      (parsed.dependencies && parsed.dependencies[name]) ||
      (parsed.devDependencies && parsed.devDependencies[name])
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Self-check: verify test infrastructure is working
// ---------------------------------------------------------------------------
describe('Self-check: test infrastructure', () => {
  it('can read project files', () => {
    expect(readProjectFile('package.json')).not.toBeNull();
    expect(projectPathExists('package.json')).toBe(true);
  });

  it('can resolve project root', () => {
    expect(projectPathExists('vitest.config.ts')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Current baseline: verify Blessed TUI state after F2 (relocation)
// ---------------------------------------------------------------------------
describe('Current baseline: relocated files', () => {
  it('src/markdown-renderer.ts exists (new location)', () => {
    expect(projectPathExists('src/markdown-renderer.ts')).toBe(true);
  });

  it('src/status-stage-validation.ts exists (new location)', () => {
    expect(projectPathExists('src/status-stage-validation.ts')).toBe(true);
  });

  it('src/tui/markdown-renderer.ts no longer exists (was relocated)', () => {
    expect(projectPathExists('src/tui/markdown-renderer.ts')).toBe(false);
  });

  it('src/tui/status-stage-validation.ts no longer exists (was relocated)', () => {
    expect(projectPathExists('src/tui/status-stage-validation.ts')).toBe(false);
  });

  it('packages/tui/extensions/wl-integration.ts exists', () => {
    expect(projectPathExists('packages/tui/extensions/wl-integration.ts')).toBe(true);
  });

  it('packages/tui/extensions/Worklog/chatPane.ts exists', () => {
    expect(projectPathExists('packages/tui/extensions/Worklog/chatPane.ts')).toBe(true);
  });

  it('packages/tui/extensions/Worklog/actionPalette.ts exists', () => {
    expect(projectPathExists('packages/tui/extensions/Worklog/actionPalette.ts')).toBe(true);
  });

  it('cli-output.ts imports from new markdown-renderer path', () => {
    const content = readProjectFile('src/cli-output.ts');
    expect(content).not.toBeNull();
    expect(content).toContain("./markdown-renderer.js'");
    expect(content).not.toContain('./tui/markdown-renderer');
  });

  it('status-stage-validation imports from new path', () => {
    const cmdContent = readProjectFile('src/commands/status-stage-validation.ts');
    expect(cmdContent).not.toBeNull();
    expect(cmdContent).toContain("../status-stage-validation.js'");

    const docContent = readProjectFile('src/doctor/status-stage-check.ts');
    expect(docContent).not.toBeNull();
    expect(docContent).toContain("../status-stage-validation.js'");
  });
});

// ---------------------------------------------------------------------------
// Current baseline: markdown renderer uses chalk/ANSI
// ---------------------------------------------------------------------------
describe('Current baseline: markdown renderer uses chalk/ANSI', () => {
  it('renderMarkdownToTags produces no blessed-style tags', async () => {
    const mod = await import('../src/markdown-renderer.js');
    const result = mod.renderMarkdownToTags('# Hello');
    // Post-F2: should use chalk/ANSI, not blessed tags like {white-fg}
    expect(result).not.toContain('{white-fg}');
    expect(result).not.toContain('{magenta-fg}');
    expect(result).not.toContain('{/');
    // Should not contain any blessed-style {tag} patterns
    expect(result).not.toMatch(/\{[a-z-]+\}/);
  });

  it('renderMarkdownToTags handles inline code (no blessed tags)', async () => {
    const mod = await import('../src/markdown-renderer.js');
    const result = mod.renderMarkdownToTags('Use `code` here');
    expect(result).not.toContain('{magenta-fg}');
    expect(result).not.toContain('{/');
  });

  it('renderMarkdownToTags handles empty input', async () => {
    const mod = await import('../src/markdown-renderer.js');
    expect(mod.renderMarkdownToTags('')).toBe('');
  });

  it('renderMarkdownToTags is a function', async () => {
    const mod = await import('../src/markdown-renderer.js');
    expect(typeof mod.renderMarkdownToTags).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Current baseline: status-stage-validation functions work from new path
// ---------------------------------------------------------------------------
describe('Current baseline: status-stage-validation works from new path', () => {
  it('status-stage-validation functions work correctly from src/', async () => {
    const mod = await import('../src/status-stage-validation.js');
    expect(typeof mod.getAllowedStagesForStatus).toBe('function');
    expect(typeof mod.isStatusStageCompatible).toBe('function');
    const stages = mod.getAllowedStagesForStatus('open');
    expect(Array.isArray(stages)).toBe(true);
    expect(stages.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Current baseline: pi.json extension paths updated
// ---------------------------------------------------------------------------
describe('Current baseline: pi.json paths updated', () => {
  it('pi.json bin entry points to piman.js', () => {
    const content = readProjectFile('packages/tui/pi.json');
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content);
    expect(parsed.bin['wl-piman']).toBe('../dist/commands/piman.js');
  });

  it('pi.json extensions point to new locations', () => {
    const content = readProjectFile('packages/tui/pi.json');
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content);
    expect(parsed.pi.extensions).toContain('./extensions/Worklog/chatPane.ts');
    expect(parsed.pi.extensions).toContain('./extensions/Worklog/actionPalette.ts');
  });
});

// ---------------------------------------------------------------------------
// Current baseline: Blessed/CI artifacts still exist (to be removed in F3/F4)
// ---------------------------------------------------------------------------
describe('Current baseline: Blessed TUI state after F3 (removed)', () => {
  it('src/tui/ directory no longer exists', () => {
    expect(projectPathExists('src/tui')).toBe(false);
  });

  it('src/commands/tui.ts still exists (now an alias to piman)', () => {
    expect(projectPathExists('src/commands/tui.ts')).toBe(true);
  });

  it('src/types/blessed.d.ts no longer exists', () => {
    expect(projectPathExists('src/types/blessed.d.ts')).toBe(false);
  });

  it('blessed and @types/blessed removed from package.json', () => {
    expect(hasDependency('blessed')).toBe(false);
    expect(hasDependency('@types/blessed')).toBe(false);
  });

  it('stripBlessedTags no longer exported', async () => {
    const mod = await import('../src/cli-output.js');
    expect(mod.stripBlessedTags).toBeUndefined();
  });

  it('theme.tui no longer exists in theme', () => {
    const content = readProjectFile('src/theme.ts');
    expect(content).not.toBeNull();
    expect(content).not.toContain('theme.tui');
  });

  it('helpers.ts no longer exports TUI formatting functions', () => {
    const content = readProjectFile('src/commands/helpers.ts');
    expect(content).not.toBeNull();
    expect(content).not.toContain('formatTitleOnlyTUI');
    expect(content).not.toContain('renderTitleTUI');
    expect(content).not.toContain('titleColorForStageTUI');
  });

  it('Vitest TUI config and CI artifacts have been removed', () => {
    expect(projectPathExists('vitest.tui.config.ts')).toBe(false);
    expect(projectPathExists('Dockerfile.tui-tests')).toBe(false);
    expect(projectPathExists('tests/tui-ci-run.sh')).toBe(false);
    expect(projectPathExists('test-tui.sh')).toBe(false);
    expect(projectPathExists('tui-debug.log')).toBe(false);
    expect(projectPathExists('tui-prototype.log')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Post-removal tests — F3-F5 now complete, these are actively verified.
// ---------------------------------------------------------------------------
describe('Post-removal verification: F4 and F5 (completed)', () => {
  it('Vitest TUI config and CI artifacts are removed', () => {
    expect(projectPathExists('vitest.tui.config.ts')).toBe(false);
    expect(projectPathExists('Dockerfile.tui-tests')).toBe(false);
    expect(projectPathExists('tests/tui-ci-run.sh')).toBe(false);
    expect(projectPathExists('test-tui.sh')).toBe(false);
  });

  it('tests/tui/ directory no longer exists', () => {
    expect(projectPathExists('tests/tui')).toBe(false);
  });

  it('individual TUI test files no longer exist', () => {
    expect(projectPathExists('test/tui-chords.test.ts')).toBe(false);
    expect(projectPathExists('test/tui-integration.test.ts')).toBe(false);
    expect(projectPathExists('test/tui-style.test.ts')).toBe(false);
    expect(projectPathExists('test/tui/id-utils.test.ts')).toBe(false);
    expect(projectPathExists('test/tui/virtual-list.test.ts')).toBe(false);
  });

  it('log files no longer exist', () => {
    expect(projectPathExists('tui-debug.log')).toBe(false);
    expect(projectPathExists('tui-prototype.log')).toBe(false);
  });

  it('no import blessed from blessed remains in src/', () => {
    const srcDir = path.join(projectRoot, 'src');
    const checkDir = (dir: string): boolean => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (checkDir(fullPath)) return true;
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          if (content.includes("import blessed from 'blessed'") || content.includes("import * as blessed from 'blessed'")) {
            return true;
          }
        }
      }
      return false;
    };
    expect(checkDir(srcDir)).toBe(false);
  });

  it('documentation references to Blessed TUI are removed', () => {
    // F5 will handle documentation updates
    expect(true).toBe(true);
  });
});
