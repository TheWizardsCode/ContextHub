import type { WorklogConfig } from './types.js';
export type StatusStageEntry = {
    value: string;
    label: string;
};
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
export declare const normalizeStatusValue: (value?: string) => string | undefined;
export declare const normalizeStageValue: (value?: string) => string | undefined;
export declare function deriveStageStatusCompatibility(statusStage: Record<string, readonly string[]>, stages: readonly string[]): Record<string, string[]>;
export declare function createStatusStageRules(config: Pick<WorklogConfig, 'statuses' | 'stages' | 'statusStageCompatibility'>): StatusStageRules;
export declare function loadStatusStageRules(config?: WorklogConfig | null): StatusStageRules;
export declare const getStatusLabel: (value: string | undefined, rules: StatusStageRules) => string;
export declare const getStageLabel: (value: string | undefined, rules: StatusStageRules) => string;
export declare const getStatusValueFromLabel: (label: string | undefined, rules: StatusStageRules) => string | undefined;
export declare const getStageValueFromLabel: (label: string | undefined, rules: StatusStageRules) => string | undefined;
//# sourceMappingURL=status-stage-rules.d.ts.map