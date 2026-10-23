# Data Syncing

This document describes the two syncing workflows and how Worklog uses its local database. Together they enable shared Worklog files across a team and optional community engagement via GitHub Issues:

- Git-backed JSONL syncing (canonical data ref)
- GitHub Issues mirroring (optional)

Both workflows can be used independently. The Git-backed workflow is the canonical source of truth for Worklog data.

## Quickstart

```bash
wl sync # Sync local changes to the canonical JSONL ref
wl gh push # OPTIONAL: Mirror Worklog items to GitHub Issues
wl gh import # OPTIONAL: Pull GitHub Issue updates back into Worklog
```

## Why Worklog Uses a Local Database

Worklog keeps a local SQLite database as the runtime source of truth so reads and writes are fast and resilient even when git or GitHub are unavailable. The JSONL file is the sync boundary (import/export format) and is regenerated from the database after writes or merges. When this document says "syncing" it refers to keeping the JSONL snapshot aligned with the database and the canonical git ref, while "GitHub sync" refers to mirroring that same JSONL-backed data into GitHub Issues.

## Git-Backed Syncing (Canonical JSONL)

Worklog stores work items and comments in `.worklog/worklog-data.jsonl` (the most recent local snapshot). The authoritative, shared copy lives on a Git ref (by default `refs/worklog/data`) to avoid normal PR noise. Until you run `wl sync`, your local JSONL reflects only local changes and is not the team-wide source of truth. In fact, it is ignored by Git and is only ever shared with the team via the sync command.

### Core Commands

- `wl sync`
  - Pulls the remote JSONL ref
  - Merges with local data (conflict resolution)
  - Writes local DB + JSONL
  - Pushes the updated JSONL ref

> **Incremental sync (delta):** after the first full snapshot, `wl sync`
> pushes only the records that changed since the last successful push (a
> delta), keeping payloads proportional to the change set. The remote file
> carries a header distinguishing `full` vs `delta`; readers without a local
> base automatically fall back to a full snapshot. See
> [docs/design/incremental-sync.md](docs/design/incremental-sync.md) for the
> full architecture.

### Typical Flow

1. Update local items (`wl create`, `wl update`, etc.)
2. Run `wl sync` to publish changes
3. Teammates run `wl sync` to pull the canonical updates

### Auto-Sync

If `autoSync` is enabled, Worklog runs `wl sync` in the background after each local write (debounced). This keeps the canonical ref up to date without manual sync.
Auto-sync is off by default to avoid unexpected git operations during local edits and to let teams choose when to publish shared data.

### Auto-Sync Concurrency Guard (`wl sync --if-idle`)

Interactive UIs (Herdr worklist panes) run background auto-syncs on a timer. Multiple panes can fire syncs at the same time; without a guard they queue up waiting for the file lock, which can produce a self-sustaining "lock storm" of stuck `wl sync` processes (60+ observed).

To prevent this, auto-sync spawners pass `wl sync --if-idle`:

- If the worklog file lock is **free**, the sync runs normally.
- If the lock is **held by another sync**, `wl sync --if-idle` exits immediately with `skipped: true` (exit 0) instead of waiting up to the 30s lock timeout — so spawners skip instead of piling up.
- Stale/age-expired locks are still cleaned up before the busy check, so a dead process's lock cannot wedge sync forever.

Manual `wl sync` (without `--if-idle`) keeps the original behavior: it waits for the lock (with exponential backoff) and runs to completion.

### Concurrent Writes: Sync vs Mutating Commands

`wl sync` holds the per-store advisory file lock (`.worklog/worklog-data.jsonl.lock`, via `withFileLock` / `getLockPathForJsonl`) for its entire fetch → merge → write → push operation. The single-command mutators `wl update`, `wl comment add`, and `wl audit-set` acquire the **same** lock around their own read-modify-write, so a mutation and a sync can never interleave:

- If a mutation is in flight, `wl sync` waits for the lock instead of taking its snapshot while a write is landing.
- If a sync is in flight, a mutating command waits (bounded by the lock timeout, 30 s by default) instead of writing into the sync's read→write window.

