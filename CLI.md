# Worklog CLI Reference (wl / worklog / wf)

This document describes the Worklog CLI commands and includes examples. Plugin commands can be added at runtime; to see any plugins available in your environment run `wl --help` (or `worklog --help` or `wf --help`). The layout follows the grouped output produced by `wl --help` so entries match the CLI ordering.

## Global options

These options apply to any command:

- `-V, --version` — Print the CLI version.
- `--json` — Produce machine-readable JSON output instead of human text.
- `--verbose` — Enable verbose output (extra timing / debug info where supported).
- `-F, --format <format>` — Choose human display format: `full` (default), `summary`, `concise`, `normal`, `raw`, `markdown`, `text`/`plain`, or `auto`.
- `-w, --watch [seconds]` — Rerun the command every N seconds (default: 5).


### GitHub throttling (environment variables)

Worklog includes a central client-side throttler to coordinate outgoing GitHub API
requests. Configure the throttler at runtime with environment variables (see
`docs/github-throttling.md` for details and examples):

- `WL_GITHUB_RATE` — tokens per second (default: 6)
- `WL_GITHUB_BURST` — bucket capacity (default: 12)
- `WL_GITHUB_CONCURRENCY` — max concurrent scheduled tasks (default: 6)

See `docs/github-throttling.md` for examples and testing guidance.


### Markdown formatting (--format and config)

CLI output can be rendered through the project's markdown renderer. This formats:

