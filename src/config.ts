/**
 * Configuration management for Worklog projects
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { WorklogConfig } from './types.js';
import * as readline from 'readline';
import { resolveWorklogDir } from './worklog-paths.js';
import chalk from 'chalk';

const CONFIG_DIR = '.worklog';
const CONFIG_FILE = 'config.yaml';
const CONFIG_DEFAULTS_FILE = 'config.defaults.yaml';
const INIT_SEMAPHORE_FILE = 'initialized';

/**
 * Get the path to the config directory
 */
export function getConfigDir(): string {
  return resolveWorklogDir();
}

/**
 * Get the path to the config file
 */
export function getConfigPath(): string {
  return path.join(getConfigDir(), CONFIG_FILE);
}

/**
 * Get the path to the config defaults file
 */
export function getConfigDefaultsPath(): string {
  return path.join(getConfigDir(), CONFIG_DEFAULTS_FILE);
}

/**
 * Get the path to the initialization semaphore file
 */
export function getInitSemaphorePath(): string {
  return path.join(getConfigDir(), INIT_SEMAPHORE_FILE);
}

/**
 * Check if config file exists
 */
export function configExists(): boolean {
  return fs.existsSync(getConfigPath());
}

/**
 * Check if the system has been initialized
 */
export function isInitialized(): boolean {
  return fs.existsSync(getInitSemaphorePath());
}

/**
 * Write initialization semaphore file with version information
 */
export function writeInitSemaphore(version: string): void {
  const configDir = getConfigDir();
  
  // Ensure directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const initData = {
    version,
    initializedAt: new Date().toISOString()
  };
  
  fs.writeFileSync(getInitSemaphorePath(), JSON.stringify(initData, null, 2), 'utf-8');
}

/**
 * Read initialization information from semaphore file
 */
export function readInitSemaphore(): { version: string; initializedAt: string } | null {
  const semaphorePath = getInitSemaphorePath();
  
  if (!fs.existsSync(semaphorePath)) {
    return null;
  }
  
  try {
    const content = fs.readFileSync(semaphorePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Error reading initialization semaphore:', error);
    return null;
  }
}

/**
 * Load configuration from file
 */
export function loadConfig(): WorklogConfig | null {
  let config: WorklogConfig | null = null;
  
  // First, load defaults if they exist
  const defaultsPath = getConfigDefaultsPath();
  if (fs.existsSync(defaultsPath)) {
    try {
      const content = fs.readFileSync(defaultsPath, 'utf-8');
      config = yaml.load(content, { schema: yaml.CORE_SCHEMA }) as WorklogConfig;
    } catch (error) {
      console.error('Error loading config defaults:', error);
      console.error('Continuing without defaults...');
    }
  }
  
  // Then, load user config and merge with defaults
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const userConfig = yaml.load(content, { schema: yaml.CORE_SCHEMA }) as WorklogConfig;
      
      // Merge user config over defaults
      config = config ? { ...config, ...userConfig } : userConfig;
    } catch (error) {
      console.error('Error loading config:', error);
      return null;
    }
  }
  
  // If no config was loaded at all, return null
  if (!config) {
    return null;
  }
  
  // Validate config structure
  if (!config || typeof config !== 'object') {
    console.error('Invalid config: must be an object');
    return null;
  }
  
  if (!config.projectName || typeof config.projectName !== 'string') {
    console.error('Invalid config: projectName must be a string');
    return null;
  }
  
  if (!config.prefix || typeof config.prefix !== 'string') {
    console.error('Invalid config: prefix must be a string');
    return null;
  }

  // Apply built-in defaults for statuses/stages when not provided by config
  // or config.defaults.yaml (supports projects created before this feature).
  if (!config.statuses) {
    config.statuses = [
      { value: 'open', label: 'Open' },
      { value: 'in-progress', label: 'In Progress' },
      { value: 'blocked', label: 'Blocked' },
      { value: 'completed', label: 'Completed' },
      { value: 'deleted', label: 'Deleted' },
    ];
  }
  if (!config.stages) {
    config.stages = [
      { value: 'idea', label: 'Idea' },
      { value: 'intake_complete', label: 'Intake Complete' },
      { value: 'plan_complete', label: 'Plan Complete' },
      { value: 'in_progress', label: 'In Progress' },
      { value: 'in_review', label: 'In Review' },
      { value: 'done', label: 'Done' },
    ];
  }
  if (!config.statusStageCompatibility) {
    config.statusStageCompatibility = {
      'open': ['idea', 'intake_complete', 'plan_complete', 'in_progress'],
      'in-progress': ['in_progress'],
      'blocked': ['idea', 'intake_complete', 'plan_complete'],
      'completed': ['in_review', 'done'],
      'deleted': ['idea', 'intake_complete', 'plan_complete', 'done'],
    };
  }

  const statusStageError = validateStatusStageConfig(config);
  if (statusStageError) {
    console.error(statusStageError);
    return null;
  }
  
  return config;
}

