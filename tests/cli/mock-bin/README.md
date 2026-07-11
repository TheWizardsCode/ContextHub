This directory contains a lightweight, test-local `git` mock used by the CLI integration
tests to simulate the small subset of git behaviour the test-suite depends on.

Purpose
- Provide a deterministic, fast substitute for real `git` during tests so we can
  run init/sync flows without network or bare-remote flakiness.

How it works
- The mock is a POSIX bash script that implements only the git subcommands used by
  the test-suite (e.g. `init`, `clone`, `remote add`, `fetch`, `push`, `show`,
  `worktree add`, `ls-files`, `ls-remote`, `show-ref`). It keeps a small `fetch_store`
  under `.git/fetch_store/` so `git show <ref>:<path>` can be satisfied deterministically.

Integration with tests
- `tests/setup-tests.ts` prepends this directory to `PATH` so spawned child
  processes pick up this mock `git` instead of the system `git`.

Debugging
- To enable verbose logging from the mock set the environment variable
  `WORKLOG_GIT_MOCK_DEBUG=1` when running tests. The mock writes debug traces to
  `/tmp/worklog-mock.log` when enabled.

Notes & guidance
- The mock intentionally implements a tiny surface area. If you add or change
  tests to call additional `git` subcommands or different argument shapes, extend
  the mock only for those shapes the app actually uses.
- Keep the mock script executable. If the file loses +x in your editor or CI, run:

  chmod +x tests/cli/mock-bin/git

Contact
- If you need help extending the mock or debugging a failing test, leave a
  comment on WL-0MLB6RMQ0095SKKE and include the failing test name plus
  `/tmp/worklog-mock.log` (set `WORKLOG_GIT_MOCK_DEBUG=1`).
