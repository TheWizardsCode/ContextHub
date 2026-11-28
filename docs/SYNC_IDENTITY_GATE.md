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
- **Empty author email** → unconditional refusal. No whitelist or flag ever
  bypasses this.
- **Whitelist `syncAllowedAuthors`** (new, WL-0MTGDW58X007UJDS) — the canonical
  gate setting in `.worklog/config.yaml` / `config.defaults.yaml`:
  - `[]` (default) — only the local `user.email` is allowed (strict).
  - `['a@x', 'b@y']` — `user.email` plus any listed email (case-insensitive,
    trimmed). Foreign commit allowed only if its email is in the list.
  - `null` or `true` — allow any author (allow-all, equivalent to the flag).
- **Legacy `syncAllowForeignAuthor: true`** still works as a deprecated alias
  that maps to allow-all when `syncAllowedAuthors` is absent; when
  `syncAllowedAuthors` is explicitly set it takes precedence.
- **CLI `--allow-foreign-author`** still works and overrides the config to
  allow-all for that invocation (help: `wl sync --help` explains the
  whitelist model).
- **`user.email` unset locally** → the foreign-email comparison is skipped;
  only the empty-email gate applies.
- The last-known sync point is stored in `.worklog/last-synced-ref` after each
  successful non-dry-run sync. An absent file makes the gate scan the whole
  remote ref history.

## Push-side guard (what we publish)

The identity gate above protects the **pull** side (what we merge). The
**push** side is protected by a matching guard: `wl sync` refuses to publish
worklog-data commits when the checkout's effective `git config user.email` is
empty or an **exact incident-era sentinel identity** — so a stale/misconfigured
clone can never poison `refs/worklog/data` in the first place
(WL-0MWGO58KL00187CO).

- **Sentinel set** (exact-email, trimmed/lowercased — never a wildcard or
  substring match): `t@t.com`, `t@t`, `test@test.com`, `test@test`,
  `cache test@test.com`. These are the identities behind the 2026-09-26 /
  2026-10-22 / 2026-10-23 leaked-`GIT_DIR` incidents. The TypeScript set
  (`src/sync/author-identity.ts::INCIDENT_ERA_EMAILS`) is a duplicate of the
  canonical source of truth
  `scripts/check_git_identity.py::INCIDENT_ERA_EMAILS` — keep both in sync.
- **Guard order:**
  1. **Empty `user.email`** → refuse unconditionally. No flag ever bypasses
     this (symmetry with the pull-side empty-email gate).
  2. **Exact sentinel** → refuse unless `--allow-sentinel-author`. The refusal
     is absolute: it fires even if the sentinel email somehow also equalled
     the configured identity or an allow-list entry (a state project policy
     forbids).
  3. **Otherwise** pass — any non-sentinel identity is allowed; foreign-email
     policy stays with the pull-side gate.
- **Remedy:**
  ```bash
  git config user.email you@example.com
  git config user.email            # verify
  ```
  then re-run `wl sync`.
- **Escape hatch — `--allow-sentinel-author`** (incident remediation only):
  permits a deliberate one-off push under a sentinel identity. It mirrors
  `--allow-foreign-author`: it never bypasses the empty-email refusal, never
  modifies `syncAllowedAuthors`, and the bypass is audit-logged in the sync
  output and `.worklog/logs/sync.log` (identity + flag named).
- **Why sentinels can never be allow-listed:** project policy forbids it and
  the invariant is pinned by the SorraAgents test
  `tests/test_author_gate_allowlist.py`.
  `syncAllowedAuthors` is for *real* collaborator/bot identities only.
- **Coverage:** the guard lives on the shared commit path
  (`gitPushDataFileToBranch`), so the `wl sync` push, the auto-sync/`init`
  callers and the doctor force-rewrite (`rewriteAndForcePushDataFile`, used by
  `wl doctor foreign-items --apply --push`, with **no** escape hatch) are all
  covered. It only fires when a push would actually run — `--no-push` and the
  zero-change fast path never trip it.

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

## Config — whitelist `syncAllowedAuthors`

Canonical (WL-0MTGDW58X007UJDS) — `syncAllowedAuthors` in `.worklog/config.yaml`
(or `config.defaults.yaml` for team defaults):

```yaml
# strict (default): only user.email
syncAllowedAuthors: []

# allow specific collaborators / bot
syncAllowedAuthors:
  - alice@company.com
  - ci-bot@company.com

# allow any author (e.g. shared repo)
syncAllowedAuthors: null   # or true
```

Invalid types (e.g. number, `false`, list with non-string entries) are
rejected with a clear error (`Invalid config: syncAllowedAuthors …`).

### Legacy `syncAllowForeignAuthor`

`syncAllowForeignAuthor: true` still works as a deprecated alias that maps to
allow-all when `syncAllowedAuthors` is absent. When `syncAllowedAuthors` is
explicitly set it wins. The CLI flag `wl sync --allow-foreign-author` always
wins over either config key. Nothing ever bypasses the empty-author gate.

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
