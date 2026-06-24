/**
 * Extension label test — validates that the worklog extension entry point
 * path resolves to a label of "Worklog" when processed by Pi's label
 * derivation logic.
 *
 * Pi derives non-package extension display labels from the file path:
 *   1. Split the path into segments
 *   2. Strip "index.ts" or "index.js" from the end if present
 *   3. Find the shortest unique suffix among all extensions
 *
 * After restructuring, the entry point is at:
 *   .../extensions/Worklog/index.ts
 *
 * After stripping index.ts, the last segment is "Worklog", which becomes
 * the display label.
 *
 * This test validates:
 * 1. The entry point exists at the expected path
 * 2. The package.json manifest is correct
 * 3. The path-derived label would be "Worklog"
 * 4. All canonical exports from the module resolve correctly
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const EXTENSIONS_DIR = path.resolve(PROJECT_ROOT, 'packages/tui/extensions');
const WORKLOG_ENTRY = path.resolve(EXTENSIONS_DIR, 'Worklog/index.ts');
const MANIFEST_PATH = path.resolve(EXTENSIONS_DIR, 'package.json');

describe('Extension label derivation', () => {
  it('entry point exists at extensions/Worklog/index.ts', () => {
    expect(existsSync(WORKLOG_ENTRY)).toBe(true);
  });

  it('package.json manifest exists in extensions directory', () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true);
  });

  it('pi manifest declares Worklog/index.ts as extension entry', () => {
    const manifest = JSON.parse(
      require('fs').readFileSync(MANIFEST_PATH, 'utf-8')
    );
    expect(manifest.pi).toBeDefined();
    expect(manifest.pi.extensions).toBeInstanceOf(Array);
    expect(manifest.pi.extensions).toContain('./Worklog/index.ts');
  });

  it('path-derived label resolves to Worklog', () => {
    // Simulate Pi's getCompactNonPackageExtensionLabel logic:
    // Split path, strip index.ts, last segment is the label
    const segments = WORKLOG_ENTRY
      .replace(/\\/g, '/')
      .split('/')
      .filter(s => s.length > 0);

    // Remove index.ts from end
    const last = segments[segments.length - 1];
    if (segments.length > 1 && (last === 'index.ts' || last === 'index.js')) {
      segments.pop();
    }

    const lastSegment = segments[segments.length - 1];
    expect(lastSegment).toBe('Worklog');
  });
});

describe('Canonical exports', () => {
  it('all exports resolve from Worklog/index.ts', async () => {
    const mod = await import('../extensions/Worklog/index.ts');
    expect(mod.createWorklogBrowseExtension).toBeDefined();
    expect(mod.default).toBeDefined();
    expect(mod.defaultChooseWorkItem).toBeDefined();
    expect(mod.buildSelectionWidget).toBeDefined();
    expect(mod.getIconPrefix).toBeDefined();
    expect(mod.formatBrowseOption).toBeDefined();
    expect(mod.createScrollableWidget).toBeDefined();
    expect(mod.STAGE_MAP).toBeDefined();
    expect(mod.createDefaultListWorkItems).toBeDefined();
    expect(mod.createListWorkItemsWithStage).toBeDefined();
    expect(typeof mod.createWorklogBrowseExtension).toBe('function');
  });

  it('no index.ts exists at the legacy extensions path', () => {
    // The re-export shim was removed to prevent Pi from auto-discovering
    // it as a separate extension alongside Worklog/index.ts
    const legacyPath = path.resolve(EXTENSIONS_DIR, 'index.ts');
    expect(existsSync(legacyPath)).toBe(false);
  });
});
