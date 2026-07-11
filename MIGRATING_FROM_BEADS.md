# Migrating From Beads

This repo includes a helper to convert a Beads `.beads/issues.jsonl` file into Worklog's `.worklog/worklog-data.jsonl` JSONL format, so you can then use `wl sync` to collaborate via git.

## Prerequisites

- Node.js (to run the converter script)
- A Worklog checkout (this repo)

## Convert Beads Data To Worklog JSONL

From the repo root:

```bash
./scripts/beads-issues-to-worklog-jsonl.sh path/to/.beads/issues.jsonl
```

By default this writes:

- `.worklog/worklog-data.jsonl`

To choose a different output path:

```bash
./scripts/beads-issues-to-worklog-jsonl.sh path/to/.beads/issues.jsonl path/to/worklog-data.jsonl
```

## Initialize Worklog And Sync To Git

Initialize Worklog for the repo (creates `.worklog/config.yaml` and an init semaphore):

```bash
wl init
```

Sync the data via git (default data ref is `refs/worklog/data`):

```bash
wl sync
```

Notes:

- `wl init` attempts a sync automatically; you can rerun `wl sync` any time.
- Worklog uses the git ref `refs/worklog/data` by default so GitHub does not treat it like a PR branch.

## Fresh Clone / New Checkout

In a new clone of the repo:

```bash
wl init
```

If you prefer to do it explicitly:

```bash
wl sync
```

## Field Mapping Notes

The converter script maps Beads fields into Worklog fields as follows:

- `id`: preserved from Beads `issue.id`
- `title`: Beads `title`
- `description`: composed from `description` plus optional sections for `acceptance_criteria`, `notes`, and `external_ref`
- `status`:
  - `open` -> `open`
  - `in_progress` -> `in-progress`
  - `closed` -> `completed`
  - `tombstone` -> `deleted`
- `priority` (Beads 0 highest, 4 lowest):
  - `0` -> `critical`
  - `1` -> `high`
  - `2` -> `medium`
  - `3` -> `low`
  - `4` -> `low`
- `tags`: Beads `labels`
- `assignee`: Beads `assignee`
- `stage`: left as an empty string
- `issueType`, `createdBy`, `deletedBy`, `deleteReason`: copied through when present
- `parentId`: derived from Beads `dependencies` entries where `type == "parent-child"` and `issue_id` matches the child issue id
- `comments`: each Beads comment becomes a Worklog comment record associated with the work item

## Limitations / Gotchas

- Rerunning the converter overwrites the output JSONL file.
- Timestamps are normalized to ISO `Z` and sub-millisecond precision is dropped.
- Comment IDs are synthesized as `${workItemId}-C${commentId}`.

## Troubleshooting

- If the script says input file not found, double-check the path to `.beads/issues.jsonl`.
- If `wl sync` fails, run `wl sync --dry-run` to see what it would do.
- If your repo uses a non-default remote or ref, use:
  - `wl sync --git-remote <remote>`
  - `wl sync --git-branch <ref>`
