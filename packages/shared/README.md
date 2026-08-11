# @worklog/shared

Shared data access layer for the Worklog ecosystem. Provides the canonical
`WorklogDatabase` class and type definitions used by both the `wl` CLI and
the TUI extension.

## Package Structure

```
packages/shared/
  src/
    database.ts         ← WorklogDatabase class (canonical data access)
    persistent-store.ts ← SqlitePersistentStore (SQLite backend)
    types.ts            ← Shared type definitions
    status-stage-rules.ts ← Status/stage normalization rules
  dist/                 ← Compiled output
```

## Caching (Phase 5)

The `SqlitePersistentStore` includes an in-memory query cache to improve
read performance. The cache automatically invalidates on write operations.

### How it works

- **Read caching**: `getWorkItem()`, `getAllWorkItems()`, `getAllComments()`,
  `getCommentsForWorkItem()`, `countWorkItems()`, `getAllDependencyEdges()`,
  `getDependencyEdgesFrom()`, and `getDependencyEdgesTo()` all cache their
  results with a configurable TTL.
- **Cache invalidation**: Write operations (`saveWorkItem()`, `saveComment()`,
  `deleteWorkItem()`, `deleteComment()`, `saveDependencyEdge()`,
  `deleteDependencyEdge()`, `importData()`) invalidate the affected cache
  entries automatically.
- **LRU eviction**: When the cache exceeds `maxEntries` (default: 500), the
  oldest entry is evicted.

### Configuration

Pass `cacheOptions` when constructing `SqlitePersistentStore`:

```typescript
const store = new SqlitePersistentStore(dbPath, verbose, services, {
  enabled: true,        // Enable/disable caching (default: true)
  ttlMs: 5000,          // TTL in milliseconds (default: 5000)
  maxEntries: 500,      // Max cache entries before LRU eviction (default: 500)
});
```

Environment variables:
- `WL_CACHE_ENABLED` - Set to `0` to disable caching globally
- `WL_CACHE_TTL_MS` - Override the default TTL (milliseconds)

### Performance

Benchmark results (100 work items, 500 iterations):

| Operation               | Cached  | Uncached | Speedup |
|-------------------------|---------|----------|---------|
| `getWorkItem()`         | 7.9ms   | 26.2ms   | 3.3x    |
| `getAllWorkItems()`     | 0.3ms   | 49.6ms   | 168x    |
| `getCommentsForWorkItem()` | 4.2ms | 15.6ms   | 3.7x    |
| `getAllDependencyEdges()` | 0.1ms | 5.9ms    | 46.4x   |

Run the benchmark yourself:

```bash
npm run build:shared
npx tsx scripts/benchmark-caching.ts
```

## Usage (CLI)

The CLI imports the shared module through a thin re-export wrapper:

```typescript
import { WorklogDatabase } from '@worklog/shared';

const db = new WorklogDatabase('WL', './path/to/worklog.db', './path/to/data.jsonl');
```

## Usage (TUI Extension)

The TUI extension also uses the shared module directly (no CLI execFile):

```typescript
import { WorklogDatabase } from '@worklog/shared';

const db = new WorklogDatabase('WL', './path/to/worklog.db');
const items = db.getAll();
```

## Lifecycle

Always call `close()` when done to release the SQLite file handle:

```typescript
db.close();
```

The TUI extension's `closeWorklogDb()` function (in `wl-integration.ts`)
wraps this with cache cleanup.

## updatedAt preservation (no-op guards)

`updatedAt` is only bumped when a tracked field has **semantically** changed:

- `import()` (full-set replace, used by `wl sync`) and `upsertItems()`
  preserve the existing `updatedAt` when an incoming item is unchanged.
- `update()` returns early without writing (and without re-timestamping)
  when the update is a no-op.

Both paths share a single comparator, `compareTrackedFields()`, which is
**whitespace-insensitive for `title` and `description`**: leading/trailing
whitespace, trailing newlines and blank-line runs are stripped before
comparison, so whitespace-only differences (e.g. a second worklog store that
strips trailing newlines from descriptions) do NOT count as semantic changes
and never re-timestamp items (WL-0MSORD6HC005QVZX). The incoming normalized
content is still persisted — only `updatedAt` is preserved. All other fields
(tags, status, priority, …) use strict comparison; genuine content changes
still bump `updatedAt`.
