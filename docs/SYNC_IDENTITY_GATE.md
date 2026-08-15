# Sync Identity Gate & Polluted-Ref Recovery

Worklog refuses to merge commits from a remote worklog ref
(`refs/worklog/data` by default) when the incoming commits were authored by an
identity other than the store's configured identity. This document explains the
gate, how to verify it manually, and how to recover when a ref was already
polluted by a foreign writer.

Related: [Data Syncing](DATA_SYNCING.md) · [Cross-Project Pollution Cleanup](docs/CROSS_PROJECT_POLLUTION_CLEANUP.md)

## Why the gate exists

A second worklog store with an **empty git identity** (`user.email` unset) can
push divergent state to the shared `refs/worklog/data` branch: cleared fields,
stripped newlines, and demoted statuses. The primary store used to merge it
silently, re-timestamping items and invalidating already-passed audits. The
only reliable signature of that writer is the **empty author email** on its
commits (`git log --format='%ae'` → empty lines).

The identity gate stops the silent absorption: a foreign/empty-author push is
refused, surfaced to the operator, and never re-exported or pushed back.

## How the gate behaves

- Before any merge/import, `wl sync` runs
  `git log <remoteTrackingRef> --format=%h%x09%ae --not <lastSyncedRef>` and
  inspects every incoming commit's author email.
- **Empty author email** → unconditional refusal. `--allow-foreign-author`
  never bypasses this.
- **Foreign author email** (differs from the repo's `git config user.email`)
  → refused by default; allowed with `wl sync --allow-foreign-author` or
  `syncAllowForeignAuthor: true` in `.worklog/config.yaml`.
- **`user.email` unset locally** → the foreign-email comparison is skipped;
  only the empty-email gate applies.
- The last-known sync point is stored in `.worklog/last-synced-ref` after each
  successful non-dry-run sync. An absent file makes the gate scan the whole
  remote ref history.

## Manual verification (parent AC7)

Run against a ref that contains a known empty-email commit (e.g. `5fc880a` on
the llm worklog ref, or any simulated polluted ref):

```bash
wl sync --no-push
```

Expected: the sync refuses with a non-zero exit code and a clear error naming
the offending commit and the remote ref:

```
✗ Sync failed: Refusing to merge worklog data from refs/worklog/remotes/origin/worklog/data: 1 incoming commit(s) fail the author-identity gate.
- 5fc880a: empty author email
```

Verify the local database was not touched:

```bash
wl list --json          # remote items are absent
ls .worklog/last-synced-ref   # absent — the refusal never persisted a sync point
```

Verify the override paths:

```bash
# Foreign-email commit: refused by default
wl sync --no-push

# Foreign-email commit: allowed with the flag
wl sync --no-push --allow-foreign-author

# Empty-email commit: STILL refused even with the flag (gate is unconditional)
wl sync --no-push --allow-foreign-author
```

## Config flag

`syncAllowForeignAuthor` (default `false`) in `.worklog/config.yaml` (or
`.worklog/config.defaults.yaml` for team defaults) allows foreign-email
commits without a CLI flag:

```yaml
syncAllowForeignAuthor: true
```

The CLI flag `wl sync --allow-foreign-author` takes precedence over the config
value. Neither ever bypasses the empty-author-email gate.

## Recovery for a polluted ref

A ref that already contains foreign/empty-author commits must be cleaned
before the primary store can sync again. Two approaches:

### 1. `wl doctor foreign-items` (prefix pollution)

If the pollution is foreign **item prefixes** (items whose ID prefix does not
match the project), use the existing cleanup tool:

```bash
wl doctor foreign-items --dry-run   # preview
wl doctor foreign-items --apply     # remove foreign items locally
```

### 2. Rewrite the remote ref (author/identity pollution)

If the polluted ref's history carries empty/foreign-author commits but the
*snapshot content* is owned by this store, rewrite the ref so it contains only
clean, store-authored commits. This is a force-push style operation that
replaces the remote history:

```bash
# 1. Export a clean JSONL snapshot from the local DB
#    (the DB was never polluted — the gate refused the merge).

# 2. Publish the clean snapshot as a fresh orphan commit, replacing the ref.
wl doctor foreign-items --apply --push   # when the pollution is item-prefix based
```

For raw ref rewrites, the underlying helper is `rewriteAndForcePushDataFile`
(used by `wl doctor foreign-items --apply --push`): it creates an orphan
commit containing only the clean JSONL, force-pushes it to
`refs/worklog/data`, and updates the local tracking ref — it never fetches the
polluted remote first.

After the rewrite, the next `wl sync` sees only clean, own-author commits and
proceeds normally. The empty-email commits are gone from the ref, so the gate
no longer blocks.
