# wl CLI Integration Layer

## Overview

The **wl CLI Integration Layer** provides a safe, reliable way for the TUI and Pi agents to execute `wl` commands via subprocess spawn. It handles:

- **Command spawning** – wraps `child_process.spawn` with configurable timeout, retries, and working directory.
- **JSON parsing** – automatically parses `--json` output and surfaces parse errors.
- **Event emission** – emits lifecycle events (`command:start`, `command:success`, `command:error`) for UI consumers to react.
- **Structured errors** – all failures return a `WlError` with a machine-readable `code` field.

## Quick Start

```ts
import { runWlCommand, runWl, wlEvents } from './src/tui/wl-integration.js';

// Simple usage – TUI wrapper automatically appends --json
const items = await runWl('list');

// Low-level usage – full control over args and options
const result = await runWlCommand(['show', 'WL-123', '--json'], {
  timeoutMs: 10_000,
  retries: 2,
  retryDelayMs: 500,
  cwd: '/path/to/worklog/repo',
});

if (result.error) {
  console.error(result.error.code, result.stderr); // "TIMEOUT", "NON_ZERO_EXIT", "JSON_PARSE"
} else {
  console.log(result.json);
}
```

## Events

Subscribe to lifecycle events for UI feedback (spinners, toasts, etc.):

```ts
wlEvents.on('command:start', ({ args }) => {
  showSpinner();
});

wlEvents.on('command:success', ({ result }) => {
  hideSpinner();
  notify(`Command ${args.join(' ')} succeeded`);
});

wlEvents.on('command:error', ({ error, args }) => {
  hideSpinner();
  showToast(`Command failed: ${error.message}`);
});
```

## Error Codes

| Code           | Meaning                                   | Retryable? |
| -------------- | ----------------------------------------- | ---------- |
| `TIMEOUT`      | Command exceeded the configured timeout   | Yes        |
| `NON_ZERO_EXIT`| `wl` exited with a non-zero code          | No         |
| `JSON_PARSE`   | `--json` output was not valid JSON        | No         |

## Migration Notes for Existing TUI Code

The old pattern in the TUI controller looked like this:

```ts
// BEFORE: raw spawn
const child = spawnImpl('wl', ['list', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
child.on('close', (code) => {
  if (code !== 0) { /* handle error */ return; }
  const payload = JSON.parse(stdout.trim());
  /* ... */
});
```

Migrate to the integration layer:

```ts
// AFTER: use runWl or runWlCommand
const result = await runWlCommand(['list', '--json']);
if (result.error) { /* handle error */ return; }
const payload = result.json;
/* ... */
```

The `runWl` convenience wrapper automatically appends `--json` and throws on error, making it ideal for TUI flows that expect JSON output:

```ts
try {
  const items = await runWl('list');
  state.items = items;
} catch (err) {
  showToast(`Failed to list work items: ${err.message}`);
}
```

## Configuration

| Option        | Default         | Description                                  |
| ------------- | --------------- | -------------------------------------------- |
| `timeoutMs`   | `undefined`     | Kill command after this many ms (0 = no limit)|
| `retries`     | `0`             | Automatic retries on `TIMEOUT` errors        |
| `retryDelayMs`| `200`           | Delay between retry attempts                 |
| `cwd`         | `process.cwd()` | Working directory for the subprocess          |
| `env`         | `process.env`   | Environment variable overrides                |

## See Also

- [API Reference](./wl-integration-api.md) – full type definitions
- [Architectural Migration](../IMPLEMENTATION_SUMMARY.md) – overview of the SQLite → wl CLI migration
