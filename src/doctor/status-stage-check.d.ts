import type { WorkItem } from '../types.js';
import type { StatusStageRules } from '../status-stage-rules.js';
export type DoctorSeverity = 'info' | 'warning' | 'error';
export type DoctorFinding = {
    checkId: string;
    type: string;
    severity: DoctorSeverity;
    itemId: string;
    message: string;
    proposedFix: Record<string, unknown> | string | null;
    safe: boolean;
    context: Record<string, unknown>;
};
export declare function validateStatusStageItems(items: WorkItem[], rules: StatusStageRules): DoctorFinding[];
//# sourceMappingURL=status-stage-check.d.ts.map