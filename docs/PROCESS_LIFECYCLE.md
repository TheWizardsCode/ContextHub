# Process Lifecycle Management

## Overview

ContextHub's worktree operations (via `withTempWorktree`) spawn child processes (git commands,
CLI invocations) that can become orphaned — surviving beyond the lifecycle of the parent
worktree. The process lifecycle module (`src/process-lifecycle.ts`) provides PID tracking,
timeout enforcement, and cleanup utilities to prevent resource leaks.

## Architecture

The process lifecycle module is a **singleton** (module-level state) that manages:

- A **registry** mapping worktree paths to sets of PIDs
- A **metadata store** mapping PIDs to their worktree path and registration timestamp
- A **watchdog timer** that periodically checks for stale PIDs and kills them

### Core Data Flow

```
[Child Process Spawned]
        │
        ▼
   registerProcess(pid, worktreePath)
        │
        ▼
   [Registry: worktreePath → Set<pid>]
   [Metadata: pid → {worktreePath, registeredAt}]
        │
        ├─► killProcessesForWorktree(path, signal)
        │       └─► process.kill(-pid, signal)  [process group]
        │           └─► process.kill(pid, signal) [fallback]
        │
        ├─► killAllTracked(signal)
        │       └─► kills all tracked processes
        │
        └─► Watchdog (every 60s, default timeout 10 min)
                └─► kills PIDs exceeding timeout threshold
```

## Key Concepts

### Process Group Killing

On POSIX systems (Linux, macOS), killing with a negative PID (`process.kill(-pid)`) targets
the entire process group. This ensures that not just the parent process, but all its children
are terminated. If the process group kill fails (EPERM — no permission, or ESRCH — no process
group), the module falls back to individual `process.kill(pid)`.

### Worktree Context

The `withinWorktreeContext()` / `contextExec()` API provides a stack-based context for
transparent PID registration. When a worktree context is active, any command executed via
`contextExec()` automatically registers its child PID against that worktree.

### Watchdog Timer

The watchdog timer runs on a configurable interval (default: 60 seconds) and checks all
tracked PIDs against a configurable timeout threshold (default: 10 minutes). PIDs that
exceed the threshold are killed automatically. The timer is `unref()`'d so it does not
prevent the Node.js process from exiting.

## Exported Functions

### Registration

| Function | Description |
|----------|-------------|
| `registerProcess(pid, worktreePath)` | Register a PID against a worktree path |
| `registerCurrentProcess(worktreePath)` | Register the current Node.js PID |
| `createTrackedExec(worktreePath)` | Return a promisified `exec()` that auto-registers child PIDs |
| `detectWorktreeFromCwd(cwd?)` | Detect if a directory is inside a ContextHub worktree |

### Cleanup

| Function | Description |
|----------|-------------|
| `killProcessesForWorktree(worktreePath, signal?)` | Kill all tracked PIDs for a worktree |
| `killAllTracked(signal?)` | Kill all tracked PIDs across all worktrees |

### Context Management

| Function | Description |
|----------|-------------|
| `withinWorktreeContext(worktreePath)` | Set a worktree context (returns restore function) |
| `contextExec(command, options?)` | Execute a command in the current worktree context |

### Watchdog

| Function | Description |
|----------|-------------|
| `startWatchdog(checkIntervalMs?, timeoutMs?)` | Start/restart the watchdog timer |
| `shutdown()` | Stop the watchdog and clear all tracking state |
| `getWatchdogInterval()` | Get the current watchdog check interval |
| `getWatchdogTimeout()` | Get the current watchdog timeout threshold |
| `isWatchdogRunning()` | Check if the watchdog is active |

### Introspection

| Function | Description |
|----------|-------------|
| `getTrackedProcesses()` | Get a snapshot of all tracked processes by worktree |
| `getProcessMeta(pid)` | Get metadata (worktree, timestamp) for a specific PID |

## CLI Integration

### `wl cleanup-worktree`

Management command for process cleanup:

```bash
# Kill processes for a specific worktree
wl cleanup-worktree .worklog/worktrees/wl-ABC123

# Kill all tracked processes
wl cleanup-worktree --all

# Use SIGKILL instead of SIGTERM
wl cleanup-worktree .worklog/worktrees/wl-ABC123 --force
wl cleanup-worktree --all --force

# JSON output
wl --json cleanup-worktree .worklog/worktrees/wl-ABC123
```

### Auto-registration

When the `wl` CLI starts, it automatically registers its own PID if it detects it is
running inside a worktree directory (path contains `.worklog/worktrees/`). This ensures
the CLI process can be cleaned up when the worktree is removed.

The `execAsync` functions in `src/sync.ts` and `src/commands/sync.ts` use the context-aware
`contextExec()` function from the process lifecycle module. When called inside a worktree
context (set by `withinWorktreeContext()`), child PIDs are automatically registered.

## Integration with `withTempWorktree`

The `withTempWorktree()` function in `src/sync.ts` has been enhanced:

1. **Registration**: Before calling `run(worktreePath)`, the function sets the worktree
   context via `withinWorktreeContext(worktreePath)`. Any child processes spawned inside
   `run()` are automatically registered.

2. **Cleanup**: In the `finally` block, `killProcessesForWorktree(worktreePath)` is called
   BEFORE `git worktree remove --force`. This kills all tracked processes for the worktree
   before the directory is removed.

3. **Preservation**: Existing behavior is preserved when no processes are registered
   (no-op, no errors).

## Error Handling

All cleanup functions handle edge cases gracefully:

| Error | Handling |
|-------|----------|
| `ESRCH` (process already dead) | Silently ignored |
| `EPERM` (no permission to kill) | Silently ignored (process group → individual fallback) |
| Unknown worktree path | No-op |
| No tracked processes | No-op (registry stays empty) |
| Concurrent modification | Iterates over PID snapshots |

## Testing

Tests are in:
- `tests/process-lifecycle.test.ts` — Core module unit tests (32 tests)
- `tests/process-lifecycle-auto-register.test.ts` — Auto-registration tests (16 tests)
- `tests/sync-worktree-lifecycle.test.ts` — withTempWorktree integration tests (7 tests)
- `tests/cleanup-worktree.test.ts` — CLI command tests (9 tests)

All tests mock `process.kill` to verify the module's behavior without spawning
real child processes.
