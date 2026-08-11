import { loadConfig } from './config.js';
const buildLabelMaps = (entries) => {
    const labelsByValue = {};
    const valuesByLabel = {};
    for (const entry of entries) {
        labelsByValue[entry.value] = entry.label;
        valuesByLabel[entry.label] = entry.value;
    }
    return { labelsByValue, valuesByLabel };
};
export const normalizeStatusValue = (value) => {
    if (value === undefined || value === null)
        return value;
    return value.replace(/_/g, '-');
};
export const normalizeStageValue = (value) => {
    if (value === undefined || value === null)
        return value;
    return value.replace(/-/g, '_');
};
export function deriveStageStatusCompatibility(statusStage, stages) {
    const stageStatus = Object.fromEntries(stages.map(stage => [stage, []]));
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
export function createStatusStageRules(config) {
    if (!config.statuses || !config.stages || !config.statusStageCompatibility) {
        throw new Error('Missing required status/stage config sections.');
    }
    const statuses = config.statuses;
    const stages = config.stages;
    // Make a shallow copy so we can safely use it without mutating input
    const statusStageCompatibility = { ...config.statusStageCompatibility };
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
export function loadStatusStageRules(config) {
    const resolvedConfig = config ?? loadConfig();
    if (!resolvedConfig) {
        throw new Error('Status/stage rules require a valid config.');
    }
    return createStatusStageRules(resolvedConfig);
}
export const getStatusLabel = (value, rules) => {
    if (value === undefined || value === null)
        return '';
    const normalized = normalizeStatusValue(value) ?? value;
    return rules.statusLabels[normalized] ?? rules.statusLabels[value] ?? value;
};
export const getStageLabel = (value, rules) => {
    if (value === undefined || value === null)
        return '';
    const normalized = normalizeStageValue(value) ?? value;
    return rules.stageLabels[normalized] ?? rules.stageLabels[value] ?? value;
};
export const getStatusValueFromLabel = (label, rules) => {
    if (label === undefined || label === null)
        return undefined;
    const trimmed = label.trim();
    if (trimmed in rules.statusValuesByLabel)
        return rules.statusValuesByLabel[trimmed];
    const normalized = normalizeStatusValue(trimmed) ?? trimmed;
    if (rules.statusValues.includes(normalized))
        return normalized;
    if (rules.statusValues.includes(trimmed))
        return trimmed;
    return undefined;
};
export const getStageValueFromLabel = (label, rules) => {
    if (label === undefined || label === null)
        return undefined;
    const trimmed = label.trim();
    if (trimmed in rules.stageValuesByLabel)
        return rules.stageValuesByLabel[trimmed];
    const normalized = normalizeStageValue(trimmed) ?? trimmed;
    if (rules.stageValues.includes(normalized))
        return normalized;
    if (rules.stageValues.includes(trimmed))
        return trimmed;
    return undefined;
};
//# sourceMappingURL=status-stage-rules.js.map