# Missing shared build output: `wl` diagnostic and recovery

**Work items:** WL-0MVPADZ1Z000FOSG (parent AC4) · WL-0MVWK20DK004TQZM (AC3/AC4, the 2026-10-31 recurrence) · **Repository:** ContextHub

## Symptom (before)

`wl` resolves `@worklog/shared/*` through the workspace link
(`node_modules/@worklog/shared` → `packages/shared`) into
`packages/shared/dist` — **gitignored build output**. When that output is
missing (the 2026-10-26 incident wiped it mid-session), every command died
with a bare stack trace:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'/home/…/ContextHub/node_modules/@worklog/shared/worklog-paths'
imported from '/home/…/ContextHub/dist/worklog-paths.js'
```

Nothing in that message says *what* is missing, *why*, or *how to fix it* — and
`wl` is the single source of truth for every agent on the host, so the whole
workflow failed closed.

## Behaviour (after)

The thin fast path (`src/cli.ts`) runs a preflight **before the first load of
`@worklog/shared/*`** and, when the build output is absent, prints one
actionable diagnostic to stderr and exits non-zero:

```
wl: cannot start — the shared workspace build output is missing.
  Missing artifact: /home/…/node_modules/@worklog/shared/dist/worklog-paths.js
  wl resolves @worklog/shared/* from packages/shared/dist, which is
  gitignored build output (a wiped build tree produces this).
  Tracked sources under packages/shared were deleted too?
    git -C /home/…/ContextHub restore -- packages/shared
  Then rebuild the gitignored output:
    (cd /home/…/ContextHub && npm run build:shared)
  One-command recovery: bash /home/…/ContextHub/scripts/repair-shared-package.sh
```

No `ERR_MODULE_NOT_FOUND`, no stack trace.

### How the check works

`sharedDistPreflight()` (exported from `src/cli.ts` for unit testing):

1. resolves `@worklog/shared/worklog-paths` with `import.meta.resolve` — the
   **same resolution the runtime uses**, from the CLI module's own location —
   then
2. checks the resolved file exists; if resolution throws or the file is
   absent, it reports that absolute path,
3. stays **silent** when no repository root can be discovered at all
   (fail-open — the check may only fire for a genuinely missing artifact).

Because the check mirrors runtime resolution, a linked worktree
(`<main>/.worklog/worktrees/<wl-…>`) that has no `dist/` of its own — the
common agent case, where `node_modules` is symlinked to the main checkout and
`@worklog/shared` therefore resolves the **main checkout's** build — is never a
false positive.

### The tracked-sources-gone state (2026-10-31)

On 2026-10-31 the recurrence deleted the **tracked sources and the `dist/`
together** — the whole `packages/shared` directory. That breaks the earlier
root-discovery assumption: `expectedSharedDistArtifactPath()` walked up
looking for `packages/shared/package.json`, which no longer existed, so it
returned `null` and the preflight stayed **silent** (fail-open) exactly when it
was needed (WL-0MVWK20DK004TQZM AC3).

Root discovery is now independent of the workspace manifest surviving
(`looksLikeWorklogRepo()` in `src/cli.ts`):

1. `packages/shared/package.json` exists (the healthy layout),
2. a `packages/shared` directory exists (a partial deletion),
3. the root `package.json` declares `@worklog/shared` as a local
   (`file:`/workspace) dependency — the marker that survives a whole-directory
   wipe.

The remediation text covers both halves of the wipe: `git restore`/
`git checkout` for deleted **tracked** files and `npm run build:shared` for
the **gitignored** output, plus `scripts/repair-shared-package.sh` for the
one-command recovery.

### Constraints honoured

- **Startup import budget:** the helpers live in `src/cli.ts` rather than a new
  module, so the fast path's static import graph and dynamic-entry allowlist
  are unchanged (`tests/cli/startup-import-budget.test.ts` stays green).
- **Import-safe:** an invocation guard (`process.argv[1]` realpath vs
  `import.meta.url`) means importing `src/cli.ts` for unit tests never runs the
  CLI. Symlinked launchers (`/usr/local/bin/wl` → `…/dist/cli.js`) still run.
- **`--version` / `--help`:** `--version` keeps its "nothing else is imported"
  fast path; `--help` works exactly as before when the build output is present.

## Recovery

The 2026-10-31 outage cost ~35 machine-wide minutes because recovery was
manual and multi-step. Two one-command paths now exist:

```sh
# The whole wiped state (deleted tracked sources AND gitignored dist/):
bash scripts/repair-shared-package.sh

# …or by hand (exactly what the script does, non-destructively):
cd <repository root>
git restore -- packages/shared   # deleted tracked files from HEAD (never stash/reset)
npm run build:shared             # rebuild packages/shared/dist
```

`scripts/repair-shared-package.sh` (WL-0MVWK20DK004TQZM AC4):

- restores **only the deleted** tracked files under `packages/shared/` from
  `HEAD` (`git restore --source=HEAD --worktree -- <path>`, per path) — never
  stash/reset/`git clean`, and never touching modified-but-present files, so
  local work survives;
- rebuilds via `npm run build:shared` and verifies
  `packages/shared/dist/worklog-paths.js` exists;
- idempotent: a healthy checkout exits 0; `--work-item <id>` records the
  repair on a work item (best-effort); `--json` for machine use.

## Main-checkout integrity check

`scripts/check-main-checkout.sh` (WL-0MVWK20DK004TQZM AC2) detects tracked-file
deletions in the **main checkout** independently of `implement.py finish` —
the 2026-10-31 finish run aborted at the test gate before its guard's verify
points, so nothing reported the 37 deletions. Run it periodically, in CI, or
before a finish:

```sh
bash scripts/check-main-checkout.sh          # exit 1 names every deleted path
bash scripts/check-main-checkout.sh --json
bash scripts/check-main-checkout.sh --work-item WL-<id>   # also wl-comment the report
```

See `docs/dev/worktree-isolation.md` for the guard context.

## Tests

`tests/cli/missing-shared-dist.test.ts`:

- unit tests for `expectedSharedDistArtifactPath`, `looksLikeWorklogRepo`,
  `sharedDistPreflight` (injected resolver: healthy / resolved-but-missing /
  resolution-throws / no-repo-root) and the diagnostic text;
- the wiped-root fixture (WL-0MVWK20DK004TQZM AC3): no `packages/shared` at
  all — only the root manifest declaring `@worklog/shared: file:…` — asserts
  the preflight **fires** instead of staying silent;
- a CLI test that copies the **built** CLI into a temporary workspace layout,
  transpiles the current `src/cli.ts` over it (so a stale build cannot mask
  the change), removes `packages/shared/dist` and asserts the actionable
  diagnostic, the non-zero exit and the absence of `ERR_MODULE_NOT_FOUND`;
- the both-gone CLI fixture: tracked sources AND `dist/` removed, only the
  dangling workspace link left — the diagnostic still fires and its
  remediation mentions `git restore` and `repair-shared-package.sh`;
- a healthy control asserting `--version` and `--help` keep working with the
  build output present.

The check/repair scripts carry their own regression tests
(`tests/scripts/check-main-checkout.test.ts`, `tests/scripts/repair-shared-package.test.ts`)
on scratch git repos.

Nothing is edited in place: every fixture lives under the gitignored
`.worklog/` scratch space (or a system temp dir for the no-root case).
