// src/wl-integration/spawn.ts

import { spawn } from "child_process";
import { EventEmitter } from "events";

/**
 * Options for running a wl command.
 */
export interface RunOptions {
  /** Working directory for the command */
  cwd?: string;
  /** Environment variable overrides */
  env?: NodeJS.ProcessEnv;
  /** Timeout in milliseconds (default 5000) */
  timeoutMs?: number;
  /** Number of retries on transient failures */
  retries?: number;
  /** Delay between retries in ms */
  retryDelayMs?: number;
}

/** Result of a wl command execution */
export interface CommandResult {
  stdout: string;
  stderr: string;
  json?: any;
  exitCode: number;
  error?: WlError;
}

/** Structured error for the integration layer */
export class WlError extends Error {
  code: string;
  args: string[];
  originalError?: Error;
  constructor(message: string, code: string, args: string[], originalError?: Error) {
    super(message);
    this.name = "WlError";
    this.code = code;
    this.args = args;
    this.originalError = originalError;
  }
}

/** Global event emitter for UI consumers */
export const wlEvents = new EventEmitter();

/**
 * Optional custom spawn function for testing / injection.
 * When set, replaces the default `child_process.spawn` for all calls.
 */
let _customSpawn: ((cmd: string, args: string[], opts?: any) => any) | null = null;

/**
 * Inject a custom spawn function for testing.
 * @param fn The spawn function to use instead of the default.
 */
export function setCustomSpawn(fn: ((cmd: string, args: string[], opts?: any) => any) | null): void {
  _customSpawn = fn;
}

/**
 * Run a wl command safely.
 * @param args Arguments to pass to the wl binary.
 * @param options Execution options.
 */
export async function runWlCommand(
  args: string[],
  options: RunOptions = {}
): Promise<CommandResult> {
  const {
    cwd = process.cwd(),
    env = process.env,
    // timeoutMs of 0 or undefined means no timeout
    timeoutMs = undefined,
    retries = 0,
    retryDelayMs = 200,
  } = options;

  let attempt = 0;
  const exec = (): Promise<CommandResult> => {
    return new Promise((resolve) => {
      wlEvents.emit("command-start", { args });
      wlEvents.emit("command:start", { args });
      const child = _customSpawn
        ? _customSpawn("wl", args, { cwd, env, shell: false })
        : spawn("wl", args, { cwd, env, shell: false });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill();
          // Emit close to ensure resolution on timeout
          child.emit("close", -1);
        }, timeoutMs);
      }

      child.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
      child.stderr.on("data", (data: Buffer) => (stderr += data.toString()));

      child.on("close", (code: number | null) => {
        if (timer) clearTimeout(timer);
        const result: CommandResult = { stdout, stderr, exitCode: code ?? -1 };
        if (timedOut) {
          const err = new WlError(
            `Command timed out after ${timeoutMs}ms`,
            "TIMEOUT",
            args
          );
          result.error = err;
          wlEvents.emit("command-error", { error: err, args });
          resolve(result);
          return;
        }
        if (code !== 0) {
          const err = new WlError(
            `Command exited with non-zero code ${code}`,
            "NON_ZERO_EXIT",
            args
          );
          result.error = err;
          wlEvents.emit("command-error", { error: err, args });
          resolve(result);
          return;
        }
        // Success path – attempt JSON parse if requested
        if (args.includes("--json")) {
          try {
            result.json = JSON.parse(stdout);
          } catch (e) {
            const err = new WlError(
              "Failed to parse JSON output",
              "JSON_PARSE",
              args,
              e as Error
            );
            result.error = err;
            wlEvents.emit("command-error", { error: err, args });
            resolve(result);
            return;
          }
        }
        wlEvents.emit("command-end", { result });
        wlEvents.emit("command:success", { result });
        resolve(result);
      });
    });
  };

  while (attempt <= retries) {
    const res = await exec();
    if (!res.error) {
      return res;
    }
    // If timeout or non-zero, consider retryable only for timeout
    if (res.error.code === "TIMEOUT") {
      attempt++;
      if (attempt > retries) return res;
      await new Promise((r) => setTimeout(r, retryDelayMs));
      continue;
    }
    // Non-retryable error
    return res;
  }
  // Should not reach here
  return { stdout: "", stderr: "", exitCode: -1, error: new WlError("Unexpected", "UNKNOWN", args) };
}
