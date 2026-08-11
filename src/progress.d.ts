export type ProgressPhase = 'push' | 'import' | 'close-check' | 'hierarchy' | 'comments' | 'saving';
export interface ProgressEvent {
    phase: ProgressPhase;
    current: number;
    total: number;
    note?: string;
}
export type ProgressMode = 'auto' | 'json' | 'human' | 'quiet';
export interface ProgressOptions {
    mode?: ProgressMode;
    rateMs?: number;
    outStream?: NodeJS.WriteStream;
    jsonStream?: NodeJS.WriteStream;
}
export interface ProgressHeartbeatOptions {
    intervalMs?: number;
    notePrefix?: string;
}
export declare class ProgressReporter {
    private mode;
    private rateMs;
    private outStream;
    private jsonStream;
    private lastEmitByPhase;
    private heartbeatTimer;
    private heartbeatIntervalMs;
    private heartbeatNotePrefix;
    private lastProgressEvent;
    private lastProgressAtMs;
    private lastHumanRenderLength;
    constructor(opts?: ProgressOptions);
    private labelFor;
    private formatHuman;
    private formatJson;
    private supportsHumanHeartbeat;
    private writeHumanMessage;
    private emit;
    render(ev: ProgressEvent): void;
    startHeartbeat(opts?: ProgressHeartbeatOptions): void;
    stopHeartbeat(): void;
}
//# sourceMappingURL=progress.d.ts.map