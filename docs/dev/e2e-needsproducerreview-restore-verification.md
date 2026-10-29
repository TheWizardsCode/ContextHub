# End-to-end verification — Restored `needsProducerReview` flag, icon and release gate

> Work item: WL-0MVAPF2Q3009088O (child of epic WL-0MVAMS4RO000H3B0).
> Commits: F2 `e950d006` · F3 `c51c1c13` · F4 `abb367ee` · F5 `b779d91f` ·
> F6 `70708f62` (SA `4fd33cb4`, `05ec727b`) · F7 `f7f826e6`.
> This item records the end-to-end verification evidence for the restore.

## 1. Selection-list icon and metadata row

- An item with `needsProducerReview === true` renders ❌ in the herdr list
  prefix; `false` renders ✅; unset renders nothing. Verified against the
  shared `getIconPrefixParts` (prefix contains ❌; `[REVIEW]`/`[OK]` text
  fallbacks in noIcons mode) — PASS.
- The metadata `Producer Review` row (`... ❌ needs review` / `✅ reviewed`) is
  rendered by `buildMetaRows` and covered by the restored
  `packages/herdr/src/worklist.test.ts` and `tests/herdr/detail-view.test.ts`
  suites (green in the F4 run).
- `poetry` of the runtime pane: `npx tsx packages/herdr/src/index.ts` starts
  and renders the list without crashing after the shared-artifacts staleness
  fix (see WL-0MVAY631M004RZ3Q).

## 2. Dispatch exclusion and review-queue ordering

- Flag-true items are excluded from downtime auto-dispatch every tier
  (`classifyItemForDispatch` returns null; `select*Candidate` skip them) —
  restored F4, covered by `packages/herdr/src/downtime-worker*.test.ts` and
  `tests/unit/downtime-worker-*.test.ts` (green).
- `inReviewBucket` returns 6 buckets with bucket 1 = `needsProducerReview ===
  true`; review-queue ordering ranks flagged items first — restored F3/F4,
  covered by `tests/grouping-utility.test.ts` and
  `packages/herdr/src/grouping.test.ts` (green). Runner check: `PASS`.

## 3. `wl reviewed`, filters, JSONL and cross-root sync

- `wl reviewed <id>` toggles; `<id> true|false` sets; JSON output returns the
  updated item — restored F3, covered by `tests/cli/reviewed.test.ts` (green).
- `--needs-producer-review` filters work on `wl list`/`wl search`/`wl next`
  and the REST API (`/items?needsProducerReview=true|false`; invalid → 400).
  Direct E2E: DB `list` filter PASS, API filter + 400 PASS.
- JSONL transport round-trips the flag (restored `packages/shared` registry
  tests, `packages/shared/src/database.test.ts` green).
- Cross-root sync: the flag participates as a normal tracked field (F2
  restored the schema/transport; sync regression-guard behaviour for the
  assignee kept per Q2=C).

## 4. Audit-safety regression

- Flipping the flag does **not** bump `updatedAt`, so a fresh audit stays fresh
  (WL-0MSN6ZCTN0027U2R). Direct E2E: `update({needsProducerReview:false})`
  preserves `updatedAt` — PASS; `isAuditFresh(auditedAt==updatedAt)` true and
  stale-after-2min false — PASS. Covered by the restored shared database
  "flag-only flip" tests.

## 5. Ship gate blocks release on a flagged item

- F6 delivered the SA items: SA-0MVB1QFXI004T4G5 (audit runner sets
  `--needs-producer-review yes` on 'yes' verdicts) and SA-0MVB1Q6DR007I49R
  (ship gate blocks release on `needsProducerReview === true`). SA full suite
  green (ship 200 tests; audit-runner 262 tests). See
  `docs/dev/cross-repo-producer-review-restore.md`.

## 6. Full project suite passes (`/skill:test` gate)

- Canonical gate (`run_tests.py` full scope → `tests/cli` + `tests/unit` at the
  time of this run; since WL-0MVG4FF9200346NR the canonical gate is the single
  `npm --silent test -- tests` umbrella)
  green after F8: suite success true. herdr suite (108 files, 3518 tests)
  green; shared restored corpus green.

## Notes

- Range of restored surfaces in one sentence: `needsProducerReview` now
  round-trips DB → CLI (`wl reviewed`, create/update, list/search/next
  filters, api) → herdr (icon ❌/✅, metadata row, 6-bucket review queue,
  dispatch exclusion) → release gate (SA); the verify pane renders the
  selection list normally.
- The worktree `@worklog/shared` resolution gap (worktrees point at the main
  checkout's shared install) required a worktree-local node_modules mirror
  during implementation; tracked in WL-0MVAY631M004RZ3Q alongside the
  vendored-artifact crash.
