This directory contains lightweight, test-local mock binaries (`git`, `gh`, `wl`)
used by the CLI integration tests to simulate external commands deterministically.

## Purpose
- Provide deterministic, fast substitutes for real `git`, `gh`, and `wl` during tests
  so we can run init/sync flows without network or file-system flakiness.

## How it works
- `git` — A POSIX bash script implementing the git subcommands used by the test-suite
  (e.g., `init`, `clone`, `remote add`, `fetch`, `push`, `show`, `worktree add`,
  `ls-files`, `ls-remote`, `show-ref`). It keeps a small `fetch_store` under
  `.git/fetch_store/` so `git show <ref>:<path>` can be satisfied deterministically.
- `gh` — A POSIX bash script that intercepts `gh` issue view, edit, create, and API
  calls, seeded from a JSONL file.
- `wl` — A Node.js script returning predefined test data for common `wl` commands.

## Timeout Guard (all mocks)

All three mock scripts include a self-termination timeout to prevent orphaned
processes from running indefinitely. This is controlled by the environment variable:

```
WORKLOG_MOCK_TIMEOUT=10   # seconds (default: 5)
```

If a mock process runs longer than the configured timeout, it exits with code 124.
The timeout uses:
- **Bash mocks** (`git`, `gh`): `$SECONDS`-based wall-clock check at dispatch and
  loop boundaries, plus an iteration counter (max 100) in directory-walking loops.
- **Node.js mock** (`wl`): `setTimeout` that calls `process.exit(124)`.

## Integration with tests
- `tests/setup-tests.ts` prepends this directory to `PATH` so spawned child
  processes pick up these mocks instead of the system versions.

## Debugging
- **Mock git logs:** Set `WORKLOG_GIT_MOCK_DEBUG=1` to write debug traces to
  `/tmp/worklog-mock.log`.
- **Timeout guard:** Set `WORKLOG_MOCK_TIMEOUT=0` to disable the timeout guard
  (not recommended — may cause orphaned processes).

## Notes & guidance
- The mocks intentionally implement a tiny surface area. Extend them only for
  the specific subcommand shapes the application actually uses.
- Keep the mock scripts executable. If a file loses `+x` in your editor or CI, run:

  chmod +x tests/cli/mock-bin/git tests/cli/mock-bin/gh

## Contact
- If you need help extending a mock or debugging a failing test, leave a
  comment on the related work item and include `/tmp/worklog-mock.log` (set
  `WORKLOG_GIT_MOCK_DEBUG=1`).
