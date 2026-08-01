/**
 * tests/herdr/plugin-manifest.test.ts — Tests for the herdr-plugin.toml manifest
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'js-yaml';

// Since herdr-plugin.toml uses TOML, we'll parse it manually or use a TOML parser.
// For simplicity, we check key patterns in the raw text.
// If the project has a TOML parser available, we could use that.

const PLUGIN_TOML_PATH = join(process.cwd(), 'packages/herdr/herdr-plugin.toml');

describe('herdr-plugin.toml', () => {
  it('exists at the expected path', () => {
    expect(existsSync(PLUGIN_TOML_PATH)).toBe(true);
  });

  it('contains required fields', () => {
    const content = readFileSync(PLUGIN_TOML_PATH, 'utf-8');
    expect(content).toContain('id =');
    expect(content).toContain('name =');
    expect(content).toContain('version =');
    expect(content).toContain('description =');
    expect(content).toContain('min_herdr_version =');
  });

  it('defines at least one action', () => {
    const content = readFileSync(PLUGIN_TOML_PATH, 'utf-8');
    expect(content).toContain('[[actions]]');
  });

  it('defines a pane for the selection list', () => {
    const content = readFileSync(PLUGIN_TOML_PATH, 'utf-8');
    expect(content).toContain('[[panes]]');
  });

  it('has a unique plugin id with worklog prefix', () => {
    const content = readFileSync(PLUGIN_TOML_PATH, 'utf-8');
    // The plugin ID should reference worklog
    expect(content).toMatch(/id\s*=\s*"worklog/i);
  });

  it('has a build step that invokes npm build', () => {
    const content = readFileSync(PLUGIN_TOML_PATH, 'utf-8');
    expect(content).toContain('[[build]]');
    expect(content).toContain('npm');
    expect(content).toContain('run');
    expect(content).toContain('build');
  });

  it('open action references the open script', () => {
    const content = readFileSync(PLUGIN_TOML_PATH, 'utf-8');
    expect(content).toContain('open');
  });

  it('toggle action exists', () => {
    const content = readFileSync(PLUGIN_TOML_PATH, 'utf-8');
    expect(content).toContain('toggle');
  });
});
