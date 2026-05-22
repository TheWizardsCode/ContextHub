// wl-integration.ts
// Integration layer for executing wl CLI commands safely.
// Provides a spawn wrapper, JSON parsing, timeout handling, and event emitter for UI consumers.

import { EventEmitter } from "events";
import { runWlCommand, wlEvents, WlError } from "../wl-integration/spawn.js";

/**
 * Options for running a wl command.
 */
export interface RunWlOptions {
  /** Timeout in milliseconds. Defaults to 5000ms. */
  timeout?: number;
  /** Working directory for the command. */
  cwd?: string;
  /** Environment overrides. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Executes a wl CLI command and returns the parsed JSON output.
 * Emits events using the shared wlEvents emitter:
 *   - "command:start"
 *   - "command:success"
 *   - "command:error"
 */

export async function runWl(
  command: string,
  args: string[] = [],
  options: RunWlOptions = {}
): Promise<any> {
  // Forward options to the lower-level runner
  // Ensure JSON output is requested for parsing
  const cmdArgs = [command, ...args];
  if (!cmdArgs.includes("--json")) {
    cmdArgs.push("--json");
  }
  const result = await runWlCommand(cmdArgs, {
    ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
    cwd: options.cwd,
    env: options.env,
  });
  // If there was an error, re-throw it for the caller to handle
  if (result.error) {
    // The lower-level already emitted "command:error"
    throw result.error;
  }
  // If JSON parse failed but exit code was 0, still return the raw stdout
  if (!result.json && result.stdout) {
    try {
      result.json = JSON.parse(result.stdout);
    } catch {
      // Return whatever we could parse
    }
  }
  // Successful result contains parsed JSON in result.json.  For commands
  // that return an envelope with `workItem`, unwrap it so TUI callers can
  // consume the actual item directly while still allowing list/show commands
  // to return their original shapes.
  if (result.json && typeof result.json === 'object') {
    const payload = (result.json as any).workItem ?? result.json;
    return payload;
  }
  return result.json;
}

export { wlEvents };

