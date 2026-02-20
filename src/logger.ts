/**
 * Small centralized logger helper to standardize debug/info/error output
 * Respects verbose/silent semantics and routes debug output to stderr so
 * JSON output on stdout remains clean.
 */

export type LoggerOptions = {
  verbose?: boolean; // emit debug messages
  jsonMode?: boolean; // if true, CLI is in JSON mode
};

export class Logger {
  private verbose: boolean;
  private jsonMode: boolean;

  constructor(opts: LoggerOptions = {}) {
    this.verbose = !!opts.verbose;
    this.jsonMode = !!opts.jsonMode;
  }

  debug(message: string): void {
    if (!this.verbose) return;
    // Always send debug diagnostics to stderr to avoid contaminating stdout
    console.error(message);
  }

  info(message: string): void {
    if (this.jsonMode) {
      // In JSON mode, avoid writing human-readable messages to stdout.
      // Callers should output structured JSON themselves.
      return;
    }
    console.log(message);
  }

  warn(message: string): void {
    // Always write warnings to stderr (like error but semantically distinct)
    console.error(message);
  }

  error(message: string): void {
    // Always write errors to stderr
    console.error(message);
  }
}

export default Logger;
