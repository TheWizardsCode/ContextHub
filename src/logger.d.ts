/**
 * Small centralized logger helper to standardize debug/info/error output
 * Respects verbose/silent semantics and routes debug output to stderr so
 * JSON output on stdout remains clean.
 */
export type LoggerOptions = {
    verbose?: boolean;
    jsonMode?: boolean;
};
export declare class Logger {
    private verbose;
    private jsonMode;
    constructor(opts?: LoggerOptions);
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
export default Logger;
//# sourceMappingURL=logger.d.ts.map