/**
 * Load configuration without enforcing status/stage sections.
 * Useful for CLI paths that only need core fields like prefix.
 */
export function loadConfigRelaxed(): WorklogConfig | null {
  let config: WorklogConfig | null = null;

  // First, load defaults if they exist
  const defaultsPath = getConfigDefaultsPath();
  if (fs.existsSync(defaultsPath)) {
    try {
      const content = fs.readFileSync(defaultsPath, 'utf-8');
      config = yaml.load(content, { schema: yaml.CORE_SCHEMA }) as WorklogConfig;
    } catch (error) {
      console.error('Error loading config defaults:', error);
      console.error('Continuing without defaults...');
    }
  }

  // Then, load user config and merge with defaults
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const userConfig = yaml.load(content, { schema: yaml.CORE_SCHEMA }) as WorklogConfig;

      // Merge user config over defaults
      config = config ? { ...config, ...userConfig } : userConfig;
    } catch (error) {
      console.error('Error loading config:', error);
      return null;
    }
  }

  if (!config) {
    return null;
  }

  if (!config || typeof config !== 'object') {
    console.error('Invalid config: must be an object');
    return null;
  }

  if (!config.projectName || typeof config.projectName !== 'string') {
    console.error('Invalid config: projectName must be a string');
    return null;
  }

  if (!config.prefix || typeof config.prefix !== 'string') {
    console.error('Invalid config: prefix must be a string');
    return null;
  }

  return config;
}

function validateStatusStageConfig(config: WorklogConfig): string | null {
  const statuses = config.statuses;
  if (!Array.isArray(statuses) || statuses.length === 0) {
    return 'Invalid config: statuses must be a non-empty array of { value, label } entries';
  }

  const statusValues = new Set<string>();
  for (const entry of statuses) {
    if (!entry || typeof entry !== 'object') {
      return 'Invalid config: statuses must be objects with value and label fields';
    }
    const value = (entry as { value?: unknown }).value;
    const label = (entry as { label?: unknown }).label;
    if (typeof value !== 'string' || value.trim() === '') {
      return 'Invalid config: statuses values must be non-empty strings';
    }
    if (typeof label !== 'string' || label.trim() === '') {
      return 'Invalid config: statuses labels must be non-empty strings';
    }
    statusValues.add(value);
  }

  const stages = config.stages;
  if (!Array.isArray(stages) || stages.length === 0) {
    return 'Invalid config: stages must be a non-empty array of { value, label } entries';
  }

  const stageValues = new Set<string>();
  for (const entry of stages) {
    if (!entry || typeof entry !== 'object') {
      return 'Invalid config: stages must be objects with value and label fields';
    }
    const value = (entry as { value?: unknown }).value;
    const label = (entry as { label?: unknown }).label;
    if (typeof value !== 'string') {
      return 'Invalid config: stages values must be strings (empty string allowed)';
    }
    if (typeof label !== 'string' || label.trim() === '') {
      return 'Invalid config: stages labels must be non-empty strings';
    }
    stageValues.add(value);
  }

  const compatibility = config.statusStageCompatibility;
  if (!compatibility || typeof compatibility !== 'object' || Array.isArray(compatibility)) {
    return 'Invalid config: statusStageCompatibility must be an object mapping status to allowed stages';
  }

  const compatibilityEntries = Object.entries(compatibility);
  if (compatibilityEntries.length === 0) {
    return 'Invalid config: statusStageCompatibility must not be empty';
  }

  for (const status of statusValues) {
    if (!(status in compatibility)) {
      return `Invalid config: statusStageCompatibility missing entry for status "${status}"`;
    }
  }

  for (const [status, allowedStages] of compatibilityEntries) {
    if (!Array.isArray(allowedStages) || allowedStages.length === 0) {
      return `Invalid config: statusStageCompatibility for status "${status}" must be a non-empty array`; 
    }
    for (const stage of allowedStages) {
      if (typeof stage !== 'string') {
        return `Invalid config: statusStageCompatibility for status "${status}" must contain stage strings`;
      }
      if (!stageValues.has(stage)) {
        return `Invalid config: statusStageCompatibility for status "${status}" references unknown stage "${stage}"`;
      }
    }
  }

  return null;
}

