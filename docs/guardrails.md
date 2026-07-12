# Guardrails — Worklog Data Integrity Protection

The guardrails module provides protection mechanisms to prevent accidental
corruption of work item data or the worklog database by pi agent tool calls.

## Overview

Guardrails intercept tool calls made by the LLM agent and block dangerous
operations before they can damage worklog data. Two categories of protection
are provided:

1. **Path protection** — Blocks direct `write`/`edit` tool calls targeting
   the worklog database files
2. **Command protection** — Blocks dangerous shell commands that could delete
   or corrupt worklog data

## Protected Paths

The following files in the `.worklog/` directory are protected from direct
write or edit operations:

| File | Description |
|------|-------------|
| `.worklog/worklog.db` | Main SQLite database |
| `.worklog/worklog.db-wal` | SQLite write-ahead log |
| `.worklog/worklog.db-shm` | SQLite shared memory file |
| `.worklog/worklog-data.jsonl` | JSONL sync data (when present) |

Path detection works on both relative paths (e.g., `.worklog/worklog.db`)
and absolute paths (e.g., `/home/user/project/.worklog/worklog.db`).

**Why these paths are protected:**

- The SQLite database (`.worklog/worklog.db`) is the primary data store.
  Writing to it directly bypasses all business logic and validation
  in the `wl` CLI, risking data corruption.
- The WAL (`.worklog/worklog.db-wal`) and SHM (`.worklog/worklog.db-shm`)
  files are SQLite internals. Direct modification can corrupt the database
  or cause unrecoverable connection state.
- The JSONL file (`.worklog/worklog-data.jsonl`) is the sync transport
  format. Direct edits can cause merge conflicts or data loss during sync.

## Dangerous Commands

The following shell command patterns are detected and blocked:

| Pattern | Examples Blocked |
|---------|-----------------|
| `rm` targeting `.worklog/` | `rm -rf .worklog`, `rm .worklog/worklog.db` |
| `sqlite3` on worklog DB | `sqlite3 .worklog/worklog.db` |
| `mv` of `.worklog/` files | `mv .worklog /tmp/` |
| `cp` of `.worklog/` files | `cp -r .worklog /tmp/backup` |

**Safe commands that are allowed:**

- Commands that read from `.worklog/` without modifying, such as `ls .worklog`
  or `cat .worklog/config.yaml`
- All `wl` and `worklog` CLI commands — these go through proper validation
  and are the intended way to interact with worklog data
- Any command that does not explicitly target `.worklog/` paths

## Configuration

Guardrails can be enabled or disabled via the extension settings:

- **Extension settings overlay**: Use `/wl settings` in the pi TUI and
  toggle the "Data guardrails" option
- **Settings file**: Set `guardrailsEnabled` in `.pi/settings.json` under
  the `context-hub` namespace:

```json
{
  "context-hub": {
    "guardrailsEnabled": false
  }
}
```

Guardrails are **enabled by default**.

## Architecture

```
pi agent tool_call
       │
       ▼
  guardrails.ts handler
       │
       ├─► write/edit on protected path? ──► BLOCK
       │
       └─► bash with dangerous command? ──► BLOCK
                │
                ▼
          Pass through (allow)
```

The guardrails module is implemented in
`packages/tui/extensions/Worklog/lib/guardrails.ts`. It exports:

- `INSTALL_GUARDRAILS(pi, options?)` — Registers the guardrail handlers with
  a pi extension instance
- `isWorklogProtectedPath(path)` — Pure function to check if a path is
  protected (usable in tests or other contexts)
- `isDangerousWorklogCommand(command)` — Pure function to check if a shell
  command is dangerous (usable in tests or other contexts)

## Error Messages

When a guardrail blocks an operation, the agent receives a clear error
message explaining why and how to proceed:

- **Write/edit to protected path**: "Direct edits to worklog database files
  are not allowed. Use `wl` commands instead."
- **Dangerous shell command**: "This command could damage worklog data.
  Use `wl` commands instead."

## Exceptions and Limitations

1. **Guardrails do not protect against `wl` CLI misuse** — the guardrails
   only block direct file operations. Using `wl` to perform destructive
   operations (e.g., `wl delete`) is still allowed as it goes through
   proper validation.

2. **Platform-specific path handling** — Path detection normalizes
   backslashes to forward slashes, making it compatible with both Unix
   and Windows paths.

3. **Pattern matching is heuristic** — Command detection uses regex
   patterns that match common dangerous commands. Highly obfuscated
   or encoded commands may bypass detection. This is a safety net,
   not a security boundary.

4. **Configuration is extension-scoped** — The `guardrailsEnabled` setting
   is stored in the pi extension settings and applies only when the
   extension is loaded. Running the `wl` CLI directly (not via pi) does
   not have guardrail protection.

5. **Settings file access** — The guardrails module reads settings from
   `.pi/settings.json` under the `context-hub` namespace. If the settings
   file is not present, the default (`enabled: true`) is used.
