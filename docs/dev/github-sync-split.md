# GitHub Sync Module Layout

`src/github-sync.ts` is a thin public barrel; the implementation lives in the
focused modules under `src/github-sync/`. The authoritative module map, the
cycle-safe layering and the "where to find X" pointer are in
[docs/ARCHITECTURE.md § GitHub Sync Module Layout](../ARCHITECTURE.md#github-sync-module-layout)
(WL-0MVGKH9Z900178UF / WL-0MW0JFBIK007E6VZ).

## Quick reference

- **Public surface:** import from `src/github-sync.js` only. The 10 exported
  symbols (4 values + 6 types) are frozen in
  `tests/github-sync/github-sync.split-baseline.json`.
- **Internal modules:** `src/github-sync/*.ts` — do not import the barrel from
  inside `src/github-sync/`; import the sibling (`./import-hierarchy.js`, …) or
  the `../github.js` barrel directly.
- **Structural gates:** `tests/github-sync/split-guard.test.ts` enforces the
  public surface, the ≤ 1,000-line ceiling (no exemptions), an acyclic import
  graph and the module-header JSDoc.

## Module responsibilities

| Module | Responsibility |
|---|---|
| `src/github-sync.ts` | Public barrel: re-exports the frozen surface and documents where each concern lives. |
| `src/github-sync/types.ts` | Result, timing and progress declarations (`SyncedItem`, `SyncErrorItem`, `GithubSyncResult`, `GithubSyncTiming`, `GithubProgress`, `FieldChange`); declarations only. |
| `src/github-sync/util.ts` | Shared pure helpers: timestamp/comment ordering, the comment-sync predicate, title shortening and the stable import comparison key. |
| `src/github-sync/progress.ts` | The single progress-emitter factory: items-per-second rate, ETA and throttler snapshot. |
| `src/github-sync/labels.ts` | Label-derived field resolution from the label event timeline, newest event wins with a local tie-break. |
| `src/github-sync/comments.ts` | worklog→GitHub comment rendering and upsert, including `githubCommentId` persistence. |
| `src/github-sync/push.ts` | The push flow: issue create/update, unchanged-item skip, deleted-item guard, comment upsert and sub-issue linking. |
| `src/github-sync/import.ts` | The import orchestrator: owns the phase order, the merge/enforcement steps and the result shape. |
| `src/github-sync/import-hierarchy.ts` | Import scan state: issue fetch, sub-issue hierarchy maps and the parent/child hint maps. |
| `src/github-sync/import-close-check.ts` | The close-check pass over local items the listing missed. |
| `src/github-sync/import-comments.ts` | GitHub→worklog comment import and its fetch filter. |

## Import direction

Modules import down the stack only — never the barrel:

```
types · util                                  (leaves)
progress
labels         → types
comments       → util
push           → comments, progress, util, types
import-hierarchy        → progress
import-close-check      → import-hierarchy, progress
import-comments         → import-hierarchy, progress
import         → labels, progress, util, import-hierarchy,
                 import-close-check, import-comments
src/github-sync.ts (barrel) → types, labels, push, import
```

Every module also imports the github barrel (`../github.js`) rather than a
`src/github/*` internal, so the `src/github.ts` surface stays the only coupling
point between the two families.

## Regenerating the baseline

Only after a *deliberate* public-surface change:

```bash
npx tsx tests/github-sync/split-guard-scan.ts --write-baseline
```

The committed `tests/github-sync/github-sync.split-baseline.json` is the frozen
contract; a move-only refactor must leave it untouched.

See [docs/ARCHITECTURE.md](../ARCHITECTURE.md#github-sync-module-layout) for the
full responsibility table and layering diagram.
