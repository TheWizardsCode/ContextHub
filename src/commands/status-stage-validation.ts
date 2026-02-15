import type { WorklogConfig } from '../types.js';
import type { StatusStageRules } from '../status-stage-rules.js';
import { loadStatusStageRules, normalizeStageValue, normalizeStatusValue } from '../status-stage-rules.js';
import { getAllowedStagesForStatus, getAllowedStatusesForStage, isStatusStageCompatible } from '../tui/status-stage-validation.js';

type Resolution = {
  value: string;
  normalized: string;
  isValid: boolean;
  isNormalizedValid: boolean;
  canonical: string;
};

type ValidationResult = {
  status: string;
  stage: string;
  warnings: string[];
  rules: StatusStageRules;
};

const formatOptions = (values: readonly string[]): string =>
  values
    .map(value => (value === '' ? '""' : value))
    .join(', ');

const resolveStatus = (value: string, rules: StatusStageRules): Resolution => {
  const normalized = normalizeStatusValue(value) ?? value;
  const isValid = rules.statusValues.includes(value);
  const isNormalizedValid = !isValid && normalized !== value && rules.statusValues.includes(normalized);
  return {
    value,
    normalized,
    isValid,
    isNormalizedValid,
    canonical: isValid ? value : isNormalizedValid ? normalized : value,
  };
};

const resolveStage = (value: string, rules: StatusStageRules): Resolution => {
  const normalized = normalizeStageValue(value) ?? value;
  const isValid = rules.stageValues.includes(value);
  const isNormalizedValid = !isValid && normalized !== value && rules.stageValues.includes(normalized);
  return {
    value,
    normalized,
    isValid,
    isNormalizedValid,
    canonical: isValid ? value : isNormalizedValid ? normalized : value,
  };
};

const warnNormalization = (label: 'status' | 'stage', from: string, to: string): string =>
  `Warning: normalized ${label} "${from}" to "${to}".`;

const validateStatusValue = (value: string, rules: StatusStageRules, warnings: string[]): string => {
  const resolved = resolveStatus(value, rules);
  if (!resolved.isValid && resolved.isNormalizedValid) {
    warnings.push(warnNormalization('status', resolved.value, resolved.normalized));
    return resolved.normalized;
  }
  if (!resolved.isValid && !resolved.isNormalizedValid) {
    throw new Error(`Invalid status "${value}". Valid statuses: ${formatOptions(rules.statusValues)}.`);
  }
  return resolved.canonical;
};

const validateStageValue = (value: string, rules: StatusStageRules, warnings: string[]): string => {
  // Empty stage is always valid (means "no stage set")
  if (value === '') return '';
  const resolved = resolveStage(value, rules);
  if (!resolved.isValid && resolved.isNormalizedValid) {
    warnings.push(warnNormalization('stage', resolved.value, resolved.normalized));
    return resolved.normalized;
  }
  if (!resolved.isValid && !resolved.isNormalizedValid) {
    throw new Error(`Invalid stage "${value}". Valid stages: ${formatOptions(rules.stageValues)}.`);
  }
  return resolved.canonical;
};

export const validateStatusStageInput = (
  input: { status?: string; stage?: string },
  config?: WorklogConfig | null
): ValidationResult => {
  const rules = loadStatusStageRules(config);
  const warnings: string[] = [];

  const status = input.status !== undefined
    ? validateStatusValue(input.status, rules, warnings)
    : '';
  const stage = input.stage !== undefined
    ? validateStageValue(input.stage, rules, warnings)
    : '';

  return { status, stage, warnings, rules };
};

export const canValidateStatusStage = (config?: WorklogConfig | null): boolean => {
  const statusesValid = Array.isArray(config?.statuses) && config?.statuses.length > 0;
  const stagesValid = Array.isArray(config?.stages) && config?.stages.length > 0;
  const compatibilityValid = !!config?.statusStageCompatibility;
  return statusesValid && stagesValid && compatibilityValid;
};

export const validateStatusStageCompatibility = (
  status: string,
  stage: string,
  rules: StatusStageRules
): void => {
  // Empty stage means "no stage set" and is always compatible
  if (stage === '') return;
  const validationRules = {
    statusStage: rules.statusStageCompatibility,
    stageStatus: rules.stageStatusCompatibility,
  };

  if (!isStatusStageCompatible(status, stage, validationRules)) {
    const allowedStages = getAllowedStagesForStatus(status, validationRules);
    const allowedStatuses = getAllowedStatusesForStage(stage, validationRules);
    const allowedStagesText = formatOptions(allowedStages);
    const allowedStatusesText = formatOptions(allowedStatuses);
    throw new Error(
      `Invalid status/stage combination: status "${status}" is not compatible with stage "${stage}". ` +
      `Allowed stages for status "${status}": ${allowedStagesText}. ` +
      `Allowed statuses for stage "${stage}": ${allowedStatusesText}.`
    );
  }
};
