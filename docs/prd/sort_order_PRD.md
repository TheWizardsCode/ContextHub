# PRD: sort_index and custom ordering for work items

Goal
Add a persistent, deterministic, and efficient custom ordering mechanism for work items using an integer `sort_index` and supporting CLI and TUI reordering operations.

Motivation
Current ordering (priority + creation time) does not capture execution order or producer intent. Contributors and producers need a way to persist and share custom ordering across the team and views.

Scope (in)
- Add integer `sort_index` column to the work items table
- DB migration to populate initial `sort_index` values using existing `next` logic
- CLI commands: `wl move <id> --before <id>`, `wl move <id> --after <id>`, and `wl move auto` for redistribution
- `wl list` and `wl next` default ordering updated to use `sort_index` unless `--sort` is provided
- TUI: interactive reordering with keyboard shortcuts (move up/down, move to before/after selection)
- Reindexing strategy and `sync` hooks to resolve conflicts

Out of scope
- Deep UI redesign beyond minimal TUI keyboard handlers
- Remote collaborative real-time editing (beyond git-based sync resolution)

Success criteria (testable)
- `wl list` and `wl next` return items ordered by `sort_index` by default
- `wl move` commands persist new `sort_index` values in DB and maintain hierarchical grouping (parent+children)
- Adding new items inserts them at the correct hierarchy level using the `next` logic
- Reindexing preserves relative ordering and is triggered only when gaps exhausted
- Migration preserves current importance/next semantics; restore via backup if needed
- Performance: ordering operations and queries remain acceptable for up to 1000 items per level

Constraints
- Backwards compatible CLI behavior; `--sort` overrides `sort_index`
- Use large interval gaps (e.g., 100) between adjacent `sort_index` values to limit reindexing frequency
- Migration must support backups; rollback helper is out of scope for this phase

Design

- Data model
  - Add `sort_index INTEGER NOT NULL DEFAULT 0` to `work_items` table
  - Add an index on `sort_index` and `(parent_id, sort_index)` for hierarchical queries

- Initial sort_index calculation
  - Use existing `next` selection logic applied across the tree: level-0 items ordered first, then each parent's children
  - Assign starting values in increments of 100 (configurable constant SORT_GAP = 100)

- Move operations
  - `wl move <id> --before <id2>`: assign new `sort_index` between predecessor and target; if gap < MIN_GAP, trigger redistribution for that level
  - `wl move auto`: evenly redistribute `sort_index` values across the affected level using SORT_GAP
  - Parent moves bring child subtree along: moving a parent moves whole group maintaining relative gaps

- Sync and conflict resolution
  - On `wl sync`, detect conflicting `sort_index` values (same values or reversed) and run a deterministic merge: prefer larger `updated_at`, then owner, then fallback to redistributing that level

Migration plan
- Add migration: create `sort_index` column and index
- Populate values in a single transaction where possible; if SQLite, use a migration script that runs within a transaction
- Include a reversible path via backup export before migration (no rollback helper in this phase)

Testing and validation
- Unit tests for helpers that compute insertion index and detect gap exhaustion
- Integration tests for `wl move` commands (before/after/auto) asserting DB state and `wl list` output
- Migration test: fixture DB with representative items -> run migration -> assert preserved ordering
- Performance test: generate 1000 items per level and measure list/query latency

Milestones & child work items
1) PRD and planning (this document) — WL-0MKXFC2600PRVAOO (current)
2) DB migration & model changes — child work item: "Add sort_index column and migration" (high)
3) Core ordering logic & `wl list`/`wl next` changes — child work item: "Apply sort_index ordering to list/next" (high)
4) CLI `wl move` commands — child work item: "Implement wl move CLI" (high)
5) Reindexing & `wl move auto` — child work item: "Implement reindex and auto-redistribute" (medium)
6) TUI reordering support — child work item: "TUI interactive reorder" (medium)
7) Tests & benchmarks — child work item: "Sort order tests and perf benchmarks" (high)
8) Docs & rollout guide — child work item: "Docs: sort order and migration guide" (medium)

Risks & mitigations
- Migration corruption: mitigate by backup and dry-run mode
- Concurrent edits: mitigate by deterministic conflict resolution and reindex on sync
- Gap exhaustion in hotspots: mitigate by `wl move auto` and periodic reindexing

Open questions
- Default SORT_GAP value — recommended 100 (configurable). If you prefer a different default say so.
- Should `wl move` accept a fractional-based approach (e.g., using decimals) instead of integer gaps? Recommendation: use integers to avoid float precision and make conflicts explicit.

Acceptance test checklist (for reviewers)
- [ ] PRD merged into repo
- [ ] Child work items created and linked
- [ ] Example migration script included or referenced
- [ ] Tests added for ordering and migration (placeholder test files created)

Rollout
- Stage: implement migration and core logic; run on a staging DB; validate ordering; then release with docs and migration helper.

Appendix: references
- src/database.ts
- src/commands/list.ts
- src/commands/next.ts
- src/commands/helpers.ts
