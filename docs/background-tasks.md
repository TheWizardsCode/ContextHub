# Background Task Runtime

The Worklog extension includes a lightweight background task runtime for running
non-blocking operations. It provides fire-and-forget task launching with
single-flight guards so identical tasks don't pile up.

## Architecture

The runtime is implemented in `src/lib/runtime.ts` as the `WorklogRuntime` class.
A global singleton is accessible via `getRuntime()` and is automatically
initialized at session start.

```
┌─────────────────────────────────────┐
│         CLI / API Server            │
│            │ init / shutdown        │
│            ▼                        │
│  ┌─────────────────────────────┐    │
│  │     WorklogRuntime          │    │
│  │  ┌───────────────────────┐  │    │
│  │  │  inFlight (Map)       │  │    │
│  │  │  label → Promise<void>│  │    │
│  │  └───────────────────────┘  │    │
│  │                             │    │
│  │  launchTask(label, work)    │    │
│  │  isInFlight(label)          │    │
│  │  awaitAll()                 │    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
```

## Key Concepts

### Single-Flight Guard

If `launchTask('sync', work)` is called while a task with the label `'sync'`
is already running, the second call is silently ignored. This prevents
pile-ups when the same event (e.g. a work-item mutation) fires multiple times
before the background operation completes.

Once the running task finishes (or fails), its label is automatically removed
from the in-flight map, so the next `launchTask` call with that label will
run normally.

### Graceful Degradation

Errors thrown by background tasks are caught and logged to stderr. They never
propagate to the caller. This ensures a failing background operation does not
disrupt the main session flow.

### Session Lifecycle Integration

The runtime hooks into the process lifecycle:

- **Session start**: `initializeRuntime()` installs `SIGINT`, `SIGTERM`, and
  `beforeExit` handlers.
- **Session end**: On signal or before exit, the runtime awaits all in-flight
  tasks before allowing the process to exit.

## API Reference

### `WorklogRuntime`

```typescript
class WorklogRuntime {
  launchTask(label: string, work: () => Promise<void>): void;
  isInFlight(label: string): boolean;
  awaitAll(): Promise<void>;
}
```

#### `launchTask(label, work)`

Launches a background task. If a task with the same `label` is already running,
the call is a no-op (single-flight guard).

- `label` — A string identifier used for deduplication and tracking.
- `work` — An async function to execute in the background.

#### `isInFlight(label)`

Returns `true` if a task with the given `label` is currently running.

#### `awaitAll()`

Waits for all currently in-flight tasks to complete. Tasks launched after
calling this method are not affected unless `awaitAll()` is called again.

### Singleton Functions

```typescript
function getRuntime(): WorklogRuntime;
function initializeRuntime(options?: RuntimeOptions): WorklogRuntime;
function shutdownRuntime(): Promise<void>;
```

#### `getRuntime()`

Returns the global `WorklogRuntime` singleton. Creates one lazily if it
doesn't exist yet.

#### `initializeRuntime(options?)`

Initializes the runtime and installs process signal handlers. Call this once
at session start. Options:

- `silent?: boolean` — Suppress log messages (default: `false`).

Returns the global `WorklogRuntime` instance.

#### `shutdownRuntime()`

Awaits all pending tasks and clears the global state. Safe to call multiple
times.

## Use Cases

### Auto-Sync After Work-Item Mutations

```typescript
import { getRuntime } from './lib/runtime.js';
import { backgroundSyncToJsonl } from './lib/background-operations.js';

function onWorkItemUpdated(db: WorklogDatabase): void {
  getRuntime().launchTask('auto-sync', async () => {
    await backgroundSyncToJsonl(
      db.getAll(),
      db.getAllComments(),
    );
  });
}
```

The single-flight guard ensures that rapid successive updates only trigger one
sync at a time. If a sync is already in-flight when another update fires, the
second call is silently dropped.

### Background Validation

```typescript
getRuntime().launchTask('validate-all', async () => {
  const results = await runAcceptanceCriteriaChecks(db);
  logValidationResults(results);
});
```

### Periodic Metrics Collection

```typescript
setInterval(() => {
  getRuntime().launchTask('collect-metrics', async () => {
    const metrics = await gatherMetrics(db);
    await reportMetrics(metrics);
  });
}, 60_000);
```

## Adding New Background Operations

1. Write an async function that accepts the minimal dependencies it needs.
2. Place it in `src/lib/background-operations.ts` or a dedicated module.
3. Call it via `getRuntime().launchTask('my-operation', () => myOp(...))`.
4. The runtime handles deduplication, error logging, and session shutdown.

## Testing

Tests use `vi.fn()` to create mock task functions and verify that:

- Tasks run asynchronously.
- Single-flight guards prevent duplicates.
- `awaitAll()` waits for completion.
- Errors are caught without throwing.
- The runtime can be shutdown and reinitialized.

Run the runtime tests:

```bash
npx vitest run tests/lib/runtime.test.ts
```
