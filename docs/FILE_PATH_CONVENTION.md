# File Path Convention for Work Item Descriptions

## Purpose

The `wl next --groups/-g` grouping feature determines parallel-work safety by
extracting file paths from work item descriptions. To make this work reliably,
all `in_progress`, `intake_complete`, and `plan_complete` work items **should** include a
`**Key Files:**` or `## Key Files` section
listing the files the work item will touch.

## Convention Specification

### Format

Add a `**Key Files:**` or `## Key Files` section near the **end** of the work item description
with bullet-pointed file paths:

```markdown
**Key Files:**
- `path/to/file.ext`
- `another/file.ts`
- `docs/guide.md`
```

A Markdown heading (without a trailing colon) is also accepted:

```markdown
## Key Files
- `path/to/file.ext`
- `another/file.ts`
- `docs/guide.md`
```

### Rules

1. **Section header**: Use `**Key Files:**` (bold with colon) or `## Key Files`
   (Markdown heading without colon). The header is case-insensitive
   (`key files:`, `Key Files:`, `KEY FILES:`) — any casing works.
   Bold markers are optional but recommended. A trailing colon after `key files`
   is also optional — the parser accepts both `Key Files:` and `Key Files`.

2. **Bullet items**: List paths as Markdown bullet items using `- ` or `* `.
   Each line starting with `- ` or `* ` after the header is processed as a
   path candidate.

3. **Backticks**: Paths may be wrapped in backticks or plain text:
   - `` - `src/commands/next.ts` `` (recommended, visually distinct)
   - `- src/commands/next.ts` (also valid)

4. **Trailing description**: Paths with backticks may have descriptive text
   after the closing backtick. The parser extracts only the text between
   backticks as the path:
   - `` - `src/commands/next.ts` — New file for next command ``
   - `` - `src/commands/helpers.ts`: Shared helpers ``
   - `` - `src/foo.ts` (some context) ``

5. **Valid path criteria**: Each extracted path must:
   - Contain at least one `/` (indicating a file in a directory)
   - End with a file extension (e.g., `.ts`, `.md`, `.json`)
   - Not be a URL (`http://...`, `https://...`)

6. **Single section**: Only the first `**Key Files:**` section in the
   description is processed. Any subsequent sections are ignored.

7. **Section termination**: The parser stops at the next Markdown heading
   (`#`, `##`, `###`) or the next bold section header (e.g., `**Risks:**`).

### Examples

#### Valid

```markdown
## Summary

Implement the new grouping feature.

**Key Files:**
- `src/commands/grouping.ts`
- `src/commands/helpers.ts`
- `tests/grouping-utility.test.ts`

## Risks

None identified.
```

```markdown
Key Files:
- src/commands/next.ts
- docs/CLI.md
```

#### Invalid

Missing section entirely:

```markdown
## Summary

Do the thing. No file paths listed.
```

Section exists but no valid paths:

```markdown
**Key Files:**
- https://example.com
- Some random text
```

### When to Include

| Stage | Required? |
|---|---|
| `idea` | No (optional) |
| `in_progress` | **Should** include (groups items into `Group N`) |
| `intake_complete` | **Should** include (groups items into `Group N`) |
| `plan_complete` | **Should** include (groups items into `Group N`) |
| `in_review` | No |

### Group display order

`wl next -n N` displays groups in this order (WL-0MSAK8YLB0025EGW):

> **Note (CLI-only):** this order applies to `wl next` (the CLI). The **Herdr plugin** selection list (`packages/herdr`) regroups by **priority first** — Critical → High → Medium → Low sections, then stage in workflow order — see WL-0MSI1LVTJ001M9EY. The CLI's file-path-conflict partitioning is unchanged.

1. **Critical Group N** — `critical` priority items partitioned by file-path conflicts (items sharing a file path land in different groups; items with unknown paths get singleton groups).
2. **Group N** — non-critical `in_progress` + `plan_complete` + `intake_complete` items partitioned by file-path conflicts. Within each group, `in_progress` items appear first, then `plan_complete`, then `intake_complete` items (no headings between sub-groups), each sorted by priority (high → medium → low). The same within-group stage sub-sort applies inside each `Critical Group N`.
3. **Idea** — single group, sorted by priority.
4. **Other** — single group for all remaining items (safety net for unknown/custom stages and stale stage/status combinations; empty for all canonical stages in the default selection list).
5. **In Review** — single group (last).

### Programmatic Access

The `extractFilePaths()` function in `src/commands/helpers.ts` implements
the extraction logic. It is shared between:

- The `wl next --groups/-g` grouping algorithm
- The `wl doctor file-paths` subcommand
- The automatic advisory check on transition to `intake_complete`

## Related

- [CLI.md](../CLI.md) — `wl next` and `wl doctor` command documentation
- [`wl doctor file-paths`](../CLI.md#doctor-options) — On-demand validation
- [Work Item Descriptions](../CLI.md#create-options) — Description format guidance
