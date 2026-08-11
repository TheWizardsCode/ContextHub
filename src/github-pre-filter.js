import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { resolveWorklogDir } from './worklog-paths.js';
// Base filename and metadata key used historically. For compatibility we
// continue to support the old global names but prefer per-repo keys when
// a repo identifier is provided.
const TIMESTAMP_FILENAME_BASE = 'github-last-push';
const METADATA_KEY_BASE = 'githubLastPush';
function sanitizeRepo(repo) {
    // Replace path separator with a safe token and remove unsafe chars
    return repo.replace(/\//g, '__').replace(/[^a-zA-Z0-9_.-]/g, '-');
}
function timestampFilenameForRepo(repo) {
    if (!repo)
        return TIMESTAMP_FILENAME_BASE;
    return `${TIMESTAMP_FILENAME_BASE}-${sanitizeRepo(repo)}`;
}
function metadataKeyForRepo(repo) {
    if (!repo)
        return METADATA_KEY_BASE;
    return `${METADATA_KEY_BASE}:${repo}`;
}
export function readLastPushTimestamp(db, repo) {
    // Try DB metadata first when a database instance is provided. Prefer
    // repo-specific metadata key, but fall back to the legacy global key for
    // backward compatibility.
    try {
        if (db && typeof db.getMetadata === 'function') {
            if (repo) {
                const v = db.getMetadata(metadataKeyForRepo(repo));
                if (v)
                    return v;
            }
            const v = db.getMetadata(METADATA_KEY_BASE);
            if (v)
                return v;
        }
    }
    catch (_err) {
        // ignore DB metadata read errors and fall back to file
    }
    try {
        const dir = resolveWorklogDir();
        // Try repo-specific file first, then fallback to the legacy filename.
        const repoFile = path.join(dir, timestampFilenameForRepo(repo));
        if (repo && fs.existsSync(repoFile)) {
            const content = fs.readFileSync(repoFile, { encoding: 'utf8' }).trim();
            return content || null;
        }
        const p = path.join(dir, TIMESTAMP_FILENAME_BASE);
        if (!fs.existsSync(p))
            return null;
        const content = fs.readFileSync(p, { encoding: 'utf8' }).trim();
        return content || null;
    }
    catch (_err) {
        return null;
    }
}
export function writeLastPushTimestamp(ts, db, repo) {
    // Try DB metadata when available. Prefer writing a repo-specific key,
    // but also write the legacy global key for backward compatibility.
    if (db && typeof db.setMetadata === 'function') {
        try {
            if (repo) {
                try {
                    db.setMetadata(metadataKeyForRepo(repo), ts);
                }
                catch (_e) {
                    // Best-effort: continue and try writing the legacy key
                }
            }
            db.setMetadata(METADATA_KEY_BASE, ts);
        }
        catch (err) {
            // Best-effort: log and continue to file write
            console.error(`Failed to write last-push timestamp to DB metadata: ${err.message}`);
        }
    }
    const dir = resolveWorklogDir();
    try {
        // ensure directory exists
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        // Write repo-specific file (if repo provided) and also the legacy file
        // to preserve existing expectations from other tools/tests.
        // Use atomic writes (write to temp file then rename) to prevent
        // corruption from interrupted writes.
        if (repo) {
            const repoPath = path.join(dir, timestampFilenameForRepo(repo));
            try {
                atomicWriteFileSync(repoPath, `${ts}\n`, { encoding: 'utf8' });
            }
            catch (err) {
                console.error(`Failed to write last-push timestamp (${repoPath}): ${err.message}`);
            }
        }
        const p = path.join(dir, TIMESTAMP_FILENAME_BASE);
        // include a trailing newline for easier human inspection
        atomicWriteFileSync(p, `${ts}\n`, { encoding: 'utf8' });
    }
    catch (err) {
        // best-effort: do not throw, allow CLI to continue
        console.error(`Failed to write last-push timestamp: ${err.message}`);
    }
}
/**
 * Atomic file write: write content to a temp file in the same directory,
 * then rename over the target. Prevents corruption from interrupted
 * writes.
 */
function atomicWriteFileSync(filePath, content, options) {
    const dir = path.dirname(filePath);
    const tmpFile = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
        fs.writeFileSync(tmpFile, content, options);
        fs.renameSync(tmpFile, filePath);
    }
    catch (err) {
        // Clean up temp file on failure
        try {
            if (fs.existsSync(tmpFile))
                fs.unlinkSync(tmpFile);
        }
        catch (_e) {
            // Ignore cleanup errors
        }
        throw err;
    }
}
function isValidIso(iso) {
    if (!iso)
        return false;
    const t = new Date(iso).getTime();
    return !Number.isNaN(t);
}
export function filterItemsForPush(items, comments, lastPushTimestamp) {
    // Exclude deleted items that have no githubIssueNumber (they can never be
    // closed on GitHub). Deleted items WITH a githubIssueNumber are kept so
    // their corresponding GitHub issues can be closed.
    const deletedWithoutIssue = items.filter(i => i.status === 'deleted' && i.githubIssueNumber == null);
    const deletedWithoutIssueCount = deletedWithoutIssue.length;
    const candidates = items.filter(i => {
        if (i.status === 'deleted') {
            return i.githubIssueNumber != null;
        }
        return true;
    });
    // If no timestamp recorded (first run / force mode), return all candidates
    if (!isValidIso(lastPushTimestamp)) {
        return {
            filteredItems: candidates,
            filteredComments: comments.filter(c => candidates.find(i => i.id === c.workItemId)),
            totalCandidates: candidates.length,
            skippedCount: 0,
            deletedWithoutIssueCount,
        };
    }
    const lastMs = new Date(lastPushTimestamp).getTime();
    const filtered = candidates.filter(item => {
        // Always include new items that have not yet been pushed
        if (item.githubIssueNumber == null)
            return true;
        const updatedMs = new Date(item.updatedAt).getTime();
        if (Number.isNaN(updatedMs))
            return true; // treat unknown updatedAt as changed
        // Compare against the last-push timestamp.
        // (Explicit --id pushes bypass this filter.)
        return updatedMs > lastMs;
    });
    const filteredIds = new Set(filtered.map(i => i.id));
    const filteredComments = comments.filter(c => filteredIds.has(c.workItemId));
    return {
        filteredItems: filtered,
        filteredComments,
        totalCandidates: candidates.length,
        skippedCount: Math.max(0, candidates.length - filtered.length),
        deletedWithoutIssueCount,
    };
}
//# sourceMappingURL=github-pre-filter.js.map