/**
 * Migration runner for Worklog
 * Exposes listPendingMigrations and runMigrations used by `wl doctor upgrade`
 */
export interface MigrationInfo {
    id: string;
    description: string;
    safe: boolean;
}
interface RunOptions {
    dryRun?: boolean;
    confirm?: boolean;
    logger?: {
        info: (s: string) => void;
        error: (s: string) => void;
    };
}
export declare function listPendingMigrations(dbPath?: string): MigrationInfo[];
export declare function runMigrations(opts?: RunOptions, dbPath?: string, filter?: {
    safeOnly?: boolean;
}): {
    applied: MigrationInfo[];
    backups: string[];
};
export {};
//# sourceMappingURL=index.d.ts.map