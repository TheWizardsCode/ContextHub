import { loadConfig } from './config.js';
import type { WorklogConfig } from './types.js';

export type StatusStageEntry = { value: string; label: string };

export type StatusStageRules = {
  statuses: StatusStageEntry[];
  stages: StatusStageEntry[];
  statusStageCompatibility: Record<string, readonly string[]>;
  stageStatusCompatibility: Record<string, readonly string[]>;
  statusLabels: Record<string, string>;
  stageLabels: Record<string, string>;
  statusValues: string[];
  stageValues: string[];
  statusValuesByLabel: Record<string, string>;
  stageValuesByLabel: Record<string, string>;
};

const buildLabelMaps = (entries: StatusStageEntry[]) => {
  const labelsByValue: Record<string, string> = {};
  const valuesByLabel: Record<string, string> = {};
  for (const entry of entries) {
    labelsByValue[entry.value] = entry.label;
    valuesByLabel[entry.label] = entry.value;
  }
  return { labelsByValue, valuesByLabel };
};

export const normalizeStatusValue = (value?: string): string | undefined => {
  if (value === undefined || value === null) return value;
  return value.replace(/_/g, '-');
};

export const normalizeStageValue = (value?: string): string | undefined => {
  if (value === undefined || value === null) return value;
  return value.replace(/-/g, '_');
};

export function deriveStageStatusCompatibility(
  statusStage: Record<string, readonly string[]>,
  stages: readonly string[]
): Record<string, string[]> {
  const stageStatus: Record<string, string[]> = Object.fromEntries(
    stages.map(stage => [stage, [] as string[]])
  );

  for (const [status, allowedStages] of Object.entries(statusStage)) {
    for (const stage of allowedStages) {
      if (!(stage in stageStatus)) {
        stageStatus[stage] = [];
      }
      stageStatus[stage].push(status);
    }
  }

  return stageStatus;
}

export function createStatusStageRules(
  config: Pick<WorklogConfig, 'statuses' | 'stages' | 'statusStageCompatibility'>
): StatusStageRules {
  if (!config.statuses || !config.stages || !config.statusStageCompatibility) {
    throw new Error('Missing required status/stage config sections.');
  }

  const statuses = config.statuses;
  const stages = config.stages;
  // Make a shallow copy so we can safely use it without mutating input
  const statusStageCompatibility: Record<string, readonly string[]> = { ...config.statusStageCompatibility };
  const statusValues = statuses.map(entry => entry.value);
  const stageValues = stages.map(entry => entry.value);

  const stageStatusCompatibility = deriveStageStatusCompatibility(statusStageCompatibility, stageValues);

  const { labelsByValue: statusLabels, valuesByLabel: statusValuesByLabel } = buildLabelMaps(statuses);
  const { labelsByValue: stageLabels, valuesByLabel: stageValuesByLabel } = buildLabelMaps(stages);

  return {
    statuses,
    stages,
    statusStageCompatibility,
    stageStatusCompatibility,
    statusLabels,
    stageLabels,
    statusValues,
    stageValues,
    statusValuesByLabel,
    stageValuesByLabel,
  };
}

export function loadStatusStageRules(config?: WorklogConfig | null): StatusStageRules {
  const resolvedConfig = config ?? loadConfig();
  if (!resolvedConfig) {
    throw new Error('Status/stage rules require a valid config.');
  }
  return createStatusStageRules(resolvedConfig);
}

export const getStatusLabel = (value: string | undefined, rules: StatusStageRules): string => {
  if (value === undefined || value === null) return '';
  const normalized = normalizeStatusValue(value) ?? value;
  return rules.statusLabels[normalized] ?? rules.statusLabels[value] ?? value;
};

export const getStageLabel = (value: string | undefined, rules: StatusStageRules): string => {
  if (value === undefined || value === null) return '';
  const normalized = normalizeStageValue(value) ?? value;
  return rules.stageLabels[normalized] ?? rules.stageLabels[value] ?? value;
};

export const getStatusValueFromLabel = (
  label: string | undefined,
  rules: StatusStageRules
): string | undefined => {
  if (label === undefined || label === null) return undefined;
  const trimmed = label.trim();
  if (trimmed in rules.statusValuesByLabel) return rules.statusValuesByLabel[trimmed];
  const normalized = normalizeStatusValue(trimmed) ?? trimmed;
  if (rules.statusValues.includes(normalized)) return normalized;
  if (rules.statusValues.includes(trimmed)) return trimmed;
  return undefined;
};

export const getStageValueFromLabel = (
  label: string | undefined,
  rules: StatusStageRules
): string | undefined => {
  if (label === undefined || label === null) return undefined;
  const trimmed = label.trim();
  if (trimmed in rules.stageValuesByLabel) return rules.stageValuesByLabel[trimmed];
  const normalized = normalizeStageValue(trimmed) ?? trimmed;
  if (rules.stageValues.includes(normalized)) return normalized;
  if (rules.stageValues.includes(trimmed)) return trimmed;
  return undefined;
};
