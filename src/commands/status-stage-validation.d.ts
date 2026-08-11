import type { WorklogConfig } from '../types.js';
import type { StatusStageRules } from '../status-stage-rules.js';
type ValidationResult = {
    status: string;
    stage: string;
    warnings: string[];
    rules: StatusStageRules;
};
export declare const validateStatusStageInput: (input: {
    status?: string;
    stage?: string;
}, config?: WorklogConfig | null) => ValidationResult;
export declare const canValidateStatusStage: (config?: WorklogConfig | null) => boolean;
export declare const validateStatusStageCompatibility: (status: string, stage: string, rules: StatusStageRules) => void;
export {};
//# sourceMappingURL=status-stage-validation.d.ts.map