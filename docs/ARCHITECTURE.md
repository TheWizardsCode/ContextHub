# Worklog Architecture

## Overview

Worklog uses a hybrid architecture with **SQLite as the runtime source of truth** and **Git as the persistent storage**, with JSONL serving as an ephemeral transport format for synchronization.

## Architecture Principles

### 1. SQLite = Runtime Source of Truth
- All reads and writes happen against SQLite
- SQLite provides ACID guarantees and fast queries
- Full-text search is implemented via SQLite FTS5
- No runtime dependency on JSONL files

### 2. Git = Persistent Storage
- Git repositories store the canonical data
- Enables collaboration across teams
- Provides version history and audit trail
- Branch-based workflows for data isolation

### 3. JSONL = Ephemeral Transport Format
- JSONL files exist only during sync operations
- Created on-demand for push operations (export → push → delete)
- Fetched temporarily for pull operations (fetch → import → delete)
- Never persists locally beyond the sync window (typically seconds)

## Benefits

### TUI Responsiveness
- Eliminates synchronous export operations after every write
- No more UI freezing during database operations
- Performance independent of data size

### Clean Working Directory
- No persistent JSONL files cluttering the workspace
- `grep` and search tools don't match JSONL data
- Agents and developers work with SQLite exclusively

### Data Integrity
- ACID transactions via SQLite
- Atomic Git operations for sync
- Conflict resolution during merge

## Data Flow

### Normal Operations (CLI/TUI)
```
┌─────────────┐     ┌─────────────┐
│   CLI/TUI   │────▶│   SQLite    │
└─────────────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  FTS Index  │
                    └─────────────┘
```

### Sync Operations

#### Push (export data to Git)
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   SQLite    │────▶│   JSONL     │────▶│  Git Push   │────▶│   Remote    │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │   DELETE    │
                    └─────────────┘
```

#### Pull (import data from Git)
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Remote    │────▶│  Git Fetch  │────▶│   JSONL     │────▶│   SQLite    │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                                               │
                                               ▼
                                        ┌─────────────┐
                                        │   DELETE    │
                                        └─────────────┘
```

## Migration from Persistent JSONL

### Background
Previous versions of Worklog used persistent JSONL files with an `autoExport` feature that wrote to JSONL after every database operation. This caused:
- TUI freezing due to synchronous exports
- Grep pollution from large JSONL files
- File staleness issues

### Migration Path
Users upgrading from older versions can migrate using:

```bash
# Import JSONL data into SQLite
wl migrate jsonl

# Verify migration succeeded
wl status

# Delete the old JSONL file
wl migrate jsonl --delete
```

### Backward Compatibility
- The `wl import` command still works for manual JSONL import
- The system detects existing JSONL on startup and can import if SQLite is empty
- Old `autoExport` config option is deprecated with a warning

## Implementation Details

### Database Initialization
1. Check if SQLite has data
2. If yes: Skip JSONL refresh entirely
3. If no: Check for local JSONL (legacy migration)
4. If JSONL exists: Import to SQLite, then delete JSONL

### Sync Command Flow
1. Export SQLite data to temporary JSONL
2. Acquire file lock
3. Push JSONL to Git
4. Release file lock
5. Delete local JSONL (if push succeeded)

### Error Handling
- **Offline**: Graceful error message, local data preserved
- **Merge conflicts**: Conflict resolution during sync, manual resolution guidance
- **Push failure**: JSONL retained for retry
- **Import errors**: SQLite transaction rollback

## Worklog Root Resolution

The project root that owns a `.worklog/` directory is resolved by a single
canonical function, `resolveWorklogRoot(startDir?)` in
`packages/shared/src/worklog-paths.ts` (exported as
`@worklog/shared/worklog-paths`). Both the `wl` CLI
(`resolveWorklogDir()` in `src/worklog-paths.ts`) and the herdr plugin
(`configureWorklogTarget()` in `packages/herdr/src/index.ts`) delegate to
it, so the two consumers can never disagree about what constitutes the
project root.

### Validity rule

A `.worklog/` directory is **valid** when it contains either of the markers
`wl init` writes: `config.yaml` (user config) or `initialized` (init
semaphore). A directory containing only `worklog.db` is a partial/legacy
state and is NOT valid — run `wl init` to repair it.

### Precedence order

1. **Nearest valid `.worklog/` wins** — walk up from `startDir` (default
   `process.cwd()`).
2. **Invalid `.worklog/` handling** — an existing `.worklog/` without a
   valid marker is skipped ONLY when it is a leftover worktree container
   stub (a `worktrees/` subdirectory and no markers) or the current path is
   inside a managed worktree (`.worklog/worktrees/…`). In every other case
   the invalid `.worklog/` is a boundary: the walk stops, so an unrelated
   project's `.worklog/` higher up the tree is never picked up and an
   uninitialized subdirectory never falls back to an initialized repo root.
3. **Git repo-root boundary** — the walk never passes the nearest git repo
   root (`git rev-parse --show-toplevel`, worktree-aware). The repo root's
   own `.worklog/` is checked before the boundary stops the walk. Exception:
   inside a managed worktree the walk continues past the worktree's own git
   root so the main project's `.worklog/` is found. Outside git, the walk
   continues to the filesystem root.
4. **Return `undefined`** when no valid root exists. Callers decide how to
   surface the uninitialized state: the `wl` CLI falls back to
   `<cwd>/.worklog` (it initializes on demand); the herdr plugin reports
   the uninitialized state and shows an empty worklist.

### Documented behavior change

When `cwd` has an invalid non-stub `.worklog/` and the repo root has a
valid one, resolution now stops at the invalid directory (the CLI yields
`<cwd>/.worklog`; previously it looked past to the repo root). Both
consumers agree because they share the same resolver.

## File Structure

```
.worklog/
├── worklog.db          # SQLite database (runtime source of truth)
├── worklog.lock        # File lock for concurrent access
├── config.yaml         # User configuration
├── config.defaults.yaml # Default configuration
└── initialized         # Initialization semaphore

# Note: worklog-data.jsonl is NOT here - it's ephemeral
```

## Performance Characteristics

### Read Operations
- **Speed**: Milliseconds (SQLite index lookups)
- **Scalability**: O(log n) with proper indexing
- **Consistency**: ACID transactions

### Write Operations
- **Speed**: Milliseconds (SQLite writes)
- **No export overhead**: Exports only happen during explicit sync
- **Batching**: Multiple operations in single transaction

### Sync Operations
- **Export**: ~100ms per 1000 items
- **Git push**: Depends on network (typically 1-5s)
- **Import**: ~100ms per 1000 items

## Future Considerations

### Potential Enhancements
1. **Incremental sync**: Only sync changed items
2. **Background sync**: Async sync without blocking UI
3. **Compression**: Compress JSONL for large datasets
4. **Delta encoding**: Send only diffs for efficiency

### Migration Timeline
- **Phase 1** (Complete): Remove autoExport infrastructure
- **Phase 2** (Complete): Implement ephemeral JSONL pattern
- **Phase 3** (Complete): Clean architecture and migration path

## References

- [Data Syncing Guide](../DATA_SYNCING.md)
- [CLI Reference](../CLI.md)
- [Migration Guide](./migrations.md)
