export interface StatusStageValidationRules {
    statusStage?: Record<string, readonly string[]>;
    stageStatus?: Record<string, readonly string[]>;
}
export declare const getAllowedStagesForStatus: (status?: string, rules?: StatusStageValidationRules) => readonly string[];
export declare const getAllowedStatusesForStage: (stage?: string, rules?: StatusStageValidationRules) => readonly string[];
export declare const isStatusStageCompatible: (status?: string, stage?: string, rules?: StatusStageValidationRules) => boolean;
//# sourceMappingURL=status-stage-validation.d.ts.map