This closes a lost-update race (WL-0MUV2U9QF002S9J1) in which a sync's stale snapshot overwrote a concurrent terminal `completed`/`in_review` transition and dropped a comment added in the window. The guarantee is **no lost update**: a mutation that commits after the sync's local read is never overwritten by the sync's write-back.

What is deliberately unchanged:

- **Intentional reopen / auto-revert still works.** A newer local `open` (including the `wl audit-set --ready-to-close no` auto-revert to `open`/`plan_complete`) still beats an older remote `completed`/`in_review` — the lock serialises the writes, it does not block the transition.
- **`wl sync --if-idle` still skips instead of queueing** when the lock is held (see above).
- **Comments remain add-only** in the merge layer.

Regression coverage: `tests/cli/sync-vs-mutation.test.ts` parks a `wl sync` inside `git fetch` and asserts that a concurrent terminal-state update and comment both survive.

### Audit Results: Newest Wins, Never Downgraded

Audit text has its own guards on top of the lock, because an audit is a single
latest-only row per work item and a revert is silent (the item's status/stage
and comments survive, so only the audit text shows the damage):

- **Merge is last-write-wins by `auditedAt`.** `mergeAuditResults` keeps the
  newest audit whichever side it came from (local wins exact ties). A stale
  local copy can no longer shadow a newer remote audit, and a stale remote
  snapshot can no longer shadow a newer local audit (SA-0MUJNFF3K009BF03).
- **Bulk persist is monotonic.** Every sync import path persists audits through
  `saveAuditResults`, which skips an incoming audit that is strictly older than
  the stored row. A snapshot that cannot represent the current audit (no
  `audit_result` record, or an older one) leaves the local audit unchanged.
- Only the explicit single-item write (`wl audit-set` → `saveAuditResult`) can
  replace a row with an older `auditedAt`.

Regression coverage: `tests/cli/sync-audit-newest-wins.test.ts` (real git,
two audits with distinct `auditedAt`) and
`tests/unit/audit-sync-monotonic.test.ts` (merge + persist guards).

### Held Claims Are Never Downgraded by a Sync

A background `wl sync` must never undo a claim. The project invariant is
*actively worked ⇒ `status: in-progress`*, and `wl sync` (including
`--if-idle` syncs from Herdr, auto-sync spawns and `skill/shared/worklog_sync.py`)
is a frequent background writer — it must not decide that an item is unclaimed.

**What counts as a held claim.** An item is claimed while either

- its `status` is `in-progress` (the implement/plan/intake claim), or
- its `assignee` is non-empty and the item is neither `completed` nor
  `deleted` (the audit tier's status-neutral `--if-assignee` hold and the
  producer scheduling hold),

**and** the claim was active within the protection window (see
`syncClaimHoldTtlHours` below). `stage` alone is never a claim.

**What the guard does.** Before persisting a pull, the sync re-reads the
store's *current* rows (bypassing the in-process query cache, so a claim
written by another process seconds ago is visible) and refuses any downgrade of
a held claim:

- the claimed `status`/`stage` **pair** is preserved — a stale remote `open` /
  `intake_complete` cannot replace `in-progress` / `plan_complete`; and
- the claim's own `updatedAt`/`activityAt` are preserved, so the losing stale
  row is never re-stamped as the newest row by `import()` / `upsertItems()`
  (that re-stamp is what made a reverted claim stick permanently).

**What it deliberately does not do.**

- It is not "last writer wins on status": a newer, *more active* transition
  still propagates (`in-progress → completed`, `→ in_review`, a close, an
  audit demotion of a completed item, a reassignment).
- It does not freeze any fieldset: only `status`/`stage` (and the claim's
  timestamps) are pinned; every other field still resolves by timestamp, so a
  newer title/priority/description change from another store still lands.
- It never blocks an **attributed delete** (`deletedBy`/`deleteReason`) —
  deletion is terminal intent and keeps propagating
  (WL-0MSKZ30SK007K9TO).
- It is **time-bounded**: an abandoned claim older than the TTL is released and
  newer-wins applies again.

