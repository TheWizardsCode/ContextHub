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
  // If there was an error, propagate it via the event system (already emitted by runWlCommand)
  if (result.error) {
    // The lower-level already emitted "command:error"
    throw result.error;
  }
  // Successful result contains parsed JSON in result.json
  return result.json;
}

export { wlEvents };

