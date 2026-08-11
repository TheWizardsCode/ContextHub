/**
 * Simple log file helpers with rotation.
 */
import type { WorkItem } from './types.js';
import type { SyncResult } from './sync.js';
export declare function getWorklogLogPath(filename: string): string;
export declare function rotateLogFile(logPath: string): void;
export declare function createLogFileWriter(logPath: string): (line: string) => void;
export declare function logConflictDetails(result: SyncResult, mergedItems: WorkItem[], logLine: (line: string) => void, options?: {
    repoUrl?: string;
}): void;
//# sourceMappingURL=logging.d.ts.map