**Diagnostics.** Every refusal is written to the sync log
(`~/.worklog/logs/sync.log`) and to the `--json` output as
`sync.claimHolds[]` (work item id, the preserved and attempted pairs, which
fields were pinned, the claim age and the configured TTL), and the sync's store
identity is reported as `sync.store` — so the next recurrence is diagnosable
without source archaeology.

Regression coverage: `tests/cli/sync-claim-revert.test.ts` (a claim landing
during a parked sync; a stale second store pushing a newer downgrade) and
`tests/unit/claim-hold.test.ts` (the pure decision rules, including TTL expiry
and the attributed-delete exemption).

### One Store Per Repository (Worktrees)

`.worklog/config.yaml` is tracked in git (`.gitignore` re-includes it), so every
`git worktree add` — in particular each implement/audit worktree under
`.worklog/worktrees/<name>` — checks out a `.worklog/` directory that holds
configuration but **no store**.

`wl` binds to the main checkout's store in that situation, never to the
worktree:

- a worktree `.worklog/` is used only when it is a *genuine* store (created by
  `wl init`: an `initialized` marker and/or `worklog.db`);
- otherwise the command binds to the main checkout's `.worklog/`;
- when neither exists, the command **fails with an actionable error** telling
  you to run `wl init` in the main checkout or pass `--worklog-dir` explicitly.

This matters because two stores for one project prefix do not serialise: the
mutation lock (`<data-file>.lock`) and the `last-synced-ref` watermark are both
derived from the data path, so two roots hold *different* locks and *different*
watermarks while pushing to the *same* worklog ref. A sync detects and reports
that condition (`sync.store.secondStore` in `--json`, plus a warning in the sync
log) instead of silently crossing the two stores.

**Agent guidance:** when running `wl` from inside a worktree, pass
`--worklog-dir <main-checkout>/.worklog` (the implement skill already does).

### Config Options

Set in `.worklog/config.yaml` (local) or `.worklog/config.defaults.yaml` (team defaults):

- `autoSync` (boolean, default false)
  - Auto-push changes to the canonical Git ref after local writes
- `syncRemote` (string, default `origin`)
  - Git remote used for sync
- `syncBranch` (string, default `refs/worklog/data`)
  - Git ref used for the canonical JSONL file
