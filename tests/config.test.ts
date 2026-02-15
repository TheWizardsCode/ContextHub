/**
 * Tests for configuration management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { 
  getConfigDir, 
  getConfigPath, 
  getConfigDefaultsPath,
  configExists,
  loadConfig,
  saveConfig,
  getDefaultPrefix
} from '../src/config.js';
import { createTempDir, cleanupTempDir } from './test-utils.js';

describe('Configuration', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    // Create a temp directory and change working directory to it
    tempDir = createTempDir();
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    // Restore original working directory and cleanup
    process.chdir(originalCwd);
    cleanupTempDir(tempDir);
  });

  describe('getConfigDir', () => {
    it('should return .worklog directory in current working directory', () => {
      const configDir = getConfigDir();
      expect(configDir).toBe(path.join(process.cwd(), '.worklog'));
    });
  });

  describe('getConfigPath', () => {
    it('should return path to config.yaml', () => {
      const configPath = getConfigPath();
      expect(configPath).toBe(path.join(process.cwd(), '.worklog', 'config.yaml'));
    });
  });

  describe('getConfigDefaultsPath', () => {
    it('should return path to config.defaults.yaml', () => {
      const defaultsPath = getConfigDefaultsPath();
      expect(defaultsPath).toBe(path.join(process.cwd(), '.worklog', 'config.defaults.yaml'));
    });
  });

  describe('configExists', () => {
    it('should return false when config does not exist', () => {
      expect(configExists()).toBe(false);
    });

    it('should return true when config exists', () => {
      const configDir = getConfigDir();
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        getConfigPath(),
        [
          'projectName: Test',
          'prefix: TEST',
          'statuses:',
          '  - value: open',
          '    label: Open',
          '  - value: in-progress',
          '    label: In Progress',
          '  - value: blocked',
          '    label: Blocked',
          '  - value: completed',
          '    label: Completed',
          '  - value: deleted',
          '    label: Deleted',
          'stages:',
          '  - value: ""',
          '    label: Undefined',
          '  - value: idea',
          '    label: Idea',
          '  - value: prd_complete',
          '    label: PRD Complete',
          '  - value: plan_complete',
          '    label: Plan Complete',
          '  - value: in_progress',
          '    label: In Progress',
          '  - value: in_review',
          '    label: In Review',
          '  - value: done',
          '    label: Done',
          'statusStageCompatibility:',
          '  open: ["", idea, prd_complete, plan_complete, in_progress]',
          '  in-progress: [in_progress]',
          '  blocked: ["", idea, prd_complete, plan_complete, in_progress]',
          '  completed: [in_review, done]',
          '  deleted: [""]'
        ].join('\n'),
        'utf-8'
      );
      
      expect(configExists()).toBe(true);
    });
  });

  describe('saveConfig', () => {
    it('should save config to file', () => {
      const config = {
        projectName: 'Test Project',
        prefix: 'TEST',
        statuses: [
          { value: 'open', label: 'Open' },
          { value: 'in-progress', label: 'In Progress' },
          { value: 'blocked', label: 'Blocked' },
          { value: 'completed', label: 'Completed' },
          { value: 'deleted', label: 'Deleted' }
        ],
        stages: [
          { value: '', label: 'Undefined' },
          { value: 'idea', label: 'Idea' },
          { value: 'prd_complete', label: 'PRD Complete' },
          { value: 'plan_complete', label: 'Plan Complete' },
          { value: 'in_progress', label: 'In Progress' },
          { value: 'in_review', label: 'In Review' },
          { value: 'done', label: 'Done' }
        ],
        statusStageCompatibility: {
          open: ['', 'idea', 'prd_complete', 'plan_complete', 'in_progress'],
          'in-progress': ['in_progress'],
          blocked: ['', 'idea', 'prd_complete', 'plan_complete', 'in_progress'],
          completed: ['in_review', 'done'],
          deleted: ['']
        }
      };

      saveConfig(config);

      expect(fs.existsSync(getConfigPath())).toBe(true);
      const content = fs.readFileSync(getConfigPath(), 'utf-8');
      expect(content).toContain('projectName: Test Project');
      expect(content).toContain('prefix: TEST');
    });

    it('should save config with autoExport setting', () => {
      const config = {
        projectName: 'Test Project',
        prefix: 'TEST',
        autoExport: false,
        statuses: [
          { value: 'open', label: 'Open' },
          { value: 'in-progress', label: 'In Progress' },
          { value: 'blocked', label: 'Blocked' },
          { value: 'completed', label: 'Completed' },
          { value: 'deleted', label: 'Deleted' }
        ],
        stages: [
          { value: '', label: 'Undefined' },
          { value: 'idea', label: 'Idea' },
          { value: 'prd_complete', label: 'PRD Complete' },
          { value: 'plan_complete', label: 'Plan Complete' },
          { value: 'in_progress', label: 'In Progress' },
          { value: 'in_review', label: 'In Review' },
          { value: 'done', label: 'Done' }
        ],
        statusStageCompatibility: {
          open: ['', 'idea', 'prd_complete', 'plan_complete', 'in_progress'],
          'in-progress': ['in_progress'],
          blocked: ['', 'idea', 'prd_complete', 'plan_complete', 'in_progress'],
          completed: ['in_review', 'done'],
          deleted: ['']
        }
      };

      saveConfig(config);

      expect(fs.existsSync(getConfigPath())).toBe(true);
      const content = fs.readFileSync(getConfigPath(), 'utf-8');
      expect(content).toContain('projectName: Test Project');
      expect(content).toContain('prefix: TEST');
      expect(content).toContain('autoExport: false');
    });

    it('should create .worklog directory if it does not exist', () => {
      const config = {
        projectName: 'Test Project',
        prefix: 'TEST',
        statuses: [
          { value: 'open', label: 'Open' },
          { value: 'in-progress', label: 'In Progress' },
          { value: 'blocked', label: 'Blocked' },
          { value: 'completed', label: 'Completed' },
          { value: 'deleted', label: 'Deleted' }
        ],
        stages: [
          { value: '', label: 'Undefined' },
          { value: 'idea', label: 'Idea' },
          { value: 'prd_complete', label: 'PRD Complete' },
          { value: 'plan_complete', label: 'Plan Complete' },
          { value: 'in_progress', label: 'In Progress' },
          { value: 'in_review', label: 'In Review' },
          { value: 'done', label: 'Done' }
        ],
        statusStageCompatibility: {
          open: ['', 'idea', 'prd_complete', 'plan_complete', 'in_progress'],
          'in-progress': ['in_progress'],
          blocked: ['', 'idea', 'prd_complete', 'plan_complete', 'in_progress'],
          completed: ['in_review', 'done'],
          deleted: ['']
        }
      };

      saveConfig(config);

      expect(fs.existsSync(getConfigDir())).toBe(true);
      expect(fs.existsSync(getConfigPath())).toBe(true);
    });
  });

  describe('loadConfig', () => {
    it('should return null when no config exists', () => {
      const config = loadConfig();
      expect(config).toBe(null);
    });

    it('should apply built-in defaults when status/stage sections are missing', () => {
      const configDir = getConfigDir();
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        getConfigPath(),
        'projectName: Test Project\nprefix: TEST',
        'utf-8'
      );

      const loaded = loadConfig();

      expect(loaded).not.toBe(null);
      expect(loaded?.projectName).toBe('Test Project');
      expect(loaded?.statuses).toBeDefined();
      expect(loaded?.statuses!.length).toBeGreaterThan(0);
      expect(loaded?.stages).toBeDefined();
      expect(loaded?.stages!.length).toBeGreaterThan(0);
      expect(loaded?.statusStageCompatibility).toBeDefined();
    });

    it('should reject empty status/stage compatibility sections', () => {
      const configDir = getConfigDir();
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        getConfigPath(),
        [
          'projectName: Test Project',
          'prefix: TEST',
          'statuses: []',
          'stages: []',
          'statusStageCompatibility: {}'
        ].join('\n'),
        'utf-8'
      );

      const loaded = loadConfig();

      expect(loaded).toBe(null);
    });

    it('should load config from file', () => {
      const testConfig = {
        projectName: 'Test Project',
        prefix: 'TEST',
        statuses: [
          { value: 'open', label: 'Open' },
          { value: 'in-progress', label: 'In Progress' },
          { value: 'blocked', label: 'Blocked' },
          { value: 'completed', label: 'Completed' },
          { value: 'deleted', label: 'Deleted' }
        ],
        stages: [
          { value: '', label: 'Undefined' },
          { value: 'idea', label: 'Idea' },
          { value: 'prd_complete', label: 'PRD Complete' },
          { value: 'plan_complete', label: 'Plan Complete' },
          { value: 'in_progress', label: 'In Progress' },
          { value: 'in_review', label: 'In Review' },
          { value: 'done', label: 'Done' }
        ],
        statusStageCompatibility: {
          open: ['', 'idea', 'prd_complete', 'plan_complete', 'in_progress'],
          'in-progress': ['in_progress'],
          blocked: ['', 'idea', 'prd_complete', 'plan_complete', 'in_progress'],
          completed: ['in_review', 'done'],
          deleted: ['']
        }
      };
      saveConfig(testConfig);

      const loaded = loadConfig();

      expect(loaded).toBeDefined();
      expect(loaded?.projectName).toBe('Test Project');
      expect(loaded?.prefix).toBe('TEST');
    });

    it('should load config with autoExport setting', () => {
      const testConfig = {
        projectName: 'Test Project',
        prefix: 'TEST',
        autoExport: false,
        statuses: [
          { value: 'open', label: 'Open' },
          { value: 'in-progress', label: 'In Progress' },
          { value: 'blocked', label: 'Blocked' },
          { value: 'completed', label: 'Completed' },
          { value: 'deleted', label: 'Deleted' }
        ],
        stages: [
          { value: '', label: 'Undefined' },
          { value: 'idea', label: 'Idea' },
          { value: 'prd_complete', label: 'PRD Complete' },
          { value: 'plan_complete', label: 'Plan Complete' },
          { value: 'in_progress', label: 'In Progress' },
          { value: 'in_review', label: 'In Review' },
          { value: 'done', label: 'Done' }
        ],
        statusStageCompatibility: {
          open: ['', 'idea', 'prd_complete', 'plan_complete', 'in_progress'],
          'in-progress': ['in_progress'],
          blocked: ['', 'idea', 'prd_complete', 'plan_complete', 'in_progress'],
          completed: ['in_review', 'done'],
          deleted: ['']
        }
      };
      saveConfig(testConfig);

      const loaded = loadConfig();

      expect(loaded).toBeDefined();
      expect(loaded?.projectName).toBe('Test Project');
      expect(loaded?.prefix).toBe('TEST');
      expect(loaded?.autoExport).toBe(false);
    });

    it('should load defaults when only defaults exist', () => {
      const configDir = getConfigDir();
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        getConfigDefaultsPath(), 
        [
          'projectName: Default Project',
          'prefix: DEF',
          'statuses:',
          '  - value: open',
          '    label: Open',
          '  - value: in-progress',
          '    label: In Progress',
          '  - value: blocked',
          '    label: Blocked',
          '  - value: completed',
          '    label: Completed',
          '  - value: deleted',
          '    label: Deleted',
          'stages:',
          '  - value: ""',
          '    label: Undefined',
          '  - value: idea',
          '    label: Idea',
          '  - value: prd_complete',
          '    label: PRD Complete',
          '  - value: plan_complete',
          '    label: Plan Complete',
          '  - value: in_progress',
          '    label: In Progress',
          '  - value: in_review',
          '    label: In Review',
          '  - value: done',
          '    label: Done',
          'statusStageCompatibility:',
          '  open: ["", idea, prd_complete, plan_complete, in_progress]',
          '  in-progress: [in_progress]',
          '  blocked: ["", idea, prd_complete, plan_complete, in_progress]',
          '  completed: [in_review, done]',
          '  deleted: [""]'
        ].join('\n'),
        'utf-8'
      );

      const loaded = loadConfig();

      expect(loaded).toBeDefined();
      expect(loaded?.projectName).toBe('Default Project');
      expect(loaded?.prefix).toBe('DEF');
    });

    it('should apply built-in defaults when status/stage sections are missing in defaults', () => {
      const configDir = getConfigDir();
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        getConfigDefaultsPath(),
        'projectName: Default Project\nprefix: DEF',
        'utf-8'
      );

      const loaded = loadConfig();

      expect(loaded).not.toBe(null);
      expect(loaded?.projectName).toBe('Default Project');
      expect(loaded?.statuses).toBeDefined();
      expect(loaded?.statuses!.length).toBeGreaterThan(0);
      expect(loaded?.stages).toBeDefined();
      expect(loaded?.stages!.length).toBeGreaterThan(0);
      expect(loaded?.statusStageCompatibility).toBeDefined();
    });

    it('should load autoExport from defaults', () => {
      const configDir = getConfigDir();
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        getConfigDefaultsPath(), 
        [
          'projectName: Default Project',
          'prefix: DEF',
          'autoExport: true',
          'statuses:',
          '  - value: open',
          '    label: Open',
          '  - value: in-progress',
          '    label: In Progress',
          '  - value: blocked',
          '    label: Blocked',
          '  - value: completed',
          '    label: Completed',
          '  - value: deleted',
          '    label: Deleted',
          'stages:',
          '  - value: ""',
          '    label: Undefined',
          '  - value: idea',
          '    label: Idea',
          '  - value: prd_complete',
          '    label: PRD Complete',
          '  - value: plan_complete',
          '    label: Plan Complete',
          '  - value: in_progress',
          '    label: In Progress',
          '  - value: in_review',
          '    label: In Review',
          '  - value: done',
          '    label: Done',
          'statusStageCompatibility:',
          '  open: ["", idea, prd_complete, plan_complete, in_progress]',
          '  in-progress: [in_progress]',
          '  blocked: ["", idea, prd_complete, plan_complete, in_progress]',
          '  completed: [in_review, done]',
          '  deleted: [""]'
        ].join('\n'),
        'utf-8'
      );

      const loaded = loadConfig();

      expect(loaded).toBeDefined();
      expect(loaded?.projectName).toBe('Default Project');
      expect(loaded?.prefix).toBe('DEF');
      expect(loaded?.autoExport).toBe(true);
    });

    it('should merge user config over defaults', () => {
      const configDir = getConfigDir();
      fs.mkdirSync(configDir, { recursive: true });
      
      // Create defaults
      fs.writeFileSync(
        getConfigDefaultsPath(), 
        [
          'projectName: Default Project',
          'prefix: DEF',
          'statuses:',
          '  - value: open',
          '    label: Open',
          '  - value: in-progress',
          '    label: In Progress',
          '  - value: blocked',
          '    label: Blocked',
          '  - value: completed',
          '    label: Completed',
          '  - value: deleted',
          '    label: Deleted',
          'stages:',
          '  - value: ""',
          '    label: Undefined',
          '  - value: idea',
          '    label: Idea',
          '  - value: prd_complete',
          '    label: PRD Complete',
          '  - value: plan_complete',
          '    label: Plan Complete',
          '  - value: in_progress',
          '    label: In Progress',
          '  - value: in_review',
          '    label: In Review',
          '  - value: done',
          '    label: Done',
          'statusStageCompatibility:',
          '  open: ["", idea, prd_complete, plan_complete, in_progress]',
          '  in-progress: [in_progress]',
          '  blocked: ["", idea, prd_complete, plan_complete, in_progress]',
          '  completed: [in_review, done]',
          '  deleted: [""]'
        ].join('\n'),
        'utf-8'
      );

      // Create user config that overrides prefix
      fs.writeFileSync(
        getConfigPath(), 
        [
          'prefix: USER',
          'statuses:',
          '  - value: open',
          '    label: Open',
          '  - value: in-progress',
          '    label: In Progress',
          '  - value: blocked',
          '    label: Blocked',
          '  - value: completed',
          '    label: Completed',
          '  - value: deleted',
          '    label: Deleted',
          'stages:',
          '  - value: ""',
          '    label: Undefined',
          '  - value: idea',
          '    label: Idea',
          '  - value: prd_complete',
          '    label: PRD Complete',
          '  - value: plan_complete',
          '    label: Plan Complete',
          '  - value: in_progress',
          '    label: In Progress',
          '  - value: in_review',
          '    label: In Review',
          '  - value: done',
          '    label: Done',
          'statusStageCompatibility:',
          '  open: ["", idea, prd_complete, plan_complete, in_progress]',
          '  in-progress: [in_progress]',
          '  blocked: ["", idea, prd_complete, plan_complete, in_progress]',
          '  completed: [in_review, done]',
          '  deleted: [""]'
        ].join('\n'),
        'utf-8'
      );

      const loaded = loadConfig();

      expect(loaded).toBeDefined();
      expect(loaded?.projectName).toBe('Default Project'); // From defaults
      expect(loaded?.prefix).toBe('USER'); // Overridden by user config
    });

    it('should allow user config to override autoExport from defaults', () => {
      const configDir = getConfigDir();
      fs.mkdirSync(configDir, { recursive: true });
      
      // Create defaults with autoExport: true
      fs.writeFileSync(
        getConfigDefaultsPath(), 
        [
          'projectName: Default Project',
          'prefix: DEF',
          'autoExport: true',
          'statuses:',
          '  - value: open',
          '    label: Open',
          '  - value: in-progress',
          '    label: In Progress',
          '  - value: blocked',
          '    label: Blocked',
          '  - value: completed',
          '    label: Completed',
          '  - value: deleted',
          '    label: Deleted',
          'stages:',
          '  - value: ""',
          '    label: Undefined',
          '  - value: idea',
          '    label: Idea',
          '  - value: prd_complete',
          '    label: PRD Complete',
          '  - value: plan_complete',
          '    label: Plan Complete',
          '  - value: in_progress',
          '    label: In Progress',
          '  - value: in_review',
          '    label: In Review',
          '  - value: done',
          '    label: Done',
          'statusStageCompatibility:',
          '  open: ["", idea, prd_complete, plan_complete, in_progress]',
          '  in-progress: [in_progress]',
          '  blocked: ["", idea, prd_complete, plan_complete, in_progress]',
          '  completed: [in_review, done]',
          '  deleted: [""]'
        ].join('\n'),
        'utf-8'
      );

      // Create user config that disables autoExport
      fs.writeFileSync(
        getConfigPath(), 
        [
          'autoExport: false',
          'statuses:',
          '  - value: open',
          '    label: Open',
          '  - value: in-progress',
          '    label: In Progress',
          '  - value: blocked',
          '    label: Blocked',
          '  - value: completed',
          '    label: Completed',
          '  - value: deleted',
          '    label: Deleted',
          'stages:',
          '  - value: ""',
          '    label: Undefined',
          '  - value: idea',
          '    label: Idea',
          '  - value: prd_complete',
          '    label: PRD Complete',
          '  - value: plan_complete',
          '    label: Plan Complete',
          '  - value: in_progress',
          '    label: In Progress',
          '  - value: in_review',
          '    label: In Review',
          '  - value: done',
          '    label: Done',
          'statusStageCompatibility:',
          '  open: ["", idea, prd_complete, plan_complete, in_progress]',
          '  in-progress: [in_progress]',
          '  blocked: ["", idea, prd_complete, plan_complete, in_progress]',
          '  completed: [in_review, done]',
          '  deleted: [""]'
        ].join('\n'),
        'utf-8'
      );

      const loaded = loadConfig();

      expect(loaded).toBeDefined();
      expect(loaded?.projectName).toBe('Default Project'); // From defaults
      expect(loaded?.prefix).toBe('DEF'); // From defaults
      expect(loaded?.autoExport).toBe(false); // Overridden by user config
    });

    it('should validate that projectName is a string', () => {
      const configDir = getConfigDir();
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        getConfigPath(), 
        [
          'projectName: 123',
          'prefix: TEST',
          'statuses:',
          '  - value: open',
          '    label: Open',
          '  - value: in-progress',
          '    label: In Progress',
          '  - value: blocked',
          '    label: Blocked',
          '  - value: completed',
          '    label: Completed',
          '  - value: deleted',
          '    label: Deleted',
          'stages:',
          '  - value: ""',
          '    label: Undefined',
          '  - value: idea',
          '    label: Idea',
          '  - value: prd_complete',
          '    label: PRD Complete',
          '  - value: plan_complete',
          '    label: Plan Complete',
          '  - value: in_progress',
          '    label: In Progress',
          '  - value: in_review',
          '    label: In Review',
          '  - value: done',
          '    label: Done',
          'statusStageCompatibility:',
          '  open: ["", idea, prd_complete, plan_complete, in_progress]',
          '  in-progress: [in_progress]',
          '  blocked: ["", idea, prd_complete, plan_complete, in_progress]',
          '  completed: [in_review, done]',
          '  deleted: [""]'
        ].join('\n'),
        'utf-8'
      );

      const loaded = loadConfig();

      // Should return null for invalid config
      expect(loaded).toBe(null);
    });

    it('should validate that prefix is a string', () => {
      const configDir = getConfigDir();
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        getConfigPath(), 
        [
          'projectName: Test',
          'prefix: 123',
          'statuses:',
          '  - value: open',
          '    label: Open',
          '  - value: in-progress',
          '    label: In Progress',
          '  - value: blocked',
          '    label: Blocked',
          '  - value: completed',
          '    label: Completed',
          '  - value: deleted',
          '    label: Deleted',
          'stages:',
          '  - value: ""',
          '    label: Undefined',
          '  - value: idea',
          '    label: Idea',
          '  - value: prd_complete',
          '    label: PRD Complete',
          '  - value: plan_complete',
          '    label: Plan Complete',
          '  - value: in_progress',
          '    label: In Progress',
          '  - value: in_review',
          '    label: In Review',
          '  - value: done',
          '    label: Done',
          'statusStageCompatibility:',
          '  open: ["", idea, prd_complete, plan_complete, in_progress]',
          '  in-progress: [in_progress]',
          '  blocked: ["", idea, prd_complete, plan_complete, in_progress]',
          '  completed: [in_review, done]',
          '  deleted: [""]'
        ].join('\n'),
        'utf-8'
      );

      const loaded = loadConfig();

      // Should return null for invalid config
      expect(loaded).toBe(null);
    });
  });

  describe('getDefaultPrefix', () => {
    it('should return WI when no config exists', () => {
      const prefix = getDefaultPrefix();
      expect(prefix).toBe('WI');
    });

    it('should return prefix from config when it exists', () => {
      saveConfig({
        projectName: 'Test Project',
        prefix: 'CUSTOM',
        statuses: [
          { value: 'open', label: 'Open' },
          { value: 'in-progress', label: 'In Progress' },
          { value: 'blocked', label: 'Blocked' },
          { value: 'completed', label: 'Completed' },
          { value: 'deleted', label: 'Deleted' }
        ],
        stages: [
          { value: '', label: 'Undefined' },
          { value: 'idea', label: 'Idea' },
          { value: 'prd_complete', label: 'PRD Complete' },
          { value: 'plan_complete', label: 'Plan Complete' },
          { value: 'in_progress', label: 'In Progress' },
          { value: 'in_review', label: 'In Review' },
          { value: 'done', label: 'Done' }
        ],
        statusStageCompatibility: {
          open: ['', 'idea', 'prd_complete', 'plan_complete', 'in_progress'],
          'in-progress': ['in_progress'],
          blocked: ['', 'idea', 'prd_complete', 'plan_complete', 'in_progress'],
          completed: ['in_review', 'done'],
          deleted: ['']
        }
      });

      const prefix = getDefaultPrefix();
      expect(prefix).toBe('CUSTOM');
    });

    it('should return prefix from defaults when only defaults exist', () => {
      const configDir = getConfigDir();
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        getConfigDefaultsPath(), 
        [
          'projectName: Default',
          'prefix: DEF',
          'statuses:',
          '  - value: open',
          '    label: Open',
          '  - value: in-progress',
          '    label: In Progress',
          '  - value: blocked',
          '    label: Blocked',
          '  - value: completed',
          '    label: Completed',
          '  - value: deleted',
          '    label: Deleted',
          'stages:',
          '  - value: ""',
          '    label: Undefined',
          '  - value: idea',
          '    label: Idea',
          '  - value: prd_complete',
          '    label: PRD Complete',
          '  - value: plan_complete',
          '    label: Plan Complete',
          '  - value: in_progress',
          '    label: In Progress',
          '  - value: in_review',
          '    label: In Review',
          '  - value: done',
          '    label: Done',
          'statusStageCompatibility:',
          '  open: ["", idea, prd_complete, plan_complete, in_progress]',
          '  in-progress: [in_progress]',
          '  blocked: ["", idea, prd_complete, plan_complete, in_progress]',
          '  completed: [in_review, done]',
          '  deleted: [""]'
        ].join('\n'),
        'utf-8'
      );

      const prefix = getDefaultPrefix();
      expect(prefix).toBe('DEF');
    });
  });
});
