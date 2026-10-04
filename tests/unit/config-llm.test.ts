/**
 * Tests for the optional `llm` configuration section and `resolveLlmConfig`.
 *
 * The `llm.*` section mirrors `embedding.*`: config-file values take
 * precedence over environment variables, which take precedence over the
 * built-in defaults (local LLM proxy, `compact` model, 15 s timeout).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  getConfigDir,
  getConfigPath,
  loadConfig,
  resolveLlmConfig,
} from '../../src/config.js';
import type { WorklogConfig } from '../../src/types.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';

/** Minimal valid WorklogConfig used for direct resolveLlmConfig tests. */
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

describe('LLM configuration', () => {
  let tempDir: string;
  let originalCwd: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = createTempDir();
    originalCwd = process.cwd();
    process.chdir(tempDir);

    savedEnv = { ...process.env };
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_TIMEOUT_MS;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = savedEnv;
    cleanupTempDir(tempDir);
  });

  /** Write a config.yaml with the given body lines. */
  function writeConfig(body: string[]): void {
    const configDir = getConfigDir();
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(getConfigPath(), body.join('\n'), 'utf-8');
  }

  describe('resolveLlmConfig precedence', () => {
    it('returns undefined when neither config nor env vars are set', () => {
      const result = resolveLlmConfig(baseConfig());
      expect(result).toBeUndefined();
    });

    it('applies built-in defaults for an empty llm section', () => {
      const result = resolveLlmConfig(baseConfig({ llm: {} }));
      expect(result).toEqual({
        baseUrl: 'http://192.168.0.199:8000/v1',
        model: 'compact',
        apiKey: '',
        timeoutMs: 15000,
      });
    });

    it('gives config values precedence over environment variables', () => {
      process.env.LLM_BASE_URL = 'http://env-url/v1';
      process.env.LLM_MODEL = 'env-model';
      process.env.LLM_TIMEOUT_MS = '30000';

      const result = resolveLlmConfig(
        baseConfig({
          llm: {
            baseUrl: 'http://config-url/v1',
            model: 'config-model',
            timeoutMs: 10000,
          },
        }),
      );

      expect(result).toEqual({
        baseUrl: 'http://config-url/v1',
        model: 'config-model',
        apiKey: '',
        timeoutMs: 10000,
      });
    });

    it('fills missing config fields from environment variables', () => {
      process.env.LLM_BASE_URL = 'http://env-url/v1';
      process.env.LLM_TIMEOUT_MS = '30000';

      const result = resolveLlmConfig(baseConfig({ llm: { model: 'config-model' } }));

      expect(result).toEqual({
        baseUrl: 'http://env-url/v1',
        model: 'config-model',
        apiKey: '',
        timeoutMs: 30000,
      });
    });

    it('uses env vars alone when no llm section exists', () => {
      process.env.LLM_BASE_URL = 'http://env-url/v1';

      const result = resolveLlmConfig(baseConfig());

      expect(result).toEqual({
        baseUrl: 'http://env-url/v1',
        model: 'compact',
        apiKey: '',
        timeoutMs: 15000,
      });
    });

    it('ignores an invalid LLM_TIMEOUT_MS env var and falls back to the default', () => {
      process.env.LLM_BASE_URL = 'http://env-url/v1';
      process.env.LLM_TIMEOUT_MS = 'not-a-number';

      const result = resolveLlmConfig(baseConfig());

      expect(result?.timeoutMs).toBe(15000);
    });
  });

  describe('loadConfig with an llm section', () => {
    it('loads the full llm section from config.yaml', () => {
      writeConfig([
        'projectName: Test Project',
        'prefix: TEST',
        'llm:',
        '  baseUrl: http://localhost:8000/v1',
        '  model: my-compact-model',
        '  apiKey: secret-key',
        '  timeoutMs: 20000',
      ]);

      const config = loadConfig();
      expect(config?.llm).toEqual({
        baseUrl: 'http://localhost:8000/v1',
        model: 'my-compact-model',
        apiKey: 'secret-key',
        timeoutMs: 20000,
      });
    });

    it('applies defaults when the llm section only sets the model', () => {
      writeConfig([
        'projectName: Test Project',
        'prefix: TEST',
        'llm:',
        '  model: compact',
      ]);

      const config = loadConfig();
      expect(config?.llm?.baseUrl).toBe('http://192.168.0.199:8000/v1');
      expect(config?.llm?.model).toBe('compact');
      expect(config?.llm?.timeoutMs).toBe(15000);
    });

    it('leaves llm undefined when no llm config or env vars are present', () => {
      writeConfig(['projectName: Test Project', 'prefix: TEST']);

      const config = loadConfig();
      expect(config).not.toBeNull();
      expect(config?.llm).toBeUndefined();
    });

    it('does not set llm when only an embedding section is configured', () => {
      writeConfig([
        'projectName: Test Project',
        'prefix: TEST',
        'embedding:',
        '  baseUrl: http://localhost:11434/v1',
        '  model: nomic-embed-text',
      ]);

      const config = loadConfig();
      expect(config?.embedding).toEqual({
        baseUrl: 'http://localhost:11434/v1',
        model: 'nomic-embed-text',
      });
      expect(config?.llm).toBeUndefined();
    });
  });

  describe('llm validation', () => {
    it('rejects a non-object llm section', () => {
      writeConfig([
        'projectName: Test Project',
        'prefix: TEST',
        'llm: not-an-object',
      ]);

      expect(loadConfig()).toBeNull();
    });

    it('rejects a non-positive llm.timeoutMs', () => {
      writeConfig([
        'projectName: Test Project',
        'prefix: TEST',
        'llm:',
        '  timeoutMs: -1',
      ]);

      expect(loadConfig()).toBeNull();
    });

    it('rejects an empty llm.baseUrl string', () => {
      writeConfig([
        'projectName: Test Project',
        'prefix: TEST',
        'llm:',
        '  baseUrl: ""',
      ]);

      expect(loadConfig()).toBeNull();
    });

    it('rejects a non-string llm.apiKey', () => {
      writeConfig([
        'projectName: Test Project',
        'prefix: TEST',
        'llm:',
        '  apiKey: 123',
      ]);

      expect(loadConfig()).toBeNull();
    });
  });
});
