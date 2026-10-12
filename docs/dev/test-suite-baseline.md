# Test Suite Baseline — Legacy `test/` Deduplication

**Work item:** WL-0MV4UZ6C4007XDGI (child of WL-0MV28X3BT0079JM3)
**Baseline commit:** `85679713a678b54417d4e994fc7f305c3ff75d38` (dev)
**Measured:** 2026-10-12

## Purpose

Record the pre-change baseline (test file count and suite runtime) for the
legacy `test/` vs `tests/` deduplication epic, so the post-change child
(`WL-0MV4V0IF9008214R`) can report a meaningful delta.

## Test file count (baseline)

Tracked test files matching the vitest include pattern:

```bash
git ls-files | grep -E '\.(test|spec)\.(ts|tsx|js|mjs|cjs)$' | wc -l
```

| Location | Test files |
|---|---|
| `packages/` | 115 |
| `test/` (legacy) | 9 |
| `tests/` | 234 |
| **Total** | **358** |

Vitest discovers 358 test files (357 passed, 1 skipped —
`tests/github-sync-load.long.test.ts`).

## Suite runtime (baseline)

### Full vitest suite (all packages)

Command (run from the worktree root, after `npm run build`):

```bash
npm run build          # build step
npm --silent test      # vitest run — the complete suite
```

Result:

| Metric | Value |
|---|---|
| Test files | 357 passed, 1 skipped (358) |
| Tests | 7851 passed, 5 skipped (7856) |
| Vitest duration | 243.30 s |
| Wall clock (`/usr/bin/time -v`) | 4:04.27 |

### Framework-declared canonical suite (`.pi/test-config.json`)

The implement/test/pre-push gates run the suite declared in
`.pi/test-config.json`:

```json
{
  "suiteCommands": [
    "npm --silent test -- tests/cli",
    "npm --silent test -- tests/unit"
  ],
  "timeoutPerCommand": 1800
}
```

Command (via the test skill, which records the run in the per-repo cache):

```bash
python3 /home/rgardler/.pi/agent/skills/test/scripts/run_tests.py --force --type full --json
```

Result:

| Suite | Test files | Tests | Vitest duration |
|---|---|---|---|
| `tests/cli` | 95 | 852 passed, 4 skipped (856) | 181.70 s |
| `tests/unit` | 31 | 519 passed (519) | 6.67 s |
| **Canonical total** | **126** | **1371 passed, 4 skipped (1375)** | **~188.4 s** |

> Note: the canonical suite is a subset of the full vitest suite. It does not
> include the legacy `test/` files at the repo root, nor most of `tests/`
> (only `tests/cli` and `tests/unit`), nor `packages/`, so the deduplication
> delta is most visible in the **full** suite numbers above.

## Environment

- Node/npm via the repo-managed `node_modules` (shared with the main checkout
  via symlink in the worktree).
- Machine load and CPU count affect wall-clock; treat durations as indicative,
  not exact. Both baseline and post-change runs must use the same commands
  and host for a like-for-like comparison.

## Reproduce

```bash
git checkout 85679713a678b54417d4e994fc7f305c3ff75d38
npm run build
npm --silent test                        # full suite
python3 <test-skill>/scripts/run_tests.py --force --type full --json   # canonical subset
```

## Related

- Parent epic: WL-0MV28X3BT0079JM3 — Deduplicate legacy `test/` vs `tests/`
  files and delete verbatim subsets
- Post-change measurement: WL-0MV4V0IF9008214R
