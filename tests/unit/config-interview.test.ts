/**
 * Tests for the optional `interview` configuration section and
 * `isIntelligentInterviewEnabled`.
 *
 * The `interview.intelligent` flag is the config-file equivalent of the
 * `wl interview --llm` flag: it opts in to LLM-assisted clarifying-question
 * extraction when the deterministic parser finds no questions. An absent
 * section (or a non-true value) leaves the feature off, so existing users see
 * no behaviour change.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import {
  getConfigDir,
  getConfigPath,
  loadConfig,
  isIntelligentInterviewEnabled,
  validateInterviewConfig,
} from '../../src/config.js';
import type { WorklogConfig } from '../../src/types.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';

/** Minimal valid WorklogConfig used for direct helper tests. */
function baseConfig(overrides: Partial<WorklogConfig> = {}): WorklogConfig {
  return {
    projectName: 'Test',
    prefix: 'TST',
    ...overrides,
  };
}

describe('interview configuration', () => {
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

  /** Write a config.yaml with the given body lines. */
  function writeConfig(body: string[]): void {
    const configDir = getConfigDir();
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(getConfigPath(), body.join('\n'), 'utf-8');
  }

  describe('isIntelligentInterviewEnabled', () => {
    it('is off when the section is absent', () => {
      expect(isIntelligentInterviewEnabled(baseConfig())).toBe(false);
      expect(isIntelligentInterviewEnabled(null)).toBe(false);
      expect(isIntelligentInterviewEnabled(undefined)).toBe(false);
    });

    it('is off when intelligent is false or missing', () => {
      expect(isIntelligentInterviewEnabled(baseConfig({ interview: {} }))).toBe(false);
      expect(
        isIntelligentInterviewEnabled(baseConfig({ interview: { intelligent: false } })),
      ).toBe(false);
    });

    it('is on when intelligent is true', () => {
      expect(
        isIntelligentInterviewEnabled(baseConfig({ interview: { intelligent: true } })),
      ).toBe(true);
    });
  });

  describe('validateInterviewConfig', () => {
    it('accepts an absent or valid section', () => {
      expect(validateInterviewConfig(baseConfig())).toBeNull();
      expect(
        validateInterviewConfig(baseConfig({ interview: { intelligent: true } })),
      ).toBeNull();
      expect(
        validateInterviewConfig(baseConfig({ interview: { intelligent: false } })),
      ).toBeNull();
    });

    it('rejects a non-object section', () => {
      expect(
        validateInterviewConfig(baseConfig({ interview: 'yes' as unknown as object })),
      ).toMatch(/interview must be an object/);
    });

    it('rejects an array section', () => {
      expect(
        validateInterviewConfig(baseConfig({ interview: [] as unknown as object })),
      ).toMatch(/interview must be an object/);
    });

    it('rejects a non-boolean intelligent value', () => {
      expect(
        validateInterviewConfig(
          baseConfig({ interview: { intelligent: 'yes' as unknown as boolean } }),
        ),
      ).toMatch(/interview\.intelligent must be a boolean/);
    });
  });

  describe('loadConfig with an interview section', () => {
    it('preserves an intelligent: true section', () => {
      writeConfig([
        'projectName: Test Project',
        'prefix: TEST',
        'interview:',
        '  intelligent: true',
      ]);

      const config = loadConfig();
      expect(config).not.toBeNull();
      expect(config?.interview).toEqual({ intelligent: true });
      expect(isIntelligentInterviewEnabled(config)).toBe(true);
    });

    it('leaves interview undefined when the section is absent', () => {
      writeConfig(['projectName: Test Project', 'prefix: TEST']);

      const config = loadConfig();
      expect(config).not.toBeNull();
      expect(config?.interview).toBeUndefined();
      expect(isIntelligentInterviewEnabled(config)).toBe(false);
    });

    it('rejects a non-object interview section', () => {
      writeConfig([
        'projectName: Test Project',
        'prefix: TEST',
        'interview: not-an-object',
      ]);

      expect(loadConfig()).toBeNull();
    });

    it('rejects a non-boolean interview.intelligent value', () => {
      writeConfig([
        'projectName: Test Project',
        'prefix: TEST',
        'interview:',
        '  intelligent: maybe',
      ]);

      expect(loadConfig()).toBeNull();
    });
  });
});
