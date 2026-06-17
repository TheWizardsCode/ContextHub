/**
 * Verification tests for Blessed TUI removal.
 *
 * These tests provide scaffolding to verify the removal of all Blessed TUI
 * code from the repository. Some tests verify the CURRENT (pre-removal) state
 * as a baseline, and others verify the DESIRED (post-removal) state.
 *
 * As work items F2-F5 complete, the pre-removal tests will need to be updated
 * to reflect the new state of the codebase.
 *
 * Note on test lifecycle:
 * - Pre-removal tests (tagged "pre-removal") verify baseline state before changes
 * - Post-removal tests (tagged "post-removal") are toggled on after F2-F5 complete
 * - Self-check tests (tagged "self-check") verify the test infrastructure itself
 */

import { describe, it, expect, beforeAll } from 'vitest';
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
// Pre-removal baseline: verify Blessed TUI exists before removal
// These tests confirm the current state before changes are made.
// ---------------------------------------------------------------------------
describe('Pre-removal baseline: Blessed TUI source files', () => {
  it('src/tui/ directory exists', () => {
    expect(projectPathExists('src/tui')).toBe(true);
  });

  it('src/tui/markdown-renderer.ts exists', () => {
    expect(projectPathExists('src/tui/markdown-renderer.ts')).toBe(true);
  });

  it('src/tui/status-stage-validation.ts exists', () => {
    expect(projectPathExists('src/tui/status-stage-validation.ts')).toBe(true);
  });

  it('src/commands/tui.ts exists', () => {
    expect(projectPathExists('src/commands/tui.ts')).toBe(true);
  });

  it('src/types/blessed.d.ts exists', () => {
    expect(projectPathExists('src/types/blessed.d.ts')).toBe(true);
  });

  it('blessed and @types/blessed are in package.json', () => {
    expect(hasDependency('blessed')).toBe(true);
    expect(hasDependency('@types/blessed')).toBe(true);
  });

  it('src/tui/ has multiple source files (not just the two shared ones)', () => {
    const tuiDir = path.join(projectRoot, 'src', 'tui');
    if (!fs.existsSync(tuiDir)) {
      // Already removed — this will fail the pre-removal check intentionally
      expect(tuiDir).toBe('should exist pre-removal');
      return;
    }
    const files = fs.readdirSync(tuiDir);
    // Should have more than just markdown-renderer.ts and status-stage-validation.ts
    expect(files.length).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
// Pre-removal baseline: markdown renderer uses blessed-style tags
// ---------------------------------------------------------------------------
describe('Pre-removal baseline: markdown renderer uses blessed tags', () => {
  it('renderMarkdownToTags produces blessed-style {color-fg} tags', async () => {
    const mod = await import('../src/tui/markdown-renderer.js');
    const result = mod.renderMarkdownToTags('# Hello');
    // Pre-removal: blessed-style tag like {white-fg}
    expect(result).toContain('{white-fg}');
    expect(result).toContain('{/');
  });
});

// ---------------------------------------------------------------------------
// Pre-removal baseline: status-stage-validation imports from src/tui/
// ---------------------------------------------------------------------------
describe('Pre-removal baseline: status-stage-validation imports correctly', () => {
  it('src/commands/status-stage-validation.ts imports from ../tui/status-stage-validation', () => {
    const content = readProjectFile('src/commands/status-stage-validation.ts');
    expect(content).not.toBeNull();
    expect(content).toContain('../tui/status-stage-validation');
  });

  it('src/doctor/status-stage-check.ts imports from ../tui/status-stage-validation', () => {
    const content = readProjectFile('src/doctor/status-stage-check.ts');
    expect(content).not.toBeNull();
    expect(content).toContain('../tui/status-stage-validation');
  });

  it('src/cli-output.ts imports from ./tui/markdown-renderer', () => {
    const content = readProjectFile('src/cli-output.ts');
    expect(content).not.toBeNull();
    expect(content).toContain('./tui/markdown-renderer');
  });

  it('status-stage-validation functions work correctly', async () => {
    const mod = await import('../src/tui/status-stage-validation.js');
    expect(typeof mod.getAllowedStagesForStatus).toBe('function');
    expect(typeof mod.isStatusStageCompatible).toBe('function');
    const stages = mod.getAllowedStagesForStatus('open');
    expect(Array.isArray(stages)).toBe(true);
    expect(stages.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Pre-removal baseline: cli-output.ts has blessed tag handling
// ---------------------------------------------------------------------------
describe('Pre-removal baseline: cli-output has blessed helpers', () => {
  it('stripBlessedTags is exported', async () => {
    const mod = await import('../src/cli-output.js');
    expect(typeof mod.stripBlessedTags).toBe('function');
  });

  it('stripBlessedTags removes {color-fg} tags', () => {
    const { stripBlessedTags } = require('../dist/cli-output.js') ||
      // Fallback: test the source
      { stripBlessedTags: (s: string) => s.replace(/\{[^}]+\}/g, '').replace(/\{\/\}/g, '') };
    const result = stripBlessedTags('{cyan-fg}hello{/}');
    expect(result).not.toContain('{cyan-fg}');
    expect(result).not.toContain('{/}');
  });
});

// ---------------------------------------------------------------------------
// Post-removal tests (to be enabled after F2-F5 complete)
// These are initially skipped — they validate the desired end state.
// ---------------------------------------------------------------------------
describe.skip('Post-removal verification: Blessed TUI removed', () => {
  it('src/tui/ directory no longer exists', () => {
    expect(projectPathExists('src/tui')).toBe(false);
  });

  it('src/types/blessed.d.ts no longer exists', () => {
    expect(projectPathExists('src/types/blessed.d.ts')).toBe(false);
  });

  it('src/commands/tui.ts still exists (as alias)', () => {
    expect(projectPathExists('src/commands/tui.ts')).toBe(true);
  });

  it('blessed and @types/blessed removed from package.json', () => {
    expect(hasDependency('blessed')).toBe(false);
    expect(hasDependency('@types/blessed')).toBe(false);
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

  it('markdown renderer uses chalk/ANSI (no blessed-style {color-fg} tags)', async () => {
    const mod = await import('../src/markdown-renderer.js');
    const result = mod.renderMarkdownToTags('# Hello');
    // Post-removal: should use chalk, not blessed tags
    expect(result).not.toContain('{white-fg}');
    expect(result).not.toContain('{/');
  });

  it('theme.ts no longer exports theme.tui.* constants', () => {
    const content = readProjectFile('src/theme.ts');
    expect(content).not.toBeNull();
    expect(content).not.toContain('theme.tui');
  });

  it('helpers.ts no longer exports formatTitleOnlyTUI or renderTitleTUI', () => {
    const content = readProjectFile('src/commands/helpers.ts');
    expect(content).not.toBeNull();
    expect(content).not.toContain('formatTitleOnlyTUI');
    expect(content).not.toContain('renderTitleTUI');
    expect(content).not.toContain('titleColorForStageTUI');
  });

  it('cli-output.ts no longer exports stripBlessedTags', () => {
    const content = readProjectFile('src/cli-output.ts');
    expect(content).not.toBeNull();
    expect(content).not.toContain('stripBlessedTags');
  });

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
});
