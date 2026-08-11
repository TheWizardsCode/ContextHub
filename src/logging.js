/**
 * Simple log file helpers with rotation.
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveWorklogDir } from './worklog-paths.js';
const LOG_ROTATE_BYTES = 100 * 1024 * 1024;
function ensureLogDir() {
    const logDir = path.join(resolveWorklogDir(), 'logs');
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    return logDir;
}
export function getWorklogLogPath(filename) {
    return path.join(ensureLogDir(), filename);
}
export function rotateLogFile(logPath) {
    try {
        if (!fs.existsSync(logPath))
            return;
        const stats = fs.statSync(logPath);
        if (stats.size < LOG_ROTATE_BYTES)
            return;
        const first = `${logPath}.1`;
        const second = `${logPath}.2`;
        if (fs.existsSync(second)) {
            fs.rmSync(second, { force: true });
        }
        if (fs.existsSync(first)) {
            fs.renameSync(first, second);
        }
        fs.renameSync(logPath, first);
    }
    catch {
        // Ignore log rotation errors to avoid breaking CLI commands.
    }
}
export function createLogFileWriter(logPath) {
    rotateLogFile(logPath);
    return (line) => {
        try {
            fs.appendFileSync(logPath, `${line}\n`, 'utf8');
        }
        catch {
            // Ignore logging errors.
        }
    };
}
export function logConflictDetails(result, mergedItems, logLine, options) {
    if (!result.conflictDetails || result.conflictDetails.length === 0) {
        logLine('No conflicts detected.');
        return;
    }
    if (options?.repoUrl) {
        logLine(`Repo: ${options.repoUrl}`);
    }
    logLine(`Conflict details count: ${result.conflictDetails.length}`);
    const itemsById = new Map(mergedItems.map(item => [item.id, item]));
    for (const conflict of result.conflictDetails) {
        const workItem = itemsById.get(conflict.itemId);
        const title = workItem ? workItem.title : '';
        logLine(`Conflict item=${conflict.itemId} title=${title} type=${conflict.conflictType} local=${conflict.localUpdatedAt ?? ''} remote=${conflict.remoteUpdatedAt ?? ''}`);
        for (const field of conflict.fields) {
            logLine(`  field=${field.field} chosen=${field.chosenSource} reason=${field.reason} local=${JSON.stringify(field.localValue)} remote=${JSON.stringify(field.remoteValue)} chosen=${JSON.stringify(field.chosenValue)}`);
        }
    }
}
//# sourceMappingURL=logging.js.map