- `syncClaimHoldTtlHours` (number, default `24`; also accepted as the nested
  `sync.claimHoldTtlHours`)
  - How long a held claim is protected from being downgraded by a sync, in
    hours. Covers an 8-hour drive run with headroom. `0` disables the
    protection (newer-wins everywhere). See
    [Held Claims Are Never Downgraded by a Sync](#held-claims-are-never-downgraded-by-a-sync).
- `syncAllowedAuthors` (allow-list, default `[]`)
  - Emails allowed to merge during `wl sync` besides the local `user.email`.
    `[]` = only `user.email`; `['a@x','b@y']` = plus listed emails
    (case-insensitive, trimmed); `null`/`true` = allow any author.
    See [Author-Identity Gate](#author-identity-gate). Empty-author commits
    are always refused. CLI flag `wl sync --allow-foreign-author` overrides
    to allow-all. Legacy `syncAllowForeignAuthor: true` still works as a
    deprecated alias when `syncAllowedAuthors` is absent.

### Author-Identity Gate

Before importing anything, `wl sync` inspects the author emails of the commits
on the remote worklog ref since the last-known sync point
(`git log <remoteTrackingRef> --format=%h%x09%ae --not <lastSyncedRef>`). If any
incoming commit fails the gate, the sync refuses with a non-zero exit code, a
clear error naming the offending commit(s) and the remote ref, and leaves the
local database untouched:

- **Empty author email** → unconditional refusal. A commit with no author email
  (e.g. a store whose git `user.email` is unset) is never merged, even with
  `--allow-foreign-author`.
- **Foreign author email** → refused by default when it differs from the repo's
  configured `user.email` and is not in `syncAllowedAuthors`; allowed when
  the email is in the whitelist, `syncAllowedAuthors` is `null`/`true`,
  `wl sync --allow-foreign-author` is passed, or legacy
  `syncAllowForeignAuthor: true` is set (allow-all fallback when whitelist absent).
- **`user.email` unset** → the foreign-email comparison is skipped (only the
  empty-email gate applies).

Example refusal:

```
✗ Sync failed: Refusing to merge worklog data from refs/worklog/remotes/origin/worklog/data: 1 incoming commit(s) fail the author-identity gate.
- 5fc880a: empty author email
```

The gate exists because a second worklog store with an empty/foreign git
identity can silently overwrite work items and invalidate audits (see
[Refused Sync / Polluted Ref Recovery](docs/SYNC_IDENTITY_GATE.md)). The
last-known sync point is persisted in `.worklog/last-synced-ref` after each
successful non-dry-run sync; when the file is absent, the whole remote ref
history is scanned.

### Troubleshooting

- If `wl sync` shows no updates but you expected changes, confirm your local JSONL is up to date and the correct ref is used.
- If you want to preview a sync without changes, use `wl sync --dry-run`.

## GitHub Issues Mirroring (Optional)

Worklog can mirror items to GitHub Issues and import updates back. This GitHub sync reads from the local JSONL/database and updates Issues; it is separate from the git-backed JSONL sync above.

### Core Commands

- `wl github push` (alias: `wl gh push`)
  - Pushes local Worklog items to GitHub Issues
  - Adds/updates issue titles, bodies, and labels
  - Ensures a `<!-- worklog:id=... -->` marker in the body
  - Links parent/child items using GitHub sub-issues (when enabled)

- `wl github import` (alias: `wl gh import`)
  - Imports changes from GitHub Issues into Worklog
  - Updates existing Worklog items with GitHub changes
  - Optionally creates new Worklog items for unmarked issues
  - Pulls parent/child relationships from GitHub sub-issues

### Status Label Behavior

Worklog uses `wl:status:<status>` labels to represent status. Only one status label is kept on an issue at a time.

### Field Label Mapping

Worklog syncs work item fields to GitHub as labels with the configured prefix (default `wl:`):

- **Status**: `wl:status:<status>` (e.g., `wl:status:open`, `wl:status:in-progress`)
- **Priority**: `wl:priority:<priority>` (e.g., `wl:priority:high`, `wl:priority:medium`)
- **Risk**: `wl:risk:<level>` (e.g., `wl:risk:High`, `wl:risk:Medium`, `wl:risk:Low`, `wl:risk:Severe`)
- **Effort**: `wl:effort:<level>` (e.g., `wl:effort:XS`, `wl:effort:S`, `wl:effort:M`, `wl:effort:L`, `wl:effort:XL`)
- **Stage**: `wl:stage:<stage>` (if set)
- **Issue Type**: `wl:type:<issueType>` (if set)
- **Tags**: `wl:tag:<tag>` for each tag

### Hierarchy (Parent/Child)

- Worklog uses GitHub's sub-issue relationships to keep parent/child structure in sync.
- On `wl gh push`, parent/child links are created or verified via the GitHub GraphQL API.
- On `wl gh import`, parent/child links are read from GitHub and mapped to Worklog `parentId` values.

### Closed Issues

- Worklog does not create new items from closed issues.
- If an existing mapped GitHub issue is closed, Worklog marks the corresponding item as `completed`.

### Config Options

Set in `.worklog/config.yaml` (local) or `.worklog/config.defaults.yaml` (team defaults):

- `githubRepo` (string, e.g. `owner/name`)
  - Repo used for GitHub mirroring
- `githubLabelPrefix` (string, default `wl:`)
  - Prefix for Worklog labels
- `githubImportCreateNew` (boolean, default true)
  - When true, `wl github import` creates Worklog items from unmarked issues

### Recommended Flow

1. Ensure canonical JSONL is up to date: `wl sync`
2. Push to GitHub Issues: `wl gh push`
3. Later, import GitHub updates: `wl gh import`

### Troubleshooting

- If `wl gh push` reports errors, re-run with `--json` for detailed failures.
- If the GitHub CLI is older, label creation uses `gh api` or `gh issue label create`.

## Examples

```bash
# Sync Worklog JSONL with git
wl sync

# Push Worklog items to GitHub Issues
wl gh push

# Import GitHub Issue updates
wl gh import

# Import only issues updated since a timestamp
wl gh import --since 2024-01-01T00:00:00Z
```
