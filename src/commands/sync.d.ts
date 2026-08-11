/**
 * Sync command - Sync work items with git repository
 */
import type { PluginContext } from '../plugin-types.js';
import type { SyncResult } from '../sync.js';
import { loadConfig } from '../config.js';
export declare function getSyncDefaults(config?: ReturnType<typeof loadConfig>): {
    gitRemote: string;
    gitBranch: string;
};
export declare function performSync(dataPath: string, getDatabase: (prefix?: string) => any, options: {
    file: string;
    prefix?: string;
    gitRemote: string;
    gitBranch: string;
    push: boolean;
    dryRun: boolean;
    silent?: boolean;
    isJsonMode?: boolean;
    isVerbose?: boolean;
}): Promise<SyncResult>;
export default function register(ctx: PluginContext): void;
//# sourceMappingURL=sync.d.ts.map