/**
 * Save configuration to file
 */
export function saveConfig(config: WorklogConfig): void {
  const configDir = getConfigDir();
  
  // Ensure directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const content = yaml.dump(config);
  fs.writeFileSync(getConfigPath(), content, 'utf-8');
}

/**
 * Get the default prefix (WI if no config exists)
 */
export function getDefaultPrefix(): string {
  const config = loadConfig();
  return config?.prefix || 'WI';
}

/**
 * Prompt user for input
 */
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function printHeading(title: string): void {
  console.log(chalk.blue(`## ${title}`));
  console.log();
}

export type InitConfigOptions = {
  projectName?: string;
  prefix?: string;
  autoExport?: boolean;
  autoSync?: boolean;
};

/**
 * Interactive initialization of config
 */
export async function initConfig(existingConfig?: WorklogConfig | null, options?: InitConfigOptions): Promise<WorklogConfig> {
  if (existingConfig) {
    printHeading('Current Configuration');
    console.log(`  Project: ${existingConfig.projectName}`);
    console.log(`  Prefix: ${existingConfig.prefix}`);
    console.log(`  Auto-export: ${existingConfig.autoExport !== false ? 'enabled' : 'disabled'}`);
    console.log(`  Auto-sync: ${existingConfig.autoSync ? 'enabled' : 'disabled'}\n`);
    if (existingConfig.syncRemote || existingConfig.syncBranch) {
      console.log(`  Sync remote: ${existingConfig.syncRemote || '(default)'}`);
      console.log(`  Sync branch: ${existingConfig.syncBranch || '(default)'}\n`);
    }
    if (existingConfig.githubRepo || existingConfig.githubLabelPrefix || existingConfig.githubImportCreateNew !== undefined) {
      console.log(`  GitHub repo: ${existingConfig.githubRepo || '(not set)'}`);
      console.log(`  GitHub label prefix: ${existingConfig.githubLabelPrefix || '(default)'}`);
      console.log(`  GitHub import create: ${existingConfig.githubImportCreateNew !== false ? 'enabled' : 'disabled'}\n`);
    }

    const hasExplicitOptions = Boolean(
      options?.projectName !== undefined ||
      options?.prefix !== undefined ||
      options?.autoExport !== undefined ||
      options?.autoSync !== undefined
    );

    if (!hasExplicitOptions) {
      const shouldChange = await prompt('Do you want to change these settings? (y/N): ');
      
      if (shouldChange.toLowerCase() !== 'y' && shouldChange.toLowerCase() !== 'yes') {
        console.log(chalk.gray('\nKeeping existing configuration.'));
        return existingConfig;
      }
    }

    printHeading('Update Configuration');
    console.log('\nEnter new values (press Enter to keep current value):\n');

  } else {
    printHeading('Initialize Configuration');
  }

  const projectNamePrompt = existingConfig
    ? `Project name (${existingConfig.projectName}): `
    : 'Project name: ';

  // Ensure a non-empty project name is provided. If an existing config
  // is present the user may press Enter to keep it. Otherwise keep prompting
  // until a non-empty value is entered.
  let projectName: string | undefined = options?.projectName || existingConfig?.projectName;
  if (options?.projectName !== undefined && (!projectName || projectName.trim() === '')) {
    throw new Error('Project name is required. Please enter a non-empty project name.');
  }
  while (!projectName || projectName.trim() === '') {
    const projectNameInput = await prompt(projectNamePrompt);
    projectName = projectNameInput || existingConfig?.projectName;
    if (!projectName || projectName.trim() === '') {
      console.log('Project name is required. Please enter a non-empty project name.');
    }
  }
  projectName = projectName.trim();

  const prefixPrompt = existingConfig
    ? `Issue ID prefix (${existingConfig.prefix}): `
    : 'Issue ID prefix (e.g., WI, PROJ, TASK): ';

  // Ensure a non-empty prefix is provided. Allow pressing Enter to keep
  // an existing value; otherwise require a valid non-empty value.
  let prefix: string | undefined = options?.prefix || existingConfig?.prefix;
  if (options?.prefix !== undefined && (!prefix || prefix.trim() === '')) {
    throw new Error('Issue ID prefix is required. Please enter a non-empty prefix.');
  }
  while (!prefix || prefix.trim() === '') {
    const prefixInput = await prompt(prefixPrompt);
    prefix = prefixInput || existingConfig?.prefix;
    if (!prefix || prefix.trim() === '') {
      console.log('Issue ID prefix is required. Please enter a non-empty prefix.');
    }
  }
  prefix = prefix.trim();

  // Prompt for auto-export setting
  const currentAutoExport = existingConfig?.autoExport !== false ? 'Y' : 'n';
  const autoExportPrompt = existingConfig
    ? `Auto-export data to JSONL after changes? (Y/n) [${currentAutoExport}]: `
    : 'Auto-export data to JSONL after changes? (Y/n) [Y]: ';
  let autoExport: boolean;
  if (options?.autoExport !== undefined) {
    autoExport = options.autoExport;
  } else {
    const autoExportInput = await prompt(autoExportPrompt);
    if (autoExportInput.trim() === '') {
      // Use default or existing value
      autoExport = existingConfig?.autoExport !== false;
    } else {
      autoExport = autoExportInput.toLowerCase() !== 'n' && autoExportInput.toLowerCase() !== 'no';
    }
  }

  const currentAutoSync = existingConfig?.autoSync === true ? 'Y' : 'n';
  const autoSyncPrompt = existingConfig
    ? `Auto-sync data to git after changes? (y/N) [${currentAutoSync}]: `
    : 'Auto-sync data to git after changes? (y/N) [n]: ';
  let autoSync = false;
  if (options?.autoSync !== undefined) {
    autoSync = options.autoSync;
  } else {
    const autoSyncInput = await prompt(autoSyncPrompt);
    if (autoSyncInput.trim() === '') {
      autoSync = existingConfig?.autoSync === true;
    } else {
      autoSync = autoSyncInput.toLowerCase() === 'y' || autoSyncInput.toLowerCase() === 'yes';
    }
  }

  if (!projectName || !prefix) {
    // Defensive check - loops above should prevent this from ever firing
    throw new Error('Project name and prefix are required');
  }

  // Validate prefix (alphanumeric only)
  if (!/^[A-Z0-9]+$/i.test(prefix)) {
    throw new Error('Prefix must contain only alphanumeric characters');
  }

  const config: WorklogConfig = {
    projectName,
    prefix: prefix.toUpperCase(),
    autoExport,
    autoSync,
  };

  if (existingConfig?.syncRemote) {
    config.syncRemote = existingConfig.syncRemote;
  }
  if (existingConfig?.syncBranch) {
    config.syncBranch = existingConfig.syncBranch;
  }
  if (existingConfig?.githubRepo) {
    config.githubRepo = existingConfig.githubRepo;
  }
  if (existingConfig?.githubLabelPrefix) {
    config.githubLabelPrefix = existingConfig.githubLabelPrefix;
  }
  if (existingConfig?.githubImportCreateNew !== undefined) {
    config.githubImportCreateNew = existingConfig.githubImportCreateNew;
  }

  saveConfig(config);
  printHeading('Saved Configuration');
  console.log(`\nSaved to: ${getConfigPath()}`);
  console.log(`Project:  ${config.projectName}`);
  console.log(`Prefix:   ${config.prefix}`);
  console.log(`Export:   ${config.autoExport ? 'enabled' : 'disabled'}`);
  console.log(`Sync:     ${config.autoSync ? 'enabled' : 'disabled'}`);

  return config;
}
