/**
 * init options — CLI option normalisation for `wl init`.
 *
 * Single responsibility: validate and normalise the user-supplied `wl init`
 * options (project name, ID prefix, boolean flags, AGENTS.md action) into the
 * internal shape the init flow consumes.
 */

import type { InitOptions } from '../cli-types.js';

export type AgentTemplateAction = 'overwrite' | 'append' | 'skip';

export type NormalizedInitOptions = {
  projectName?: string;
  prefix?: string;
  autoSync?: boolean;
  agentsTemplateAction?: AgentTemplateAction;
  workflowInline?: boolean;
  statsPluginOverwrite: boolean;
};

export function normalizeBooleanOption(value: string | undefined, flagName: string): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['y', 'yes', 'true', '1'].includes(normalized)) return true;
  if (['n', 'no', 'false', '0'].includes(normalized)) return false;
  throw new Error(`Invalid value for ${flagName}. Use yes or no.`);
}

export function normalizeAgentTemplateAction(value?: string): AgentTemplateAction | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'overwrite' || normalized === 'o') return 'overwrite';
  if (normalized === 'append' || normalized === 'a') return 'append';
  if (normalized === 'skip' || normalized === 'm' || normalized === 'manual' || normalized === 'manage') return 'skip';
  throw new Error('Invalid value for --agents-template. Use overwrite, append, or skip.');
}

export function normalizeInitOptions(options: InitOptions): NormalizedInitOptions {
  const projectName = options.projectName?.trim();
  if (options.projectName !== undefined && (!projectName || projectName === '')) {
    throw new Error('Project name is required when --project-name is provided.');
  }

  const prefix = options.prefix?.trim();
  if (options.prefix !== undefined && (!prefix || prefix === '')) {
    throw new Error('Issue ID prefix is required when --prefix is provided.');
  }

  return {
    projectName,
    prefix,
    autoSync: normalizeBooleanOption(options.autoSync, '--auto-sync'),
    agentsTemplateAction: normalizeAgentTemplateAction(options.agentsTemplate),
    workflowInline: normalizeBooleanOption(options.workflowInline, '--workflow-inline'),
    statsPluginOverwrite: normalizeBooleanOption(options.statsPluginOverwrite, '--stats-plugin-overwrite') ?? false,
  };
}
