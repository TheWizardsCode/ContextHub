# wl Integration API

This document describes the public Node.js API provided by the **wl CLI Integration Layer**. The layer abstracts the execution of `wl` commands, handling of stdout/stderr, JSON parsing, retries, timeouts, and event emission for UI consumers.

## Exported Functions

```ts
/**
 * Execute a `wl` command safely.
 *
 * @param args Array of arguments to pass to the `wl` binary (e.g. ["list", "--json"]).
 * @param options Optional execution options.
 * @returns Promise<CommandResult>
 */
export function runWlCommand(
  args: string[],
  options?: RunOptions
): Promise<CommandResult>
```

### `RunOptions`
- `cwd?: string` – Working directory for the child process (default: process.cwd()).
- `env?: NodeJS.ProcessEnv` – Environment overrides.
- `timeoutMs?: number` – Maximum time to wait before killing the process (default: 5000 ms).
- `retries?: number` – Number of automatic retries on transient failures (default: 0).
- `retryDelayMs?: number` – Delay between retries (default: 200 ms).

### `CommandResult`
- `stdout: string` – Raw stdout from `wl`.
- `stderr: string` – Raw stderr.
- `json?: any` – Parsed JSON if the command was invoked with `--json` and parsing succeeded.
- `exitCode: number` – Process exit code.
- `error?: Error` – Populated when the command failed, timed‑out, or JSON parsing failed.

## Event Emitter

The module also exports a singleton `wlEvents` which emits lifecycle events for UI components:

- `command:start` – Emitted before a command runs. Payload: `{ args: string[] }`
- `command:success` – After successful execution. Payload: `{ result: CommandResult }`
- `command:error` – When an error occurs. Payload: `{ error: Error, args: string[] }`

```ts
import { wlEvents } from "./wl-integration";
wlEvents.on("command:start", ({ args }) => { /* show spinner */ });
```

## Error Model

All errors are instances of `WlError` extending `Error` with additional fields:
- `code: string` – Machine‑readable error code (`TIMEOUT`, `NON_ZERO_EXIT`, `JSON_PARSE`).
- `args: string[]` – Command arguments.
- `originalError?: Error` – Underlying error if any.

## Testing Approach

Unit tests should mock the child‑process spawn using `sinon` or `jest` and verify:
- Proper handling of exit codes.
- Timeout enforcement.
- Retry logic.
- JSON parsing success and failure cases.

The API is deliberately minimal to keep the integration layer easy to use from both the TUI and Pi agents.
