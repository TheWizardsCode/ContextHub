/**
 * Shared CLI utilities and context factory
 */
import { WorklogDatabase } from './database.js';
import { loadConfig, loadConfigRelaxed, isInitialized, getDefaultPrefix } from './config.js';
import { getDefaultDataPath } from './jsonl.js';
// WORKLOG_VERSION is injected at build time by scripts/generate-version.js
// to keep the built artifact in sync with package.json.
// Placeholder value — replaced during build.
const WORKLOG_VERSION = '1.0.0';
/**
 * Output formatting helpers
 */
export function createOutputHelpers(program) {
    return {
        json: (data) => {
            console.log(JSON.stringify(data, null, 2));
        },
        success: (message, jsonData) => {
            const isJsonMode = program.opts().json;
            if (isJsonMode) {
                console.log(JSON.stringify(jsonData || { success: true, message }, null, 2));
            }
            else {
                console.log(message);
            }
        },
        error: (message, jsonData) => {
            const isJsonMode = program.opts().json;
            if (isJsonMode) {
                console.error(JSON.stringify(jsonData || { success: false, error: message }, null, 2));
            }
            else {
                console.error(message);
            }
        }
    };
}
/**
 * Check if worklog is initialized and exit if not
 * Outputs proper error messages based on JSON mode
 */
export function createRequireInitialized(program) {
    return () => {
        if (!isInitialized()) {
            const isJsonMode = program.opts().json;
            if (isJsonMode) {
                console.log(JSON.stringify({
                    success: false,
                    initialized: false,
                    error: 'Worklog system is not initialized. Run "worklog init" first.'
                }, null, 2));
            }
            else {
                console.error('Error: Worklog system is not initialized.');
                console.error('Run "worklog init" to initialize the system.');
            }
            process.exit(1);
        }
    };
}
/**
 * Get database instance with optional prefix override
 */
export function getDatabase(prefix, program) {
    const config = loadConfigRelaxed();
    const effectivePrefix = prefix || config?.prefix || getDefaultPrefix();
    const dataPath = getDefaultDataPath();
    // Get auto-sync settings from config
    const autoSync = config?.autoSync === true; // Default to false
    // Determine silent mode: suppress output unless verbose OR not in JSON mode
    const isJsonMode = program?.opts?.()?.json || false;
    const isVerbose = program?.opts?.()?.verbose || false;
    const silent = isJsonMode || !isVerbose;
    return new WorklogDatabase(effectivePrefix, undefined, dataPath, silent, autoSync);
}
/**
 * Get prefix from config or use override
 */
export function getPrefix(overridePrefix) {
    if (overridePrefix) {
        return overridePrefix.toUpperCase();
    }
    return getDefaultPrefix();
}
/**
 * Normalize an ID provided on the CLI. If the value already contains a dash
 * (assumed to include a prefix) it will be upper-cased and returned as-is.
 * Otherwise the configured default prefix (or provided override) is prepended
 * and the resulting ID is returned in upper-case. Returns undefined for
 * undefined/empty input.
 */
export function normalizeCliId(id, overridePrefix) {
    if (!id && id !== '')
        return undefined;
    const trimmed = (id || '').toString().trim();
    if (trimmed === '')
        return undefined;
    // If it already contains a dash, assume it has a prefix and normalize casing
    if (trimmed.includes('-'))
        return trimmed.toUpperCase();
    const prefix = getPrefix(overridePrefix);
    return `${prefix}-${trimmed.toUpperCase()}`;
}
/**
 * Create shared plugin context
 */
export function createPluginContext(program) {
    return {
        program,
        version: WORKLOG_VERSION,
        dataPath: getDefaultDataPath(),
        output: createOutputHelpers(program),
        utils: {
            requireInitialized: createRequireInitialized(program),
            getDatabase: (prefix) => getDatabase(prefix, program),
            getConfig: loadConfig,
            getPrefix,
            normalizeCliId,
            isJsonMode: () => program.opts().json
        }
    };
}
/**
 * Get Worklog version
 */
export function getVersion() {
    try {
        // Resolve package.json relative to project root (where this module is
        // located). Use dynamic import so this works under ESM and in tests.
        // Keep this synchronous-ish by using require-style read via fs.
        // Use a try/catch to avoid throwing in environments where filesystem
        // access is restricted.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path');
        const pkgPath = path.resolve(process.cwd(), 'package.json');
        // We deliberately avoid require() because of ESM; use fs.readFileSync instead.
        // Import fs lazily to keep startup cost low.
        const fs = require('fs');
        const raw = fs.readFileSync(pkgPath, 'utf8');
        const pkg = JSON.parse(raw);
        if (pkg && pkg.version)
            return String(pkg.version);
    }
    catch (_) {
        // ignore and fall back
    }
    return WORKLOG_VERSION;
}
//# sourceMappingURL=cli-utils.js.map
