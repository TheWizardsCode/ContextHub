/**
 * Tests for the optional `cta` (call-to-action) configuration field and the
 * `resolveProjectCta` resolver.
 *
 * The `cta` field is a free-form Markdown string surfaced in release/report
 * output. It is optional: an absent value leaves `loadConfig()` unchanged and
 * resolves to `null`, so report consumers see no behaviour change. The two-tier
 * config system merges `config.defaults.yaml` under `config.yaml`, so a
 * `config.yaml` value overrides the team default (WL-0MUWCGF670087GAS).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import {
  getConfigDir,
  getConfigDefaultsPath,
  getConfigPath,
  loadConfig,
  resolveProjectCta,
} from '../../src/config.js';
import type { WorklogConfig } from '../../src/types.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';

/** Sample Markdown CTA used across the tests. */
const SAMPLE_CTA =
  '[Play the alpha release](https://thewizardscode.github.io/Tableau-Card-Engine/). Provide feedback in [Discord](https://discord.gg/gUKQTFkzQ4)';

/** Minimal valid WorklogConfig used for direct resolveProjectCta tests. */
function baseConfig(overrides: Partial<WorklogConfig> = {}): WorklogConfig {
  return {
    projectName: 'Test',
    prefix: 'TST',
    statuses: [
      { value: 'open', label: 'Open' },
      { value: 'completed', label: 'Completed' },
    ],
    stages: [
      { value: 'idea', label: 'Idea' },
      { value: 'done', label: 'Done' },
    ],
    statusStageCompatibility: {
      open: ['idea'],
      completed: ['done'],
    },
    ...overrides,
  };
}

describe('CTA configuration', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = createTempDir();
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanupTempDir(tempDir);
  });

  /** Write `.worklog/<file>` with the given body. */
  function writeConfigFile(file: string, body: string): void {
    const configDir = getConfigDir();
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(file === 'config.yaml' ? getConfigPath() : getConfigDefaultsPath(), body, 'utf-8');
  }

  /** A valid config.yaml body without a CTA. */
  function minimalConfigBody(extra: string[] = []): string {
    return [
      'projectName: Test Project',
      'prefix: TST',
      ...extra,
    ].join('\n');
  }

  describe('loadConfig()', () => {
    it('returns the configured cta string', () => {
      writeConfigFile('config.yaml', minimalConfigBody([`cta: "${SAMPLE_CTA}"`]));

      const config = loadConfig();
      expect(config).not.toBeNull();
      expect(config?.cta).toBe(SAMPLE_CTA);
    });

    it('leaves cta undefined when absent (no behaviour change)', () => {
      writeConfigFile('config.yaml', minimalConfigBody());

      const config = loadConfig();
      expect(config).not.toBeNull();
      expect(config?.cta).toBeUndefined();
    });

    it('preserves Markdown link syntax through the YAML round-trip', () => {
      writeConfigFile('config.yaml', minimalConfigBody([`cta: "${SAMPLE_CTA}"`]));

      const config = loadConfig();
      expect(config?.cta).toContain('[Play the alpha release](');
      expect(config?.cta).toContain('[Discord](https://discord.gg/gUKQTFkzQ4)');
    });

    it('merges cta from config.defaults.yaml when config.yaml omits it', () => {
      const defaultsCta = '[Play the defaults release](https://example.github.io/default/).';
      writeConfigFile('config.defaults.yaml', minimalConfigBody([`cta: "${defaultsCta}"`]));
      writeConfigFile('config.yaml', minimalConfigBody());

      const config = loadConfig();
      expect(config?.cta).toBe(defaultsCta);
    });

    it('overrides the defaults cta with the config.yaml cta', () => {
      writeConfigFile(
        'config.defaults.yaml',
        minimalConfigBody(['cta: "[Play the defaults release](https://example.github.io/default/)."']),
      );
      writeConfigFile('config.yaml', minimalConfigBody([`cta: "${SAMPLE_CTA}"`]));

      const config = loadConfig();
      expect(config?.cta).toBe(SAMPLE_CTA);
    });

    it('rejects a non-string cta', () => {
      writeConfigFile('config.yaml', minimalConfigBody(['cta:', '  play: the alpha']));

      expect(loadConfig()).toBeNull();
    });
  });

  describe('resolveProjectCta()', () => {
    it('returns the configured cta string', () => {
      expect(resolveProjectCta(baseConfig({ cta: SAMPLE_CTA }))).toBe(SAMPLE_CTA);
    });

    it('returns null when the cta is absent', () => {
      expect(resolveProjectCta(baseConfig())).toBeNull();
    });

    it('returns null for a null or undefined config', () => {
      expect(resolveProjectCta(null)).toBeNull();
      expect(resolveProjectCta(undefined)).toBeNull();
    });

    it('returns null for a blank cta', () => {
      expect(resolveProjectCta(baseConfig({ cta: '' }))).toBeNull();
      expect(resolveProjectCta(baseConfig({ cta: '   ' }))).toBeNull();
    });

    it('reflects a merged defaults/override config object', () => {
      const merged = { ...baseConfig(), cta: SAMPLE_CTA };
      expect(resolveProjectCta(merged)).toBe(SAMPLE_CTA);
    });
  });
});