- Headers (`#`, `##`) → bold white text
- Inline code (`code`) → magenta text
- Code fences (```) → cyan labeled code blocks
- Lists (`-` or `*`) → bullet points
- Links → underlined blue text with URL shown

#### Precedence

Markdown rendering is controlled by three levels, in priority order:

1. **CLI flag** `--format <value>` — highest priority
   - `markdown` → force markdown rendering on
   - `plain` or `text` → force rendering off (plain text)
   - `auto` → auto-detect based on TTY (default)
2. **Config key** `cliFormatMarkdown: true|false` in `.worklog/config.yaml`
3. **Auto-detect** (default) — enabled in TTY, disabled in non-TTY/CI

> **Note:** `--format auto` explicitly uses TTY detection and **does not** fall through
to the `cliFormatMarkdown` config key. This means `wl show --format auto` in
non-TTY will always produce plain output, even if `cliFormatMarkdown: true` is
set in config. Use `--format markdown` to force markdown on regardless of TTY.

#### Examples

```sh
# Default in TTY: markdown formatted
wl show WL-123

# Opt out: plain text
wl show WL-123 --format text
wl show WL-123 --format plain

# Explicit: markdown (useful in non-TTY/pipe)
wl show WL-123 -F markdown

# Auto-detect (based on TTY)
wl show WL-123 -F auto
```

#### Config file

Set `cliFormatMarkdown` in `.worklog/config.yaml` to control default behaviour:

```yaml
projectName: MyProject
prefix: MYPROJ
cliFormatMarkdown: true   # always render markdown in CLI output
# or
cliFormatMarkdown: false  # never render markdown
```

#### CI / Size Guard

Auto-disabled in non-TTY (CI/logs) for safe plain-text output. Size guard (default 100KB)
falls back to plain text for large content. CLI flag and config override auto-detect when needed.


These flags control overall CLI behavior: output format (JSON vs human), verbosity for debugging, the display format for human-readable commands, and auto-refresh via watch mode. Use `--json` for automation and `--format` when you need more or less detail in terminal output.


---

## Issue Management

Issue Management commands let you create, update, delete, comment on, and close work items. Use these for day-to-day work item lifecycle tasks: creating new tasks or bugs, recording progress, adding notes, and closing completed work.

### `create` [options]

Create a new work item.

Options:

- `-t, --title <title>` (required) — Title of the work item.
- `-d, --description <description>` — Description text (optional; defaults to empty).
- `--description-file <file>` — Read description from a file (optional).
- `-s, --status <status>` — Status value from config defaults (optional; default: `open`).
- `-p, --priority <priority>` — `low|medium|high|critical` (optional; default: `medium`).
- `-P, --parent <parentId>` — Parent work item ID (optional).
- `--tags <tags>` — Comma-separated tags (optional).
- `-a, --assignee <assignee>` — Assignee name (optional).
- `--stage <stage>` — Stage value from config defaults (optional).
- `--risk <risk>` — Risk level: `Low|Medium|High|Severe` (optional; no default).
- `--effort <effort>` — Effort level: `XS|S|M|L|XL` (optional; no default).
- `--issue-type <issueType>` — Interoperability: issue type (optional).
- `--created-by <createdBy>` — Interoperability: created by (optional).
- `--deleted-by <deletedBy>` — Interoperability: deleted by (optional).
- `--delete-reason <deleteReason>` — Interoperability: delete reason (optional).
- `--needs-producer-review <true|false>` — Set needsProducerReview flag (true|false|yes|no) (optional).
- `--audit-text <text>` — Set structured audit text when creating an item. The audit result is stored in the `audit_results` table (the sole source of truth for audit state). Prefer `--audit-file` for file-based input to avoid shell-escaping issues (see docs/AUDIT_STATUS.md).
- `--audit-file <file>` — Read audit text from a file (recommended for large or shell-sensitive content).
- `--prefix <prefix>` — Override default ID prefix (repo-local scope) (optional).
- `--json` — Output JSON (optional).

Examples:

```sh
wl create -t "Fix login bug"
wl create -t "Add telemetry" -d "Add event for signup" -p high -a alice --tags telemetry,signup
wl create -t "High-risk task" --risk High --effort M
wl --json create -t "Investigate CI flakes" -d "Flaky tests seen" -p high
```

Notes:

- Status and stage values are configured in `.worklog/config.defaults.yaml` under `statuses` and `stages`.

Automatic re-sort:

- By default, when `wl create` sets any of the qualifying fields (`status`, `priority`, `risk`, `effort`, or `stage`), Worklog will automatically invoke a background re-sort so `sort_index` ordering reflects the new item scoring. This keeps `wl next` recommendations up-to-date without requiring a manual `wl re-sort`.
- Pass `--no-re-sort` to suppress the automatic re-sort for callers that do not want sorting to change as part of the create operation.
- Pass `--re-sort-sync` to force a synchronous (blocking) re-sort when immediate ordering is required.

### `update` [options] <id...>

Update fields on one or more existing work items. Accepts multiple IDs. Options mirror `create` for updatable fields, plus `--description-file <file>` (read description from a file), `--audit-text <text>` and `--audit-file <file>` (read audit text from a file; writes to the `audit_results` table), `--needs-producer-review <true|false>` (set needsProducerReview flag), and `--do-not-delegate <true|false>` (set or clear the do-not-delegate tag).

Automatic re-sort:

- `wl update` will automatically invoke a re-sort when one or more updated fields are among: `status`, `priority`, `risk`, `effort`, or `stage`. By default this re-sort runs asynchronously so the CLI is not blocked. This helps `wl next` and other selection-based commands reflect recent priority or status changes without requiring a manual `wl re-sort`.
- Use `--no-re-sort` to suppress the automatic re-sort for updates.
- Use `--re-sort-sync` to force the re-sort to run synchronously (blocking) when callers need immediate ordering guarantees.

Example:

```sh
wl update WL-ABC123 -t "New title" -p low
wl update WL-ABC123 -s in-progress -a "bob"
wl update WL-ABC123 --risk High --effort XS
```

New: toggle the do-not-delegate tag (prevents automation from auto-assigning the item):

```sh
wl update WL-ABC123 --do-not-delegate true   # add tag
wl update WL-ABC123 --do-not-delegate false  # remove tag
```

### `reviewed` <id> [value]

Toggle or set the `needsProducerReview` flag on a work item. If `value` is omitted, it toggles the current value.

Options:

- `--prefix <prefix>` — Operate on a specific prefix (optional).

Examples:

```sh
wl reviewed WL-ABC123           # toggle flag
wl reviewed WL-ABC123 true      # set to true
wl reviewed WL-ABC123 false     # set to false
wl --json reviewed WL-ABC123    # JSON output with updated work item
```

### `audit` [options] <id>

Run an OpenCode audit flow for a specific work item and print the resulting audit text.

Behavior:

- Requires an explicit work item id.
- Invokes OpenCode with the prompt `audit <id>`.
- On success, prints:

```text
Audit complete:

<audit-text>
```

- Returns non-zero on failures (for example: timeout, parse failure, missing work item, or OpenCode process errors).

Options:

- `--prefix <prefix>` — Override default ID prefix (optional).

Examples:

```sh
wl audit WL-ABC123
wl --json audit WL-ABC123
wl audit WL-ABC123 --prefix WL
```

### `audit-show` [options] <id>

Show the latest audit result for a work item from the `audit_results` table (the sole source of truth for audit state).

Behavior:

- Requires an explicit work item id.
- Returns the most recent audit record from the `audit_results` table.
- In `--json` mode, returns structured output with `workItemId`, `readyToClose`, `auditedAt`, `summary`, `rawOutput`, and `author`.
- If no audit result exists for the work item, prints `No audit result for <id>` (human) or `{ success: true, audit: null }` (JSON).

Options:

- `--prefix <prefix>` — Override default ID prefix (optional).
- `--json` — Output in JSON format.

Examples:

```sh
wl audit-show WL-ABC123
wl audit-show WL-ABC123 --json
wl audit-show WL-ABC123 --prefix WL
```

### `audit-set` [options] <id>

Set or update the audit result for a work item in the `audit_results` table.

Behavior:

- Requires an explicit work item id and `--ready-to-close`.
- `--ready-to-close` accepts `yes` or `no`.
- Uses INSERT OR REPLACE to maintain latest-only audit state.
- Automatically sets `audited_at` to the current ISO 8601 timestamp.
- Derives `author` from `WL_USER` / `USER` / `USERNAME` environment variables unless overridden by `--author`.

Options:

- `--ready-to-close <yes|no>` — Whether the work item is ready to close (required).
- `--summary <text>` — Human-readable summary of the audit.
- `--raw-output <text>` — Machine-readable raw output from the audit tool.
- `--audit-file <file>` — Read audit raw output from a file (takes precedence over `--raw-output`).
- `--author <author>` — Author of the audit (defaults to current user).
- `--prefix <prefix>` — Override default ID prefix (optional).
- `--json` — Output in JSON format.

Examples:

```sh
wl audit-set WL-ABC123 --ready-to-close yes --summary "All criteria met"
wl audit-set WL-ABC123 --ready-to-close no --summary "Outstanding work items" --json
wl audit-set WL-ABC123 --ready-to-close yes --author "bot" --raw-output "..."
wl audit-set WL-ABC123 --ready-to-close yes --audit-file report.md --summary "From file"
```

### `delete` [options] <id>

Delete a work item (marks as deleted): this sets the work item status to `deleted` in the local database. If you prefer to set the status explicitly, use `wl update <id> -s deleted` instead.

Options:

- `--prefix <prefix>` — Operate on a specific prefix (optional).

Examples:

```sh
wl delete WL-ABC123            # permanently removes the item and its comments
wl --json delete WL-ABC123     # machine-readable confirmation (204 on success)
```

### `comment` (subcommands)

Manage comments attached to work items. Use `wl comment <subcommand>`.

Subcommands:

- `create|add <workItemId>` — Create a comment. Required: `-a, --author`, `-c, --comment`. Optional: `--body <body>` (alias for `--comment`), `-r, --references <references>` (comma-separated list of references: work item IDs, file paths, or URLs).
- `list <workItemId>` — List comments for a work item.
- `show <commentId>` — Show a single comment.
- `update <commentId>` — Update a comment's fields. Options: `-c, --comment`, `-a, --author`, `-r, --references`.
- `delete <commentId>` — Delete a comment.

Examples:

```sh
wl comment create WL-ABC123 -a alice -c "I narrowed this down to the auth layer."
wl comment add WL-ABC123 -a alice --body "Using the add alias."
wl comment create WL-ABC123 -a alice -c "See related" -r "WL-DEF456,src/auth.ts"
wl comment list WL-ABC123
wl comment show CMT-0001
wl comment update CMT-0001 -c "Updated content" -a alice
wl comment delete CMT-0001
```

### `close` [options] <ids...>

Close one or more work items and optionally record a close reason as a comment.

**Recursive close (audit-gated):** If the item is in the `in_review` stage and has an
associated audit result with `readyToClose: true`, the command recursively closes all
descendants (children, grandchildren, etc.) before closing the parent. The descendants
are closed deepest-first so that leaf items are completed before their parents.

- If a child cannot be closed, the operation continues processing remaining children
  and reports the errors at the end without aborting the entire command.
- For items that do not meet the recursive condition (not `in_review`, no audit, or
  `readyToClose` is `false`), only the specified item is closed (current behaviour).
  **A warning is printed on stderr** when the item has children, alerting the user
  that those children will be left behind and explaining why:
  ```
  Warning: WL-PARENT has 3 open children that will not be closed because the parent is not in the 'in_review' stage. Use `wl close --force WL-PARENT` to close them unconditionally.
  ```
  The reason reflects the first blocking condition encountered (in priority order):
  - "the parent is not in the 'in_review' stage"
  - "the parent has no audit result"
  - "the audit result is not ready to close"
- The `--force` flag unconditionally closes all descendants and then the parent,
  bypassing the audit/stage checks. For items without children, `--force` behaves
  identically to a standard close.

**Output format (recursive close):** When the audit-gated recursive close path is triggered:

- **Human-readable output** reports the count of successfully closed descendants:
  `Closed WL-PARENT (N children closed)`
- If any descendant could not be closed, a per-child warning is printed on stderr:
  ```
  Closed WL-PARENT (N children closed)
  Child WL-CHILD4: Failed to close descendant — this item remains unclosed at top level
  ```
- **JSON output** includes a `childrenClosed` integer field in each result object,
  representing the number of successfully closed descendants. If any descendant
  failed to close, the existing `childErrors` array is populated and `success` remains
  `true` (backward-compatible).

**Automatic unblocking:** When a work item is closed, any dependents that were blocked
solely by this item are automatically unblocked (their status changes from `blocked` to
`open`). If a dependent has multiple blockers and other blockers remain active, it stays
blocked. This behaviour is identical in both the CLI and TUI — both paths use the shared
`reconcileDependentsForTarget()` service in the database layer.

Options:

`-r, --reason <reason>` — Reason text stored as a comment (optional).
`-a, --author <author>` — Author for the close comment (optional; default: `worklog`).
`--prefix <prefix>` — Operate within a specific prefix (optional).
`--force` — Close the item and all its descendants unconditionally, bypassing the
  audit/stage checks. For items without children, this is equivalent to a standard close.

Examples:

```sh
wl close WL-ABC123 -r "Resolved by PR #42" -a alice
wl close WL-ABC123 WL-DEF456 -r "Cleanup after release"

# Close a parent and all its children (when parent is in_review with audit readyToClose=true)
wl close WL-PARENT -r "All subtasks completed and audited OK"

# Close a parent and all its children unconditionally (bypasses audit/stage checks)
wl close --force WL-PARENT -r "Completed with all subtasks"
```

### `dep` (subcommands)

Manage dependency edges attached to work items. Use `wl dep <subcommand>`.

Notes:

- Prefer dependency edges for new work; they are the recommended way to track blockers.

Subcommands:

- `add <itemId> <dependsOnId>` — Create a dependency where `itemId` depends on `dependsOnId`.
- `rm <itemId> <dependsOnId>` — Remove a dependency where `itemId` depends on `dependsOnId`.
- `list <itemId>` — Show inbound and outbound dependencies for `itemId`.

Behavior:

- `dep add` errors if either work item does not exist.
- `dep add` errors if the dependency already exists.
- `dep add` automatically sets `itemId` status to `blocked` when the dependency is active (i.e. `dependsOnId` is not completed or deleted).
- `dep rm` warns and exits 0 when ids are missing.
- `dep list` warns and exits 0 when ids are missing.
- `dep list --outgoing` shows only outbound dependencies.
- `dep list --incoming` shows only inbound dependencies.

**Automatic unblocking:** Dependents are automatically unblocked when all their blockers
become inactive (completed, deleted, or moved to a non-blocking stage such as `in_review`
or `done`). This reconciliation happens via `db.update()` and
`db.delete()` — any status or stage change triggers the reconciliation logic. See
[Dependency Reconciliation](docs/dependency-reconciliation.md) for developer details.

Examples:

```sh
wl dep add WL-ABC123 WL-DEF456
wl dep rm WL-ABC123 WL-DEF456
wl dep list WL-ABC123
wl --json dep add WL-ABC123 WL-DEF456
```

---

## Status

Status commands help you inspect and discover work: listing items, viewing details, finding the next thing to work on, and seeing recent or in-progress items. Use these when triaging, planning a day, or preparing handoffs.

### `show` [options] <id>

Show details for a single work item.

Options:

`-c, --children` — Also display descendants in a tree layout (optional).
`--prefix <prefix>` (optional)
`--no-icons` — Disable icon rendering for clean text output. When icons are disabled, priority and status display as plain text (e.g., `[CRIT]`, `[OPEN]`) instead of emoji. This is useful for scripting or copy-paste operations.

The output always includes `Risk` and `Effort` fields. When a field has no value a placeholder `—` is shown so the field is consistently visible for triage and prioritization.

Examples:

```sh
wl show WL-ABC123
wl --json show WL-ABC123
wl show WL-ABC123 -c
```

### `next` [options]

Suggest the next work item(s) to work on. Non-actionable items (deleted, completed, in-review, in-progress, dependency-blocked) are excluded by default.

#### Hierarchy-aware selection

`wl next` is strictly root-only: it returns **parent items** only and never returns an item with a `parentId` set. For example, if an epic has open child tasks, `wl next` returns the epic itself — never one of its children. This surfaces the high-level unit of work for you to claim, after which you can work on its sub-tasks (reachable via `wl list --parent <id>` or drill-down in the TUIs).

Leaf items (items without children, or whose children are all completed) continue to be returned normally. **Orphan promotion is removed** — children whose parent is completed, deleted, or otherwise absent from the candidate pool are hidden entirely and are NOT promoted to root level. Such children remain reachable via `wl list --parent <id>`, `wl show`, and search.

Items whose parent (or ancestor) has status `in-progress` are **not** returned — the entire in-progress subtree is skipped from `wl next` recommendations. This includes critical-priority children.

In blocker-surfacing and critical-escalation paths, child blockers are never returned directly: a child blocker whose parent is a selectable actionable root is surfaced as that parent instead, and a child blocker whose parent is not selectable is hidden entirely (returning null with a clear reason when no other work is available).

In batch mode (`-n <count>`), children of returned parents are also excluded from subsequent results, ensuring the batch never contains items from the same subtree.

#### Automatic re-sort

By default, `wl next` re-sorts all active items by score before selecting candidates. This ensures that recently created or re-prioritized items are immediately reflected in the selection order without requiring a manual `wl re-sort`. The re-sort uses the same scoring logic as `wl re-sort` (priority weight, age, and optional recency policy).

Pass `--no-re-sort` to skip the automatic re-sort and preserve the current `sort_index` order. This is useful when you have manually adjusted `sort_index` values and want to preserve that ordering.

The `--recency-policy` flag controls how recently updated items are weighted during the re-sort step. The default is `ignore` (no recency bias).

#### Ranking precedence

When multiple candidate items exist, `wl next` ranks them using the following criteria (highest weight first):

1. **Priority** — higher-priority items always rank above lower-priority items.
2. **Blocks high-priority work** — among equal-priority candidates, an item that is a prerequisite for a `high` or `critical` downstream item is preferred. This ensures that unblocking high-value work takes precedence over unrelated tasks at the same priority.
3. **Blocked penalty** — items with active dependency blockers are excluded by default (see `--include-blocked`).
4. **Tie-breakers** — sort_index, then age (older items first) break remaining ties.

Items with `status: 'blocked'` that have `critical` priority trigger a special escalation path: their direct blockers are surfaced immediately, bypassing the general ranking logic. Blocked `critical` items that are children of an open parent are still escalated — the parent item's blockers will be surfaced if the critical child is in its tree. Child blockers are never returned directly (see "Hierarchy-aware selection" above).

#### Backward compatibility

The `--include-blocked` flag behavior is unchanged. The ranking boost only affects ordering among candidates that are already considered (i.e., unblocked items by default).

The JSON output schema is unchanged — only the selection behavior differs: only root items (parents) are now returned instead of children.

Options:

`-a, --assignee <assignee>` (optional)
`--stage <stage>` — Filter by stage: `idea`, `intake_complete`, `plan_complete`, `in_progress`, `in_review`, `done` (optional).
`--search <term>` (optional)
`-n, --number <n>` — Number of items to return (optional; default: `1`).
`-g, --groups <n>` — Number of parallel-safe groups to identify (optional; default: `3`). Only meaningful when `-n > 1`. Groups items by priority, stage and file-path conflicts extracted from their descriptions, placing items that affect different files in the same group and conflicting items in separate groups. Items with priority `critical` are partitioned into `Critical Group N` file-path conflict groups at the top. Items with unknown/other stages are grouped together in a single "Other" group. See "Parallel-safe grouping" below.
`--include-blocked` — Include dependency-blocked items (excluded by default).
`--no-re-sort` — Skip automatic re-sort before selection, preserving current `sort_index` order (optional).
`--re-sort-sync` — Force a synchronous (blocking) re-sort when automatic re-sort is triggered. By default automatic re-sorts are run asynchronously to avoid blocking interactive commands.
`--recency-policy <policy>` — Recency handling for the re-sort step: `prefer`, `avoid`, or `ignore` (optional; default: `ignore`).
`--prefix <prefix>` (optional)

#### JSON output (`--json`)

When using `--json` mode with a single item result, the output contains:

- `success` (boolean)
- `workItem` (object) — the work item fields including:
  - Standard fields: `id`, `title`, `description`, `status`, `priority`, `sortIndex`, `createdAt`, `updatedAt`, `tags`, `assignee`, `stage`, `parentId`, etc.
  - `auditResult` — the audit readiness value (`true`, `false`, or `null`).
  - `childCount` (integer) — number of direct children for this work item. Items with no children return `0`.
- `reason` (string) — the selection reason.

When requesting multiple items (`-n <count>`) with grouping enabled (the default when `-n > 1`), each result entry includes an additional `group` field:

- `group` (integer) — the 1-indexed group number this item belongs to (only present when `-n > 1`).

When requesting multiple items (`-n <count>`), the output wraps results in:

- `success` (boolean)
- `count` (integer) — number of results returned.
- `requested` (integer) — the requested count.
- `results` (array) — array of result objects, each with `workItem` (including `childCount`), `reason`, and optionally `group`.
- `note` (string, optional) — note about available vs requested counts.

#### Parallel-safe grouping

When `-n > 1`, `wl next` automatically groups items into parallel-safe groups based on priority, stage, and file-path conflicts extracted from each item's description. The `--groups/-g` option controls the number of file-path-based groups (default: `3`).

The grouping algorithm uses a greedy first-fit strategy:

1. Extract file paths from each item's description using a `**Key Files:**` section convention (see [docs/FILE_PATH_CONVENTION.md](docs/FILE_PATH_CONVENTION.md) for the full specification).
2. **Critical priority items** are partitioned first into `Critical Group N` file-path conflict groups at the very top.
3. Non-critical items with stage `plan_complete` or `intake_complete` are partitioned into `Group N` file-path conflict groups.
4. `idea` items are placed together in a single "Idea" group.
5. Items with unknown/other stages (and not critical) are placed together in a single "Other" group (no file-overlap splitting).
6. `in_review` items are placed in a single "In Review" group, last.

The group display order is:
1. **Critical Group N** — critical items partitioned by file-path conflicts (items sharing a file path land in different groups; items with unknown paths get singleton groups).
2. **Group N** — plan_complete + intake_complete items partitioned by file-path conflicts. Within each group, `plan_complete` items appear first, then `intake_complete` items (no headings between the sub-groups), each sub-group sorted by priority (high → medium → low). The same stage sub-sort applies inside each Critical Group N.
3. **Idea** — single group, sorted by priority.
4. **Other** — single group for items with unknown/other stages.
5. **In Review** — single group (last).

In JSON output (`--json` with `-n > 1`), each result entry includes a `group` field (integer, 1-indexed) indicating the group assignment.

In human-readable output, group headings (e.g., `── Critical Group 1 ──`, `── Group 1 ──`, `── Idea ──`, `── Other ──`, `── In Review ──`) are displayed between groups.

The Pi TUI selection list renders group separator lines between items in different groups, helping you quickly identify items you can work on in parallel.

To specify a custom number of groups:

```sh
wl next -n 10 -g 5
```

Examples:

```sh
wl next
wl next -n 3
wl next -n 10 -g 4
wl next -a alice --search "bug"
wl next --stage idea
wl next --stage in_progress
wl next --include-blocked
wl next --no-re-sort
wl next --recency-policy prefer
```

### `in-progress` [options]

List all in-progress work items in a dependency tree.

Options:

`-a, --assignee <assignee>` — Filter by assignee (optional).
`--prefix <prefix>` — Override the default prefix (optional).

Examples:

```sh
wl in-progress
wl in-progress -a alice
```

### `recent` [options]

Show most recently changed work items.

Options:

`-n, --number <n>` — Number of recent items to show (optional).
`-c, --children` — Also show children (optional).
`--prefix <prefix>` — Override the default prefix (optional).

Examples:

```sh
wl recent
wl recent -n 10
wl recent -c
```

### `list` [options] [search]

List work items, optionally filtered and/or full-text searched.

Options:

`-s, --status <status>` (optional)
`-p, --priority <priority>` (optional)
`--parent <id>` — Filter by parent ID (direct children only) (optional).
`--root-only` — Show only root-level items (items with no parent). Mutually exclusive with `--parent` (optional).
`--tags <tags>` (optional)
`-a, --assignee <assignee>` (optional)
`-n, --number <n>` (optional) — Limit the number of items returned
`--stage <stage>` (optional)
`--deleted` (optional) — Include items with `deleted` status in the output (hidden by default).
`--needs-producer-review [value]` (optional; defaults to `true` when omitted; accepts true|false|yes|no)
`--prefix <prefix>` (optional)
`--no-icons` (optional) — Disable icon rendering for clean text output. When icons are disabled, priority and status display as plain text (e.g., `[CRIT]`, `[OPEN]`) instead of emoji. This is useful for scripting or copy-paste operations.
`--json` (optional)

Examples:

```sh
wl list
wl list -s open -p high
wl list -s open,in-progress    # status is open OR in-progress
wl list --status open,completed,blocked
wl list -s open,in-progress --stage in_review  # status AND stage filters
wl list --root-only            # root items only (no parents)
wl list --root-only -p critical
wl search "signup"
wl -F concise list -s in-progress
wl --json list -s open --tags backlog
wl list --needs-producer-review
```

---

### `search` <query> [options]

Full-text search over work items using FTS5 (title, description, comments, tags). Returns ranked results with relevance snippets. Falls back to application-level search when FTS5 is unavailable.

**Semantic search:** When the `--semantic` flag is used, results are blended with
embedding-based similarity (cosine similarity) for conceptually related results
beyond exact keyword matches. Requires an OpenAI-compatible embedding provider
configured via the `OPENAI_API_KEY` environment variable. Semantic search
enhancement degrades gracefully when no embedder is configured.

**ID-aware search:** Queries that contain work item IDs (full, partial, or unprefixed) are detected automatically:

- **Exact ID** — `wl search WL-0MM0AN2IT0OOC2TW` returns the matching item as the top result.
- **Unprefixed ID** — `wl search 0MM0AN2IT0OOC2TW` resolves using the repository's configured prefix (e.g. `WL`) and behaves the same as the prefixed form.
- **Partial ID** — Tokens of 8+ alphanumeric characters are matched as substrings against all work item IDs; partial matches appear below exact matches.
- **Mixed queries** — `wl search WL-XXXXX some text` returns the ID match first, followed by FTS results for the full query (duplicates removed).

Options:

`-s, --status <status>` (optional) — Filter results by status
`-p, --priority <priority>` (optional) — Filter by priority
`--parent <id>` (optional) — Filter results by parent work item id
`--tags <tags>` (optional) — Filter by tags (comma-separated)
`-a, --assignee <assignee>` (optional) — Filter by assignee
`--stage <stage>` (optional) — Filter by stage
`--deleted` (optional) — Include deleted items in results
`--needs-producer-review [value]` (optional) — Filter by needsProducerReview flag (true|false|yes|no; default true when omitted)
`--issue-type <type>` (optional) — Filter by issue type
`-l, --limit <n>` (optional) — Maximum number of results (default: 20)
`--rebuild-index` (optional) — Rebuild the FTS index from scratch before searching
`--semantic` (optional) — Enable hybrid lexical+semantic search. Blends FTS BM25
scores with embedding cosine similarity using configurable weights (default 50/50).
Query embeddings are cached in-memory to avoid redundant API calls.
`--semantic-only` (optional) — Return only semantic (embedding-based) results.
Requires an embedder; errors if OPENAI_API_KEY is not set.
`--prefix <prefix>` (optional)
`--json` (optional) — Output structured JSON with `id`, `title`, `status`, `priority`, `score`, `snippet`, `matchedField`. When `--semantic` is used, includes `semanticAvailable: true/false`.

Examples:

```sh
wl search "database corruption"
wl search "memory leak" --status open
wl search "bug" --priority high --assignee alice
wl search "migration" --stage in_progress
wl search "authentication" --tags security,auth --limit 5
wl search "feature" --issue-type epic
wl search "review" --needs-producer-review
wl --json search "cli refactor"
wl search "rebuild" --rebuild-index

# Semantic search
wl search "performance optimization" --semantic
wl search "authentication flow" --semantic-only
wl --json search "data validation" --semantic

# ID-aware search
wl search WL-0MM0AN2IT0OOC2TW              # exact ID lookup
wl search 0MM0AN2IT0OOC2TW                  # unprefixed ID (prefix resolved automatically)
wl search 0MM0AN2I                           # partial ID substring match (>= 8 chars)
wl --json search WL-0MM0AN2IT0OOC2TW        # JSON output with ID match as top result
```

---

## Team

Team commands support sharing and synchronization of the canonical worklog with teammates and external systems. Use these to sync with the repository's canonical JSONL ref, and mirror data to/from GitHub Issues. Export and import commands are listed after sync and GitHub commands.

### `sync` [options]

Sync local worklog data with the canonical JSONL ref in git (pull, merge, push).

Important options:

- `-f, --file <filepath>` — Data file path (optional; default: configured data path, commonly `.worklog/worklog-data.jsonl`).
- `--git-remote <remote>` — Git remote to use (optional; default: `origin` or value from configuration).
- `--git-branch <ref>` — Git ref to store worklog data (optional; default: `refs/worklog/data` or value from configuration).
- `--no-push` — Skip pushing changes (optional).
- `--dry-run` — Preview changes without modifying local state or git (optional).
- `--if-idle` — Lock-aware guard for auto-sync spawners: skip (exit 0, JSON `skipped: true`) if another sync is already in progress. Prevents lock-storm process pile-up from multiple panes/TUI instances. Stale locks are still cleaned first. Manual syncs should omit this flag to keep the wait-for-lock behavior.
- `--prefix <prefix>` — Operate on a specific prefix (optional).

Examples:

```sh
wl sync --dry-run
wl sync --git-remote origin --git-branch refs/worklog/data
```

Diagnostics:

```sh
wl sync debug
wl --json sync debug
```

Example (JSON / dry-run):

```sh
wl --json sync --dry-run
```

### `github` | `gh` (subcommands)

Mirror work items and comments with GitHub Issues.

Subcommands:

- `push` — Mirror work items to GitHub Issues. Options: `--repo <owner/name>`, `--label-prefix <prefix>`, `--prefix <prefix>`.
   Additional push options:

   - `--all` — Force a full push of all items, ignoring the last-push timestamp. Useful when you want to re-sync everything.
   - `--force` — **Deprecated** alias for `--all`. Bypass the pre-filter and process all work items regardless of whether they changed since the last push.
   - `--no-update-timestamp` — Do not write the repository last-push timestamp after a successful push. Use this when you want to run a push but avoid advancing the "last pushed" watermark.
- `import` — Import updates from GitHub Issues. Options: `--repo <owner/name>`, `--label-prefix <prefix>`, `--since <ISO timestamp>`, `--create-new`, `--prefix <prefix>`.
- `delegate <id>` — Delegate a work item to GitHub Copilot. Pushes the item to GitHub, assigns the resulting issue to `@copilot`, and updates local status/assignee. Options: `--repo <owner/name>`, `--label-prefix <prefix>`, `--force` (override the `do-not-delegate` tag). In the TUI, press **g** on a focused item for the same flow with a confirmation modal.

Examples:

```sh
wl github push --repo myorg/myrepo
wl gh import --repo myorg/myrepo --since 2025-12-01T00:00:00Z --create-new

# Force a full re-sync (bypass pre-filter)
wl github push --repo myorg/myrepo --all

# Push but do not update the recorded last-push timestamp
wl github push --repo myorg/myrepo --no-update-timestamp
```

Example (JSON / label prefix):

```sh
wl --json github push --repo myorg/myrepo --label-prefix wl:
wl --json gh import --repo myorg/myrepo --since 2025-12-01T00:00:00Z --create-new
```

Notes on defaults and behavior:

- `--repo <owner/name>` — Optional; if omitted the command will attempt to read the repo from config or infer it from the git remote.
- `--label-prefix <prefix>` — Optional; default label prefix is `wl:`.
- `--since <ISO timestamp>` — Optional; when provided `import` only considers issues updated since that timestamp.
- `--create-new` (import only) — Optional flag; when set the importer will create new work items for unmarked GitHub issues. Default behavior: enabled unless `githubImportCreateNew` is explicitly set to `false` in configuration.

### `export` [options]

Export work items and comments to a JSONL file.

Example:

```sh
wl export -f .worklog/worklog-data.jsonl
```

Options:

- `-f, --file <filepath>` — Output file path (optional; default: repository data path, usually `.worklog/worklog-data.jsonl`).
- `--prefix <prefix>` — Operate on a specific prefix (optional).

Example (JSON):

```sh
wl --json export -f .worklog/worklog-data.jsonl
```

### `import` [options]

Import work items and comments from a JSONL file.

Example:

```sh
wl import -f .worklog/worklog-data.jsonl
```

Options:

- `-f, --file <filepath>` — Input file path (optional; default: repository data path).
- `--prefix <prefix>` — Operate on a specific prefix (optional).

Example (import and verify):

```sh
wl import -f .worklog/worklog-data.jsonl
wl --json list | jq .workItems | head -n 20
```

---

## Maintenance

Maintenance commands are used for one-off migrations and data evolution tasks.

### `migrate` (subcommands)

Run data migrations.

Subcommands:

- `sort-index` — compute `sort_index` values using existing next-item ordering.

Options:

- `--dry-run` — Print the updates without applying them.
- `--gap <gap>` — Integer gap between consecutive `sort_index` values (optional; default: `100`).
- `--prefix <prefix>` — Override the default prefix (optional).

Additionally, database schema upgrades are available via `wl doctor upgrade` (preview with `--dry-run`, apply with `--confirm`).

Examples:

```sh
wl migrate sort-index --dry-run
wl migrate sort-index --gap 100
wl doctor upgrade --dry-run       # Preview pending schema migrations
wl doctor upgrade --confirm       # Apply pending schema migrations (creates backups, requires confirmation)
```

### `doctor` [options]

Validate work items against config-driven status/stage rules. Reports invalid values or incompatible combinations.

For detailed migration policy, backup behavior, and CI guidance, see [DOCTOR_AND_MIGRATIONS.md](DOCTOR_AND_MIGRATIONS.md).

Options:

- `--fix` — Apply safe fixes and prompt for non-safe findings (optional).
- `--prefix <prefix>` — Override the default prefix (optional).
- `--json` — Output findings as JSON (optional).

Subcommands:

- `upgrade [options]` — Preview or apply pending database schema migrations. Options: `--dry-run` (preview without applying), `--confirm` (apply non-interactively).
- `prune [options]` — Prune soft-deleted work items older than a specified age. Options: `--days <n>` (age threshold in days), `--dry-run` (show what would be pruned).
- `file-paths [options]` — Check intake-stage items for missing or incorrect `**Key Files:**` sections. Options: `--add-placeholder` (add a placeholder section).
- `foreign-items [options]` — Report work items whose ID prefix does not match the project prefix (cross-project pollution detection). Options: `--dry-run` (read-only; default), `--prefix <prefix>` (override classification prefix).

Examples:

```sh
wl doctor
wl doctor --fix
wl --json doctor
wl doctor upgrade --dry-run       # Preview pending schema migrations
wl doctor upgrade --confirm       # Apply pending schema migrations
wl doctor prune --days 30         # Prune items deleted more than 30 days ago
wl doctor prune --dry-run         # Preview which items would be pruned
wl doctor stage-sync              # Detect stale status/stage combinations (dry-run)
wl doctor stage-sync --apply      # Fix stale status/stage combinations
wl doctor file-paths                    # Check intake-stage items for **Key Files:** sections
wl doctor file-paths --add-placeholder   # Add placeholder **Key Files:** section to missing items
wl doctor foreign-items                  # Report foreign-prefix work items (read-only)
wl doctor foreign-items --dry-run --json # JSON report of foreign items

Known stale combinations detected by `stage-sync`:

| Current | Fix |
|---|---|
| `completed` + `idea` | `completed` + `done` |
| `completed` + `intake_complete` | `completed` + `done` |
| `completed` + `plan_complete` | `completed` + `done` |
| `in-progress` + `idea` | `open` + `idea` |

Notes:

- Default threshold is 30 days. Items with `status: deleted` whose `updatedAt` (or `createdAt` when updatedAt is missing) is older than `--days` are considered for pruning.
- Items linked to GitHub issues (have `githubIssueNumber`) are skipped when the local `updatedAt` is newer than `githubIssueUpdatedAt` to prevent orphaning GitHub issues. The CLI `--json` output will include `skippedIds` when such items are encountered.
```

JSON output is a raw array of findings. Each finding includes:
`checkId`, `type`, `severity`, `itemId`, `message`, `proposedFix`, `safe`, `context`.

### `re-sort` [options]

Recompute `sort_index` values for active work items (excluding completed/deleted) using the current database values.

Options:

- `--dry-run` — Print the updates without applying them.
- `--gap <gap>` — Integer gap between consecutive `sort_index` values (optional; default: `100`).
- `--recency <policy>` — Recency handling for score ordering: `prefer|avoid|ignore` (optional; default: `avoid`).
- `--prefix <prefix>` — Override the default prefix (optional).

Examples:

```sh
wl re-sort --dry-run
wl re-sort --gap 100
wl re-sort --recency prefer
```

### `unlock` [options]

Inspect or remove a stale worklog lock file. When a `wl` command crashes or is killed, it may leave behind a lock file that blocks subsequent commands. Use `wl unlock` to inspect the lock and remove it.

Options:

- `--force` — Remove the lock file without prompting for confirmation.
- `--json` — Output machine-readable JSON.

Examples:

```sh
wl unlock                # show lock status and suggest removal
wl unlock --force        # remove the lock file without prompting
wl --json unlock         # JSON output with lock metadata
```

JSON output includes `success`, `lockFound`, `removed`, and `lockInfo` (with `pid`, `hostname`, `acquiredAt`, `age`) when a lock file is present.

Notes:

- If no lock file exists, the command prints "No lock file found" and exits 0.
- If the lock file is corrupted (unparseable metadata), `--force` is required to remove it.
- If the lock is held by a still-running process, the command warns but still allows removal with confirmation or `--force`.

### `cleanup-worktree` [path] [options]

Kill tracked processes for a worktree path. Used to clean up orphaned processes
that were spawned during worktree operations.

Arguments:

- `path` — Path to the worktree to clean up (required unless `--all` is used).

Options:

- `--all` — Kill tracked processes for all worktrees.
- `--force` — Use `SIGKILL` instead of `SIGTERM`.
- `--json` — Output machine-readable JSON.

Examples:

```sh
wl cleanup-worktree /path/to/worktree
wl cleanup-worktree --all
wl cleanup-worktree /path/to/worktree --force
wl --json cleanup-worktree /path/to/worktree
```

Notes:

- Safe to run when no processes are tracked (no-op, exit 0).
- If neither a path nor `--all` is provided, the command prints an error and exits non-zero.

---

## Plugins

Plugin commands let you inspect installed extensions that add or alter CLI functionality. To list commands provided by plugins in your environment run `wl --help` (or `worklog --help`).

### `plugins`

List discovered plugins and their load status.

Example:

```sh
wl plugins
```

Worklog comes bundled with an example stats plugin installed.

- `openbrain` — Manage OpenBrain submission queue (`status`, `resubmit`).
- `stats` — Show custom work item statistics (example plugin provided in this repo).
 - `ampa` — AMPA plugin: manage AMPA containers and workspace tasks (start, stop, status, run, list, start-work, finish-work).

Examples:

```sh
wl openbrain status
wl openbrain resubmit WL-ABC123
wl ampa start                 # start AMPA services for this repo
wl ampa status                # show AMPA service status
wl ampa list                  # list available AMPA containers/tasks
wl ampa start-work WL-012     # attach/start AMPA work for a specific work item
```

---

## Other

Other commands cover repository bootstrap and local system status. Use these to initialize Worklog in a repo, check system health, or get help on a command.

### `init`

Initialize Worklog configuration in the repository (creates `.worklog` and default config). `wl init` also installs `AGENTS.md` in the project root with a pointer line to the global `AGENTS.md`. If `AGENTS.md` already exists, it prompts before inserting the pointer and preserves the existing content (unless you pass `--agents-template` for unattended runs). When workflow templates are available, `wl init` prompts you to choose between no formal workflow, a basic Worklog-aware workflow, or manual management (unless you pass `--workflow-inline` for unattended runs).

Options:

- `--project-name <name>` — Project name (optional).
- `--prefix <prefix>` — Issue ID prefix (optional).
- `--auto-export <yes|no>` — Auto-export data to JSONL after changes (optional).
- `--auto-sync <yes|no>` — Auto-sync data to git after changes (optional).
- `--agents-template <overwrite|append|skip>` — What to do when AGENTS.md exists (optional). Append inserts the pointer line at the top while keeping existing content.
- `--workflow-inline <yes|no>` — Answer the workflow prompt (yes chooses the basic workflow option; no chooses no formal workflow). Omit to prompt interactively.
- `--stats-plugin-overwrite <yes|no>` — Overwrite existing stats plugin if present (optional).

Example:

```sh
wl init
wl init --project-name "My Project" --prefix PROJ --auto-export yes --auto-sync no
```

### `tui` [options]

Launch the terminal UI for browsing and filtering work items.

Options:

- `--in-progress` — Show only in-progress items.
- `--all` — Include completed/deleted items in the list.
- `--prefix <prefix>` — Override the default prefix.

Example:

```sh
wl tui --in-progress
```

Example (JSON):

```sh
wl --json init
```

### `piman` | `pi` [options]

Launch the Pi-based TUI for browsing and managing work items with agent chat and action palette. This is the agent-centric TUI that replaces the legacy Opencode-based interface. All Worklog reads/writes use the wl CLI (no direct database access).

Options:

- `--in-progress` — Show only in-progress items.
- `--all` — Include completed/deleted items in the list.
- `--prefix <prefix>` — Override the default prefix.
- `--perf` — Enable performance instrumentation.
- `--headless` — Run in headless mode for CI scripting and automated tests.

Example:

```sh
wl piman --in-progress
```

### `status` [options]

Show Worklog system and database status (counts, configuration values).

Options:

- `--prefix <prefix>`
- `--json`

Human output includes a "Sync:" section with the last sync timestamp (ISO format) or "Never" if no sync has been performed.

JSON output includes a `lastSync` field with the ISO timestamp string, or `null` if no sync has been performed.

Example:

```sh
wl status
```

Example (JSON):

```sh
wl --json status
```

### `help` [command]

Show help for a specific command.

Example:

```sh
wl help create
```

### `completion` [shell]

Generate shell completion scripts for bash and zsh. Outputs a completion
script to stdout that provides tab-completion for all `wl` subcommands,
options, and dynamic work-item IDs.

Arguments:

- `shell` — Target shell: `bash` or `zsh`.

Examples:

```sh
# Source directly (current shell only)
source <(wl completion bash)
source <(wl completion zsh)

# Write to file for permanent installation
wl completion bash > ~/.wl-completion.bash
echo "source ~/.wl-completion.bash" >> ~/.bashrc

# JSON output
wl --json completion bash
```

Features:
- Static completions for all subcommands and their options
- Dynamic work-item ID completion for commands like `show`, `update`, `delete`, `close`, etc.
- Shell name completion for the `completion` subcommand itself (bash, zsh)
- The bash script uses `_init_completion` and registers via `complete -F`
- The zsh script uses `compdef` and `_arguments` with a dynamic `_wl_ids` helper

---

## Examples and scripting tips

- Use JSON mode (`--json`) when scripting or integrating with other tools; parse the output with `jq`:

```sh
wl --json list -s open | jq .workItems
```

- Use `--format` to change human output verbosity:

```sh
wl -F concise show WL-ABC123    # compact summary
wl -F full show WL-ABC123       # full detail
```

- When you have multiple data sets in a repository use `--prefix` to select the workspace scope.

## Where to look for examples in this repository

+ `README.md` — quick start and first-run setup
+ `EXAMPLES.md` — practical command examples and scripts
+ `DATA_SYNCING.md` — detailed sync and GitHub workflows

## Related documentation

- `README.md` — project overview, quick start, and documentation index
- `CONFIG.md` — configuration system and setup options
- `DATA_FORMAT.md` — JSONL data format, storage architecture, and field reference
- `API.md` — REST API endpoints and usage
- `PLUGIN_GUIDE.md` — plugin development and examples
- `GIT_WORKFLOW.md` — recommended git workflow for syncing JSONL data
- `MULTI_PROJECT_GUIDE.md` — using prefixes and multi-project setups
- `IMPLEMENTATION_SUMMARY.md` — design notes and implementation details
- `tests/README.md` — testing guide for running and authoring tests
- `MIGRATING_FROM_BEADS.md` — migration notes for users coming from Beads

If you find a command that's missing an example or you need an example tailored to your repository (prefixes, repo names, or CI usage), open an issue or ask for a focused example and I will add it.
