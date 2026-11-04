# Shell Escaping Policy

## Goal

Prevent command injection vulnerabilities when user-provided text (work item titles, descriptions, comments, labels) is interpolated into shell commands.

## Escaping Functions

The codebase provides two shell‑escaping functions in `src/shell-escape.ts`:

### `escapeShellArg(arg: string): string`

Cross‑platform shell argument escaping.

- **POSIX (Linux, macOS):** Wraps the argument in single quotes. Any single quote inside the argument is escaped as `'\''` (end single‑quote, escaped literal quote, resume single‑quote).
- **Windows:** Wraps the argument in double quotes. Internal double quotes are escaped as `\"`.

Use `escapeShellArg` when constructing command strings passed to `execSync`, `execAsync`, or `spawn` with `shell: true`.

### `quoteShellValue(value: string): string`

POSIX‑only single‑quote wrapping (same as the POSIX branch of `escapeShellArg`). Re-exported by `src/github/transport.ts` for the GitHub integration, whose command builders (`src/github/issues.ts`, `src/github/hierarchy.ts`) call it.

## Audited Files

All files in `src/` that construct shell commands have been audited for proper escaping of user text.

| File | Escaping Used | Status |
|------|---------------|--------|
| `src/sync.ts` | `escapeShellArg()` | Safe — applied consistently |
| `src/github/issues.ts` | `quoteShellValue()` | Safe — every user‑provided value (title, assignee, label list) is single‑quote wrapped |
| `src/github/labels.ts` | `quoteShellValue()` | Safe — label names are single‑quote wrapped; colours are generated hex values |
| `src/github/hierarchy.ts` | `quoteShellValue()` | Safe — every interpolated value is single‑quote wrapped |
| `src/github/transport.ts` | Executes `gh` commands built upstream; interpolates no user text; re-exports `quoteShellValue()` | Safe — callers escape before building the command |
| `src/commands/sync.ts` | No user text in shell commands | Safe — hardcoded git commands only |
| `src/commands/init.ts` | No user text in shell commands | Safe — hardcoded git commands only |
| `src/worklog-paths.ts` | No user text in shell commands | Safe — hardcoded git command only |
| `src/pi-audit.ts` | `spawn()` with argument array, no shell | Safe — no shell parsing |
| `src/wl-integration/spawn.ts` | `spawn()` with `{ shell: false }` | Safe — no shell parsing |

## Best Practices

1. **Prefer non‑shell APIs.** Use `spawn()` / `execFile()` with argument arrays instead of `exec()` / `execSync()` with string commands. This avoids shell parsing entirely.
2. **When shell is required, always escape.** Use `escapeShellArg()` on every user‑provided value interpolated into the command string.
3. **Use `--body-file -` / `@-` for body/stdin data.** Pass large or complex user text through stdin instead of the command line.
4. **Prefer typed values over strings.** Numeric issue numbers, validated repo slugs (`owner/name`), and enum values are inherently safe and don't require escaping.

## Exceptions

None for the GitHub integration. Every module that interpolates user text into a
`gh` command string (`src/github/issues.ts`, `src/github/labels.ts`,
`src/github/hierarchy.ts`) uses `quoteShellValue()`.

> **Do not use `JSON.stringify()` for shell escaping.** It escapes only the
> characters special inside a JSON/JavaScript double‑quoted string (`"`, `\`,
> control characters). It does **not** escape `$`, backticks or `!`, so when the
> result is embedded in a shell double‑quoted context, `$(…)`, backticks and
> `${…}` are still substituted by `/bin/bash` — a command‑injection vector. The
> GitHub integration previously used `JSON.stringify()` for issue titles,
> assignees and label names; that was incorrect and has been replaced with
> `quoteShellValue()` (WL-0MW0QXTYD0065ZW7). The regression pinned in
> `tests/github-shell-escaping.test.ts` runs the built commands against a stub
> `gh` and asserts that `$(…)`, backtick and `!` payloads arrive literally and
> are never executed.
