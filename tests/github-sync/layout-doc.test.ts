/**
 * tests/github-sync/layout-doc.test.ts — close-out gates for the
 * `src/github-sync.ts` decomposition: the barrel shape and the module-layout
 * documentation.
 *
 * Parent: WL-0MVGKH9Z900178UF (decompose the `src/github-sync.ts` god class).
 * Close-out item: WL-0MW0JFBIK007E6VZ — child 8 of 8, the final verification
 * and documentation gate.
 *
 * ## What this file protects
 *
 * | Gate | Acceptance criterion (this item) |
 * |---|---|
 * | the barrel is a thin (≤ 150 lines) re-export façade, no flow code | AC1 |
 * | every family module stays ≤ 1,000 lines | AC2 |
 * | the frozen public surface still matches the baseline | AC3, AC6 |
 * | `docs/ARCHITECTURE.md` names only real paths, every family module and every really re-exported symbol | AC4, AC7 |
 * | `docs/dev/github-sync-split.md` names every family module | AC4, AC7 |
 *
 * The size/allowlist/cycle/public-surface gates proper live in
 * `./split-guard.test.ts` and are left untouched (AC5: existing test files are
 * unmodified). This file is **additive and read-only**: it reuses the shared
 * doc-drift helpers from `../github/github-split-guard-scan.js` and the
 * github-sync family predicates from `./split-guard-scan.js`, and it asserts —
 * it never edits the tree, the barrel or another test file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  ARCHITECTURE_DOC_PATH,
  RESPONSIBILITIES_HEADING,
  extractDocSection,
  extractDocumentedPaths,
  extractResponsibilitySymbols,
  findMissingDocumentedPaths,
  findMissingDocumentedSymbols,
  findUndocumentedModules,
} from '../github/github-split-guard-scan.js';
import {
  FAMILY_ROOTS,
  GITHUB_SYNC_BARREL,
  MAX_MODULE_LINES,
  collectExportKinds,
  githubSyncFamilyModules,
  loadModuleIndex,
  namesOfKind,
  readBaseline,
} from './split-guard-scan.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Heading of the github-sync layout section of `docs/ARCHITECTURE.md`. */
const GITHUB_SYNC_LAYOUT_HEADING = '## GitHub Sync Module Layout';

/** Dev-facing orientation doc that mirrors the architecture section. */
const DEV_DOC_PATH = 'docs/dev/github-sync-split.md';

/** The barrel must stay a façade: documented re-exports only (AC1). */
const MAX_BARREL_LINES = 150;

function read(relPath: string): string {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf-8');
}

/**
 * Statements of a module, with comments and blank fragments removed.
 *
 * Splitting on `;` is enough for the barrel: every statement it may contain is
 * a single `export … from '…'` re-export, and a brace-free split keeps
 * multi-line export blocks intact.
 */
function codeStatements(source: string): string[] {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const withoutLineComments = withoutBlockComments.replace(/^\s*\/\/.*$/gm, '');
  return withoutLineComments
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Re-export statements the barrel may contain: `export { … } from './github-sync/x.js'`. */
const BARREL_STATEMENT_PATTERN =
  /^export (?:type )?\{[^}]+\} from '\.\/github-sync\/[a-z0-9-]+\.js'$/;

/** Live barrel surface, classified by export kind. */
function liveSurface(): { kinds: Map<string, 'value' | 'type'>; all: string[] } {
  const index = loadModuleIndex(repoRoot, FAMILY_ROOTS);
  const kinds = collectExportKinds(index, GITHUB_SYNC_BARREL);
  return {
    kinds,
    all: [...namesOfKind(kinds, 'value'), ...namesOfKind(kinds, 'type')].sort(),
  };
}

const architecture = read(ARCHITECTURE_DOC_PATH);
const archSection = extractDocSection(architecture, GITHUB_SYNC_LAYOUT_HEADING);

// ── The barrel is a thin façade (AC1) ────────────────────────────────

describe('github-sync barrel', () => {
  const source = read(GITHUB_SYNC_BARREL);

  it('stays a documented façade of at most 150 lines', () => {
    const lineCount = source.split('\n').length - 1; // `wc -l` semantics
    expect(lineCount).toBeLessThanOrEqual(MAX_BARREL_LINES);
    expect(source.startsWith('/**')).toBe(true);
    // The module-responsibility header names the concern and every module it
    // re-exports, so the barrel is discoverable without reading the modules.
    const header = source.slice(0, source.indexOf('*/'));
    expect(header).toContain('Concern:');
    for (const module of ['push.js', 'import.js', 'types.js', 'labels.js']) {
      expect(header, `barrel header does not name ${module}`).toContain(module);
    }
  });

  it('contains no flow implementation — only re-exports from family modules', () => {
    const statements = codeStatements(source);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement, `unexpected barrel statement: ${statement}`).toMatch(
        BARREL_STATEMENT_PATTERN,
      );
    }
    // Never import the barrel from itself, and never re-home a symbol from
    // outside the family.
    expect(source).not.toContain("'../github-sync.js'");
  });
});

