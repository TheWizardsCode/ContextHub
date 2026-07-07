/**
 * Unit tests for lib/skill-path.ts — Skill path discovery tool.
 *
 * Run: npx vitest run packages/tui/extensions/Worklog/lib/skill-path.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// We'll test the core discovery logic by mocking fs.existsSync and
// verifying the registration function produces the expected tool shape.

describe('skill-path discovery', () => {
  let existsSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    existsSyncSpy = vi.spyOn(fs, 'existsSync');
    // Clear the skill path cache between tests to avoid cross-test contamination
    const mod = await import('./skill-path.js');
    mod.clearSkillPathCache();
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
  });

  it('should export discoverSkillPath and registerSkillPathTool', async () => {
    const mod = await import('./skill-path.js');
    expect(typeof mod.discoverSkillPath).toBe('function');
    expect(typeof mod.registerSkillPathTool).toBe('function');
  });

  describe('discoverSkillPath', () => {
    it('should find a skill in ~/.pi/agent/skills/', async () => {
      const mod = await import('./skill-path.js');
      const expectedPath = path.join(os.homedir(), '.pi', 'agent', 'skills', 'my-skill');
      existsSyncSpy.mockImplementation((p) => p === expectedPath);

      const result = mod.discoverSkillPath('my-skill');
      expect(result).toBe(expectedPath);
    });

    it('should find a skill in project-local .pi/skills/', async () => {
      const mod = await import('./skill-path.js');
      const globalPath = path.join(os.homedir(), '.pi', 'agent', 'skills', 'my-skill');
      const localPath = path.join(process.cwd(), '.pi', 'skills', 'my-skill');
      existsSyncSpy.mockImplementation((p) => p === localPath);

      const result = mod.discoverSkillPath('my-skill');
      expect(result).toBe(localPath);
    });

    it('should prefer global path over local (global checked first)', async () => {
      const mod = await import('./skill-path.js');
      const globalPath = path.join(os.homedir(), '.pi', 'agent', 'skills', 'my-skill');
      const localPath = path.join(process.cwd(), '.pi', 'skills', 'my-skill');
      existsSyncSpy.mockImplementation((p) => p === globalPath || p === localPath);

      const result = mod.discoverSkillPath('my-skill');
      // Should return the global path since it's checked first
      expect(result).toBe(globalPath);
    });

    it('should throw when skill is not found in any location', async () => {
      const mod = await import('./skill-path.js');
      existsSyncSpy.mockReturnValue(false);

      expect(() => mod.discoverSkillPath('nonexistent-skill')).toThrow(
        'Skill not found: nonexistent-skill'
      );
    });

    it('should throw with a clear error message', async () => {
      const mod = await import('./skill-path.js');
      existsSyncSpy.mockReturnValue(false);

      try {
        mod.discoverSkillPath('unknown');
        // Force test failure if no error thrown
        expect(true).toBe(false);
      } catch (e: any) {
        expect(e.message).toContain('Skill not found');
        expect(e.message).toContain('unknown');
      }
    });

    it('should check global path first, then local path', async () => {
      const mod = await import('./skill-path.js');
      const checkedPaths: string[] = [];
      existsSyncSpy.mockImplementation((p: string) => {
        checkedPaths.push(p);
        return false;
      });

      expect(() => mod.discoverSkillPath('test-skill')).toThrow();

      expect(checkedPaths.length).toBe(2);
      expect(checkedPaths[0]).toContain(path.join('.pi', 'agent', 'skills', 'test-skill'));
      expect(checkedPaths[1]).toContain(path.join('.pi', 'skills', 'test-skill'));
    });
  });

  describe('caching', () => {
    it('should cache discovered paths and avoid repeated filesystem scans', async () => {
      const mod = await import('./skill-path.js');
      const globalPath = path.join(os.homedir(), '.pi', 'agent', 'skills', 'cached-skill');

      // First call: filesystem is checked
      existsSyncSpy.mockImplementation((p) => p === globalPath);
      const firstResult = mod.discoverSkillPath('cached-skill');
      expect(firstResult).toBe(globalPath);
      // Only called once (global) since it returns on first match
      expect(existsSyncSpy).toHaveBeenCalledTimes(1);

      // Reset spy to ensure no more calls to existsSync on cache hit
      existsSyncSpy.mockClear();

      // Second call: should use cache
      const secondResult = mod.discoverSkillPath('cached-skill');
      expect(secondResult).toBe(globalPath);
      // existsSync should NOT have been called again
      expect(existsSyncSpy).not.toHaveBeenCalled();
    });

    it('should cache negative results (not found)', async () => {
      const mod = await import('./skill-path.js');

      // First call: not found, throws
      existsSyncSpy.mockReturnValue(false);
      expect(() => mod.discoverSkillPath('missing-skill')).toThrow();

      // existsSync was called 2 times
      expect(existsSyncSpy).toHaveBeenCalledTimes(2);

      // Reset and clear mock
      existsSyncSpy.mockClear();

      // Second call: should throw from cache without checking filesystem
      // But wait — negative caching of errors is tricky. Let's check that
      // calling again throws without calling existsSync again.
      // (In our implementation, we cache the error as a thrown exception
      // or use a sentinel value.)

      // The caching could work either way — let's just verify no extra
      // filesystem calls happen on repeated lookups.
      try {
        mod.discoverSkillPath('missing-skill');
      } catch {
        // expected
      }
      // Should not have called existsSync again (cache hit)
      expect(existsSyncSpy).not.toHaveBeenCalled();
    });
  });

  describe('clearSkillPathCache', () => {
    it('should export clearSkillPathCache', async () => {
      const mod = await import('./skill-path.js');
      expect(typeof mod.clearSkillPathCache).toBe('function');
    });

    it('should clear the cache so filesystem is re-checked', async () => {
      const mod = await import('./skill-path.js');
      const globalPath = path.join(os.homedir(), '.pi', 'agent', 'skills', 'clear-skill');

      // First call: populate cache
      existsSyncSpy.mockImplementation((p) => p === globalPath);
      mod.discoverSkillPath('clear-skill');
      existsSyncSpy.mockClear();

      // Clear cache
      mod.clearSkillPathCache();

      // Next call should check filesystem again
      existsSyncSpy.mockImplementation((p) => p === globalPath);
      mod.discoverSkillPath('clear-skill');
      expect(existsSyncSpy).toHaveBeenCalled();
    });
  });

  describe('registerSkillPathTool', () => {
    it('should return a tool definition compatible with pi.registerTool', async () => {
      const mod = await import('./skill-path.js');
      const tool = mod.registerSkillPathTool();

      expect(tool).toBeDefined();
      expect(tool.name).toBe('skill_path');
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeDefined();
      expect(tool.execute).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    });

    it('should have a skillName parameter', async () => {
      const mod = await import('./skill-path.js');
      const tool = mod.registerSkillPathTool();

      // The parameters should define a skillName property
      const params = tool.parameters as any;
      expect(params).toBeDefined();
      // TypeBox Object properties
      const properties = params?.properties ?? params ?? {};
      expect(properties.skillName).toBeDefined();
    });

    it('should be callable as a tool via execute', async () => {
      const mod = await import('./skill-path.js');
      const tool = mod.registerSkillPathTool();

      const globalPath = path.join(os.homedir(), '.pi', 'agent', 'skills', 'existing-skill');
      existsSyncSpy.mockImplementation((p) => p === globalPath);

      const result = await (tool.execute as Function)(
        'call-1',
        { skillName: 'existing-skill' },
        undefined,
        undefined,
        {}
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBe(globalPath);
    });

    it('should return error content when skill is not found', async () => {
      const mod = await import('./skill-path.js');
      const tool = mod.registerSkillPathTool();

      existsSyncSpy.mockReturnValue(false);

      const result = await (tool.execute as Function)(
        'call-2',
        { skillName: 'missing-skill' },
        undefined,
        undefined,
        {}
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      // Should be an error/isError result or contain error text
      expect(result.content[0].text).toContain('Skill not found');
      expect(result.content[0].text).toContain('missing-skill');
    });
  });
});
