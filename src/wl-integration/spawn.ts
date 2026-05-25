// src/wl-integration/spawn.ts

import { spawn, spawnSync } from "child_process";
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
  /** Number of attempts made (1 = no retries) */
  attempts?: number;
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
 * Run a wl command synchronously with JSON parsing.
 * Used by adapters that must execute synchronously (e.g. WlDbAdapter).
 * @param args Arguments to pass to the wl binary.
 * @param options Execution options (timeoutMs, cwd, env).
 */
export function runWlCommandSync(
  args: string[],
  options: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}
): CommandResult {
  const { cwd = process.cwd(), env = process.env, timeoutMs = 15000 } = options;
  wlEvents.emit("command-start", { args });
  wlEvents.emit("command:start", { args });

  try {
    const result = spawnSync("wl", args, {
      cwd,
      env: { ...env, WL_TUI_MODE: "1" },
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      encoding: "utf-8" as const,
      shell: false,
    });

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const exitCode = result.status ?? -1;
    const commandResult: CommandResult = { stdout, stderr, exitCode, attempts: 1 };

    if (result.error) {
      commandResult.error = new WlError(
        result.error.message,
        "SPAWN_ERROR",
        args,
        result.error
      );
      wlEvents.emit("command-error", { error: commandResult.error, args });
      return commandResult;
    }

    if (exitCode !== 0) {
      commandResult.error = new WlError(
        `Command exited with non-zero code ${exitCode}`,
        "NON_ZERO_EXIT",
        args
      );
      wlEvents.emit("command-error", { error: commandResult.error, args });
      return commandResult;
    }

    // Success path – attempt JSON parse if requested
    if (args.includes("--json")) {
      const { parsed, error: parseErr } = tryParseJsonForSync(stdout);
      if (parseErr) {
        const err = new WlError(
          `Failed to parse JSON output: ${parseErr.message}`,
          "JSON_PARSE",
          args,
          parseErr
        );
        commandResult.error = err;
        wlEvents.emit("command-error", { error: err, args });
        return commandResult;
      }
      commandResult.json = parsed;
    }

    wlEvents.emit("command-end", { result: commandResult });
    wlEvents.emit("command:success", { result: commandResult });
    return commandResult;
  } catch (err: any) {
    const commandResult: CommandResult = { stdout: "", stderr: err.stderr?.toString?.() ?? "", exitCode: -1, attempts: 1 };
    commandResult.error = new WlError(err.message ?? "Unexpected error", "UNKNOWN", args, err);
    wlEvents.emit("command-error", { error: commandResult.error, args });
    return commandResult;
  }
}

/**
 * Standalone JSON parser for sync use (not inside the runWlCommand closure).
 * Mirrors the tryParseJson logic from runWlCommand.
 */
function tryParseJsonForSync(raw: string): { parsed: any; error: Error | null } {
  if (!raw || !raw.trim()) return { parsed: null, error: null };
  // First try: full parse
  try { return { parsed: JSON.parse(raw), error: null }; } catch {}
  // Second try: find the last complete JSON object
  const jsonMatch = raw.match(/\{[^{}]*\}/g);
  if (jsonMatch && jsonMatch.length > 0) {
    const last = jsonMatch[jsonMatch.length - 1];
    try { return { parsed: JSON.parse(last), error: null }; } catch {}
  }
  // Third try: parse the last non-empty line
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    try { return { parsed: JSON.parse(lastLine), error: null }; } catch {}
  }
  return { parsed: null, error: new Error('No valid JSON found in output') };
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

  /**
   * Calculate retry delay with exponential backoff and jitter.
   * delay = baseDelay * 2^attempt + random(0..100ms)
   */
  const calculateRetryDelay = (baseDelay: number, attempt: number): number => {
    const exponential = baseDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 100;
    return Math.min(exponential + jitter, 5000); // cap at 5s
  };

  /**
   * Attempt to extract valid JSON from potentially partial/malformed output.
   * Tries: full parse, then last complete JSON object via regex, then last JSON line.
   */
  const tryParseJson = (raw: string): { parsed: any; error: Error | null } => {
    if (!raw || !raw.trim()) return { parsed: null, error: null };
    // First try: full parse
    try { return { parsed: JSON.parse(raw), error: null }; } catch {}
    // Second try: find the last complete JSON object
    const jsonMatch = raw.match(/\{[^{}]*\}/g);
    if (jsonMatch && jsonMatch.length > 0) {
      const last = jsonMatch[jsonMatch.length - 1];
      try { return { parsed: JSON.parse(last), error: null }; } catch {}
    }
    // Third try: parse the last non-empty line
    const lines = raw.split('\n').filter(l => l.trim());
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      try { return { parsed: JSON.parse(lastLine), error: null }; } catch {}
    }
    return { parsed: null, error: new Error('No valid JSON found in output') };
  };

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
          const { parsed, error: parseErr } = tryParseJson(stdout);
          if (parseErr) {
            const err = new WlError(
              `Failed to parse JSON output: ${parseErr.message}`,
              "JSON_PARSE",
              args,
              parseErr
            );
            result.error = err;
            wlEvents.emit("command-error", { error: err, args });
            resolve(result);
            return;
          }
          result.json = parsed;
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
      res.attempts = attempt + 1;
      return res;
    }
    // Retry logic: TIMEOUT and JSON_PARSE errors are retryable
    if (res.error.code === "TIMEOUT" || res.error.code === "JSON_PARSE") {
      attempt++;
      res.attempts = attempt;
      if (attempt > retries) return res;
      const delay = calculateRetryDelay(retryDelayMs, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    // Non-retryable error
    res.attempts = attempt + 1;
    return res;
  }
  // Should not reach here
  return { stdout: "", stderr: "", exitCode: -1, error: new WlError("Unexpected", "UNKNOWN", args) };
}
