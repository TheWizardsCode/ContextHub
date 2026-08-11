import { normalizeStageValue, normalizeStatusValue } from '../status-stage-rules.js';
import { getAllowedStagesForStatus, getAllowedStatusesForStage, isStatusStageCompatible } from '../status-stage-validation.js';
const CHECK_ID_STATUS_INVALID = 'status-stage.invalid-status';
const CHECK_ID_STAGE_INVALID = 'status-stage.invalid-stage';
const CHECK_ID_STATUS_STAGE_INCOMPATIBLE = 'status-stage.incompatible';
const TYPE_STATUS_INVALID = 'invalid-status';
const TYPE_STAGE_INVALID = 'invalid-stage';
const TYPE_STATUS_STAGE_INCOMPATIBLE = 'incompatible-status-stage';
const STATUS_STAGE_SEVERITY = 'warning';
const RULE_SOURCE = 'docs/validation/status-stage-inventory.md';
const resolveStatus = (value, rules) => {
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
const resolveStage = (value, rules) => {
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
export function validateStatusStageItems(items, rules) {
    const findings = [];
    for (const item of items) {
        const status = resolveStatus(item.status, rules);
        const stageValue = item.stage ?? '';
        const stage = resolveStage(stageValue, rules);
        if (!status.isValid) {
            if (status.isNormalizedValid) {
                findings.push({
                    checkId: CHECK_ID_STATUS_INVALID,
                    type: TYPE_STATUS_INVALID,
                    severity: STATUS_STAGE_SEVERITY,
                    itemId: item.id,
                    message: `Status "${status.value}" is not canonical; use "${status.normalized}" per config.`,
                    proposedFix: { status: status.normalized, allowedStatuses: rules.statusValues },
                    safe: true,
                    context: {
                        status: status.value,
                        normalizedStatus: status.normalized,
                        ruleSource: RULE_SOURCE,
                    },
                });
            }
            else {
                findings.push({
                    checkId: CHECK_ID_STATUS_INVALID,
                    type: TYPE_STATUS_INVALID,
                    severity: STATUS_STAGE_SEVERITY,
                    itemId: item.id,
                    message: `Status "${status.value}" is not defined in config statuses.`,
                    proposedFix: { allowedStatuses: rules.statusValues },
                    safe: false,
                    context: {
                        status: status.value,
                        ruleSource: RULE_SOURCE,
                    },
                });
            }
        }
        if (!stage.isValid) {
            if (stage.isNormalizedValid) {
                findings.push({
                    checkId: CHECK_ID_STAGE_INVALID,
                    type: TYPE_STAGE_INVALID,
                    severity: STATUS_STAGE_SEVERITY,
                    itemId: item.id,
                    message: `Stage "${stage.value}" is not canonical; use "${stage.normalized}" per config.`,
                    proposedFix: { stage: stage.normalized, allowedStages: rules.stageValues },
                    safe: true,
                    context: {
                        stage: stage.value,
                        normalizedStage: stage.normalized,
                        ruleSource: RULE_SOURCE,
                    },
                });
            }
            else {
                findings.push({
                    checkId: CHECK_ID_STAGE_INVALID,
                    type: TYPE_STAGE_INVALID,
                    severity: STATUS_STAGE_SEVERITY,
                    itemId: item.id,
                    message: `Stage "${stage.value}" is not defined in config stages.`,
                    proposedFix: { allowedStages: rules.stageValues },
                    safe: false,
                    context: {
                        stage: stage.value,
                        ruleSource: RULE_SOURCE,
                    },
                });
            }
        }
        if (!status.isValid || !stage.isValid) {
            continue;
        }
        const validationRules = {
            statusStage: rules.statusStageCompatibility,
            stageStatus: rules.stageStatusCompatibility,
        };
        if (!isStatusStageCompatible(status.canonical, stage.canonical, validationRules)) {
            const allowedStages = getAllowedStagesForStatus(status.canonical, validationRules);
            const allowedStatuses = getAllowedStatusesForStage(stage.canonical, validationRules);
            let proposedFix = null;
            let safe = false;
            if (allowedStages.length === 1) {
                proposedFix = { stage: allowedStages[0], allowedStages };
                safe = true;
            }
            else if (allowedStatuses.length === 1) {
                proposedFix = { status: allowedStatuses[0], allowedStatuses };
                safe = true;
            }
            else {
                proposedFix = { allowedStages, allowedStatuses };
            }
            findings.push({
                checkId: CHECK_ID_STATUS_STAGE_INCOMPATIBLE,
                type: TYPE_STATUS_STAGE_INCOMPATIBLE,
                severity: STATUS_STAGE_SEVERITY,
                itemId: item.id,
                message: `Status "${status.canonical}" is not compatible with stage "${stage.canonical}" per config statusStageCompatibility.`,
                proposedFix,
                safe,
                context: {
                    status: status.canonical,
                    stage: stage.canonical,
                    allowedStages,
                    allowedStatuses,
                    ruleSource: RULE_SOURCE,
                },
            });
        }
    }
    return findings;
}
//# sourceMappingURL=status-stage-check.js.map