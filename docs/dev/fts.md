# FTS Search — Index Freshness & Query-Syntax Handling

Worklog uses SQLite's FTS5 for full-text search over work items (title,
description, comments, tags). This document covers two behaviors that make
search reliable in practice:

1. **Index freshness** — the FTS index is kept current on every write path, so
   `wl search` never returns silently stale results.
2. **Query-syntax errors** — unquoted punctuated terms are auto-quoted with a
   visible warning; genuinely invalid queries surface as errors (never a silent
   empty result).

## How search works

- `WorklogDatabase.search()` (in `packages/shared/src/database.ts`) merges
  ID-aware matches with FTS5 results (`SqlitePersistentStore.searchFts()`)
  and dedupes them.
- When FTS5 is unavailable, it falls back to application-level `searchFallback()`.
- The FTS table (`worklog_fts`) is a content table — each row embeds the item's
  title, description, comments, tags, status, and parent id, so the row for an
  item must be rewritten whenever any of those fields changes.

## Index freshness (save paths wired to `upsertFtsEntry`)

Every path that mutates items or comments updates the FTS index:

| Operation | FTS behavior |
|---|---|
| `create()` / `update()` | `upsertFtsEntry(item)` after save |
| `delete()` (soft) | `deleteFtsEntry(id)` |
| `import()` (bulk replace) | clears FTS via `clearWorkItems()`, then re-upserts every item |
| `upsertItems()` (incremental sync) | `upsertFtsEntry` per saved item |
| `reconcile*` (blocked/unblocked status changes) | `upsertFtsEntry` after status save |
| `createComment()` / `updateComment()` / `deleteComment()` | re-upserts the parent item (comment text lives in the parent's FTS row) |
| `importComments()` / `upsertComments()` (batch) | re-indexes all affected items |
| `clearWorkItems()` / `clearComments()` (used by `import`) | also `DELETE FROM worklog_fts` so stale rows are never left behind |

Consequences:

- `wl create` + `wl comment add` → both title and comment text are searchable
  immediately, no `--rebuild-index` needed.
- Deleting an item or comment removes it from subsequent search results.
- `wl search --rebuild-index` remains the manual backstop for bulk migrations
  (e.g. repairing a pre-existing index).

## Query-syntax handling

FTS5 rejects certain unquoted inputs — version strings (`v0.1.11`), file paths
(`src/lib/util.ts`), and IDs are common examples (`fts5: syntax error near "."`).
The old behavior swallowed these errors and returned `[]`, making "no matches"
indistinguishable from "invalid query".

New behavior in `searchFts` → `WorklogDatabase.search()` → `wl search`:

1. If the raw query throws an FTS5 error, the query is **retried as a quoted
   phrase** (`"…"`, with embedded quotes escaped as `""`).
2. If the retry succeeds, results are returned normally and a **warning** is
   emitted: `query "…" was auto-quoted as a phrase…` (printed with
   `Warning: …` in human mode; included as a `warning` field in `--json`).
3. If the retry also fails (rare — e.g. a null byte in the query), the error is
   **surfaced**: `wl search` exits non-zero with
   `Invalid search query: invalid query syntax: "…" — quote phrases or punctuated terms. …`.
4. Genuinely zero-match queries return `No results found.` with no warning.

### Quoting hygiene for users

- Search a literal punctuated phrase by quoting it: `wl search "v0.1.11"`.
- Search a file path as a phrase: `wl search "src/lib/util.ts"`.
- FTS5 phrase/prefix/boolean operators still work as before:
  `"closed with reason"`, `perf*`, `bug OR regression`, `-duplicate`.

## Tests

- `tests/fts-freshness.test.ts` — unit coverage for import/upsert/reconcile/
  comment freshness, delete removal, and the auto-quote/error-surfacing paths.
- `tests/cli/search-fts-freshness.test.ts` — end-to-end `wl search` coverage
  (fresh index for created/imported items; auto-quote warning in human and JSON
  output; no warning for quoted phrases or genuine empty results).
- `tests/fts-search.test.ts`, `tests/database.test.ts` — regression suites.