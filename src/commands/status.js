/**
 * Status command - Show Worklog system status and database summary
 */
import { isInitialized, readInitSemaphore, getConfigDir } from '../config.js';
import { DEFAULT_GIT_REMOTE, DEFAULT_GIT_BRANCH } from '../sync-defaults.js';
import * as fs from 'fs';
import * as path from 'path';
export default function register(ctx) {
    const { program, output, utils } = ctx;
    program
        .command('status')
        .description('Show Worklog system status and database summary')
        .option('--prefix <prefix>', 'Override the default prefix')
        .action((options) => {
        const isJsonMode = utils.isJsonMode();
        if (!isInitialized()) {
            if (isJsonMode) {
                output.json({
                    success: false,
                    initialized: false,
                    error: 'Worklog system is not initialized. Run "worklog init" first.'
                });
            }
            else {
                console.error('Error: Worklog system is not initialized.');
                console.error('Run "worklog init" to initialize the system.');
            }
            process.exit(1);
        }
        const initInfo = readInitSemaphore();
        const db = utils.getDatabase(options.prefix);
        const workItems = db.getAll();
        const comments = db.getAllComments();
        const config = utils.getConfig();
        // Read last sync time if available
        let lastSync = null;
        const lastSyncPath = path.join(getConfigDir(), 'last-sync-time');
        try {
            if (fs.existsSync(lastSyncPath)) {
                lastSync = fs.readFileSync(lastSyncPath, 'utf-8').trim();
            }
        }
        catch {
            // Silently ignore read errors
        }
        const closedCount = workItems.filter(i => i.status === 'completed').length;
        const deletedCount = workItems.filter(i => i.status === 'deleted').length;
        const openCount = workItems.length - closedCount - deletedCount;
        if (isJsonMode) {
            output.json({
                success: true,
                initialized: true,
                version: initInfo?.version || 'unknown',
                initializedAt: initInfo?.initializedAt || 'unknown',
                lastSync: lastSync,
                config: {
                    projectName: config?.projectName,
                    prefix: config?.prefix,
                    autoSync: config?.autoSync === true,
                    syncRemote: config?.syncRemote,
                    syncBranch: config?.syncBranch,
                    githubRepo: config?.githubRepo,
                    githubLabelPrefix: config?.githubLabelPrefix,
                    githubImportCreateNew: config?.githubImportCreateNew !== false
                },
                database: {
                    workItems: workItems.length,
                    comments: comments.length,
                    open: openCount,
                    closed: closedCount,
                    deleted: deletedCount
                }
            });
        }
        else {
            console.log('Worklog System Status');
            console.log('=====================\n');
            console.log(`Initialized: Yes`);
            console.log(`Version: ${initInfo?.version || 'unknown'}`);
            console.log(`Initialized at: ${initInfo?.initializedAt || 'unknown'}`);
            console.log();
            console.log('Configuration:');
            console.log(`  Project: ${config?.projectName || 'unknown'}`);
            console.log(`  Prefix: ${config?.prefix || 'unknown'}`);
            console.log(`  Auto-sync: ${config?.autoSync ? 'enabled' : 'disabled'}`);
            console.log(`  Sync remote: ${config?.syncRemote || DEFAULT_GIT_REMOTE}`);
            console.log(`  Sync branch: ${config?.syncBranch || DEFAULT_GIT_BRANCH}`);
            if (config?.githubRepo || config?.githubLabelPrefix) {
                console.log(`  GitHub repo: ${config?.githubRepo || '(not set)'}`);
                console.log(`  GitHub label prefix: ${config?.githubLabelPrefix || 'wl:'}`);
                console.log(`  GitHub import create: ${config?.githubImportCreateNew !== false ? 'enabled' : 'disabled'}`);
            }
            console.log();
            console.log('Sync:');
            console.log(`  Last sync:  ${lastSync || 'Never'}`);
            console.log();
            console.log('Database Summary:');
            console.log(`  Work Items: ${workItems.length}`);
            console.log(`  Open:       ${openCount}`);
            console.log(`  Closed:     ${closedCount}`);
            if (deletedCount > 0)
                console.log(`  Deleted:    ${deletedCount}`);
            console.log(`  Comments:   ${comments.length}`);
        }
    });
}
//# sourceMappingURL=status.js.map