// ── Size ceiling and frozen surface still hold (AC2, AC3, AC6) ───────

describe('github-sync family invariants at close-out', () => {
  const index = loadModuleIndex(repoRoot, FAMILY_ROOTS);
  const modules = githubSyncFamilyModules(index);

  it('keeps every family module under the 1,000-line ceiling', () => {
    expect(modules.map((m) => m.file)).toContain(GITHUB_SYNC_BARREL);
    expect(modules.length).toBeGreaterThan(1);
    const oversized = modules
      .filter((m) => m.lineCount > MAX_MODULE_LINES)
      .map((m) => `${m.file} (${m.lineCount})`);
    expect(oversized).toEqual([]);
  });

  it('still exports exactly the frozen baseline surface (4 values + 6 types)', () => {
    const baseline = readBaseline(repoRoot);
    const surface = liveSurface();
    expect(surface.all).toEqual([...baseline.symbols.value, ...baseline.symbols.type].sort());
    expect(baseline.symbols.value).toHaveLength(4);
    expect(baseline.symbols.type).toHaveLength(6);
    expect(namesOfKind(surface.kinds, 'value').sort()).toEqual([...baseline.symbols.value].sort());
    expect(namesOfKind(surface.kinds, 'type').sort()).toEqual([...baseline.symbols.type].sort());
  });
});

// ── The architecture docs must not drift from the tree (AC4, AC7) ────

describe('github-sync module layout documentation', () => {
  it('documents the layout, the responsibilities and the layering', () => {
    expect(archSection).not.toBeNull();
    expect(archSection).toContain(RESPONSIBILITIES_HEADING);
    expect(archSection).toContain('### Cycle-safe layering');
    expect(archSection).toContain('### Where to find X in the github-sync module');
  });

  it('names only file paths that exist in the tree', () => {
    // The section really cites modules, so a vacuous scan is impossible.
    expect(extractDocumentedPaths(archSection!)).toContain(GITHUB_SYNC_BARREL);
    expect(
      findMissingDocumentedPaths(archSection!, (relPath) =>
        fs.existsSync(path.join(repoRoot, relPath)),
      ),
    ).toEqual([]);
  });

  it('names every github-sync family module', () => {
    const modules = githubSyncFamilyModules(loadModuleIndex(repoRoot, FAMILY_ROOTS)).map(
      (m) => m.file,
    );
    expect(findUndocumentedModules(archSection!, modules)).toEqual([]);
  });

  it('names only public symbols the barrel really re-exports', () => {
    // Exactly the frozen surface: no missing symbol and no invented one, so the
    // docs cannot describe a surface the code lacks.
    expect(extractResponsibilitySymbols(archSection!)).toEqual(liveSurface().all);
    expect(findMissingDocumentedSymbols(archSection!, liveSurface().all)).toEqual([]);
  });

  it('points at the dev-facing orientation doc, which names every module', () => {
    expect(archSection).toContain(DEV_DOC_PATH);
    const devDoc = read(DEV_DOC_PATH);
    const modules = githubSyncFamilyModules(loadModuleIndex(repoRoot, FAMILY_ROOTS)).map(
      (m) => m.file,
    );
    expect(findUndocumentedModules(devDoc, modules)).toEqual([]);
    expect(devDoc).toContain('tests/github-sync/split-guard.test.ts');
  });
});

// ── The gates fail on deliberately broken input ──────────────────────

describe('layout documentation gates reject drift', () => {
  it('reports a module missing from a pruned responsibilities table', () => {
    // A synthetic section, so the case is proven independently of the live doc.
    const pruned = [
      RESPONSIBILITIES_HEADING,
      '',
      '| Module | Responsibility | Public symbols re-exported by the barrel |',
      '|---|---|---|',
      '| `src/github-sync.ts` | Public barrel. | all 10 |',
      '| `src/github-sync/progress.ts` | Progress emitter. | none (internal) |',
    ].join('\n');
    expect(
      findUndocumentedModules(pruned, [
        GITHUB_SYNC_BARREL,
        'src/github-sync/progress.ts',
        'src/github-sync/push.ts',
      ]),
    ).toEqual(['src/github-sync/push.ts']);
  });

  it('reports a documented symbol the barrel does not export', () => {
    const invented = archSection!.replace('`upsertIssuesFromWorkItems`', '`pushEverything`');
    expect(invented).not.toBe(archSection);
    expect(findMissingDocumentedSymbols(invented, liveSurface().all)).toEqual(['pushEverything']);
  });

  it('returns null for a document without the layout section', () => {
    expect(extractDocSection(architecture, '## GitHub Sync Module Layout That Never Was')).toBeNull();
  });
});
