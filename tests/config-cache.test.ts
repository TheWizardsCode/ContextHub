/**
 * Per-process config load cache (WL-0MVWLBZG4003A803).
 *
 * `getDatabase()` calls `loadConfigRelaxed()` on every CLI invocation, which
 * reads and `yaml.load`s `.worklog/config.defaults.yaml` + `.worklog/config.yaml`
 * each time. In one process (the in-process test harness makes ~1200 such
 * calls) the files are almost always unchanged, so the parse is repeated
 * needless work.
 *
 * The cache is keyed on the **content** of the resolved config files (not just
 * mtime/size) so a same-size rewrite within one filesystem timestamp tick is
 * still detected, and it records the resolved `LLM_*` environment snapshot
 * because `loadConfig`/`loadConfigRelaxed` fold env vars into `config.llm`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  getConfigDir,
  getConfigPath,
  loadConfig,
  loadConfigRelaxed,
  resetConfigCache,
} from '../src/config.js';
import { createTempDir, cleanupTempDir } from './test-utils.js';

const LLM_ENV_KEYS = ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY', 'LLM_TIMEOUT_MS'] as const;

describe('config load cache', () => {
  let tempDir: string;
  let originalCwd: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = createTempDir();
    originalCwd = process.cwd();
    process.chdir(tempDir);
    savedEnv = { ...process.env };
    for (const key of LLM_ENV_KEYS) delete process.env[key];
    resetConfigCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = savedEnv;
    resetConfigCache();
    cleanupTempDir(tempDir);
  });

  function writeConfigFile(body: string): void {
    const configDir = getConfigDir();
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(getConfigPath(), body, 'utf-8');
  }

  const BASE = 'projectName: Cache Test\nprefix: CACHE\n';

  it('reuses the parsed result on a second call while the files are unchanged', () => {
    writeConfigFile(BASE);

    const firstRelaxed = loadConfigRelaxed();
    expect(firstRelaxed).not.toBeNull();
    // Same object identity → the YAML parse did not run again.
    expect(loadConfigRelaxed()).toBe(firstRelaxed);

    const firstValidated = loadConfig();
    expect(firstValidated).not.toBeNull();
    expect(loadConfig()).toBe(firstValidated);
  });

  it('re-parses when the config file content changes', () => {
    writeConfigFile(BASE);
    const first = loadConfigRelaxed();

    writeConfigFile('projectName: Cache Test\nprefix: NEWPFX\n');
    const second = loadConfigRelaxed();

    expect(second).not.toBe(first);
    expect(second?.prefix).toBe('NEWPFX');
    expect(loadConfig()?.prefix).toBe('NEWPFX');
  });

  it('detects a same-size rewrite (content-keyed, not mtime/size only)', () => {
    writeConfigFile('projectName: Cache Test\nprefix: AAA\n');
    expect(loadConfigRelaxed()?.prefix).toBe('AAA');

    // Identical length, written immediately afterwards: mtime/size alone can
    // miss this, so the cache must compare content.
    writeConfigFile('projectName: Cache Test\nprefix: BBB\n');
    expect(loadConfigRelaxed()?.prefix).toBe('BBB');
  });

  it('reflects a LLM_* environment change even when the files are unchanged', () => {
    writeConfigFile(BASE);
    expect(loadConfigRelaxed()?.llm).toBeUndefined();

    process.env.LLM_BASE_URL = 'http://env-url/v1';
    process.env.LLM_MODEL = 'env-model';

    const afterEnvChange = loadConfigRelaxed();
    expect(afterEnvChange?.llm).toEqual({
      baseUrl: 'http://env-url/v1',
      model: 'env-model',
      apiKey: '',
      timeoutMs: 15000,
    });
  });

  it('does not leak a cached entry into another worklog directory', () => {
    writeConfigFile(BASE);
    expect(loadConfigRelaxed()?.prefix).toBe('CACHE');

    const otherDir = createTempDir();
    try {
      process.chdir(otherDir);
      const otherConfigDir = getConfigDir();
      fs.mkdirSync(otherConfigDir, { recursive: true });
      fs.writeFileSync(getConfigPath(), 'projectName: Other\nprefix: OTHER\n', 'utf-8');

      expect(loadConfigRelaxed()?.prefix).toBe('OTHER');
    } finally {
      process.chdir(tempDir);
      cleanupTempDir(otherDir);
    }
  });

  it('resetConfigCache forces a fresh parse', () => {
    writeConfigFile(BASE);
    const first = loadConfigRelaxed();

    resetConfigCache();

    const second = loadConfigRelaxed();
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it('returns null (and caches the miss) when no config exists yet', () => {
    // No .worklog/config.yaml in the temp dir.
    expect(loadConfigRelaxed()).toBeNull();
    expect(loadConfigRelaxed()).toBeNull();
    expect(loadConfig()).toBeNull();
    expect(fs.existsSync(path.join(tempDir, '.worklog', 'config.yaml'))).toBe(false);
  });
});
