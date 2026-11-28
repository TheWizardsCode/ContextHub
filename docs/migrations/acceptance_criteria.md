# `acceptance_criteria` table

Work item: WL-0MWXJGVOQ0068QWK (parent WL-0MWXBHODR002ZLJG).

Acceptance criteria move out of a work item's prose description and into
first-class rows, so every consumer reads structured criteria instead of
re-parsing the `## Acceptance Criteria` section of `workitems.description`.

## Schema

Created by `packages/shared/src/persistent-store.ts`
(`ACCEPTANCE_CRITERIA_DDL`) on a fresh store and by the
`20261128-add-acceptance-criteria` migration on a store written by an older
release. Both paths use the same DDL, so they cannot drift.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | Primary key; the AC id (`<prefix>-A<unique>`). |
| `work_item_id` | TEXT | Owning item; FK to `workitems(id)` `ON DELETE CASCADE`. |
| `position` | INTEGER | Stated order within the item (0-based), `NOT NULL`. |
| `text` | TEXT | The criterion text as it currently stands, `NOT NULL`. |
| `status` | TEXT | `NOT NULL`, defaults to `unmet`; `CHECK` restricts it to `met`, `unmet`, `partial`, `modified`. |
| `original_text` | TEXT | Original wording, preserved for `modified` rows. |
| `modification_justification` | TEXT | Why the criterion changed, for `modified` rows. |

`idx_acceptance_criteria_work_item_position` is a **unique** index on
`(work_item_id, position)`, so the stated order can be inserted or reordered
without renumbering and can never hold duplicates.

The status vocabulary is declared once, as
`ACCEPTANCE_CRITERION_STATUSES` in `packages/shared/src/types.ts`; the CHECK
constraint and the `AcceptanceCriterionStatus` union are both derived from it.

## Version bump

`SCHEMA_VERSION` (`packages/shared/src/persistent-store.ts`) and
`CURRENT_SCHEMA_VERSION` (`src/migrations/index.ts`) move together from 10 to
11. The migration is keyed on the table's existence
(`__table:acceptance_criteria`), so a store the current build has already
self-healed shows it as satisfied, and `wl doctor upgrade` simply advances the
recorded version.

## Deletion semantics

- A hard delete of the owning work item (`persistent-store.deleteWorkItem`,
  used by `wl doctor prune`/import) removes its criteria through
  `ON DELETE CASCADE`.
- The user-facing `wl delete` is a **soft delete** (the row becomes
  `status = 'deleted'`), so it keeps the item's criteria: `wl undelete`
  restores them rather than losing them.

## Related follow-ups

- Back-filling rows from existing descriptions: WL-0MWXJH4CC001V5G9.
- AC CRUD, JSONL and sync: WL-0MWXJGXSM009QA25.
- `wl ac` CLI and `wl show` rendering: WL-0MWXJGZZB005JANC,
  WL-0MWXJH2DA007IGC2.
