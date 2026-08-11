/**
 * Small centralized logger helper to standardize debug/info/error output
 * Respects verbose/silent semantics and routes debug output to stderr so
 * JSON output on stdout remains clean.
 */
export class Logger {
    verbose;
    jsonMode;
    constructor(opts = {}) {
        this.verbose = !!opts.verbose;
        this.jsonMode = !!opts.jsonMode;
    }
    debug(message) {
        if (!this.verbose)
            return;
        // Always send debug diagnostics to stderr to avoid contaminating stdout
        console.error(message);
    }
    info(message) {
        if (this.jsonMode) {
            // In JSON mode, avoid writing human-readable messages to stdout.
            // Callers should output structured JSON themselves.
            return;
        }
        console.log(message);
    }
    warn(message) {
        // Always write warnings to stderr (like error but semantically distinct)
        console.error(message);
    }
    error(message) {
        // Always write errors to stderr
        console.error(message);
    }
}
export default Logger;
//# sourceMappingURL=logger.js.map