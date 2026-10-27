# Missing shared build output: `wl` diagnostic and recovery

**Work item:** WL-0MVPADZ1Z000FOSG (parent AC4) · **Repository:** ContextHub

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
  Fix: run `npm run build:shared` in /home/…/ContextHub and retry.
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

```sh
cd <repository root>
npm run build:shared        # rebuild packages/shared/dist
```

`npm run build` also runs `build:shared` first, but the targeted script is the
fastest recovery.

## Tests

`tests/cli/missing-shared-dist.test.ts`:

- unit tests for `expectedSharedDistArtifactPath`, `sharedDistPreflight`
  (injected resolver: healthy / resolved-but-missing / resolution-throws /
  no-repo-root) and the diagnostic text;
- a CLI test that copies the **built** CLI into a temporary workspace layout,
  transpiles the current `src/cli.ts` over it (so a stale build cannot mask
  the change), removes `packages/shared/dist` and asserts the single-line
  diagnostic, the non-zero exit and the absence of `ERR_MODULE_NOT_FOUND`;
- a healthy control asserting `--version` and `--help` keep working with the
  build output present.

Nothing is edited in place: every fixture lives under the gitignored
`.worklog/` scratch space (or a system temp dir for the no-root case).
