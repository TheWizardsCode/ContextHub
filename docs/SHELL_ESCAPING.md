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

POSIX‑only single‑quote wrapping (same as the POSIX branch of `escapeShellArg`). Provided for backward compatibility with existing `src/github.ts` usage.

## Audited Files

All files in `src/` that construct shell commands have been audited for proper escaping of user text.

| File | Escaping Used | Status |
|------|---------------|--------|
| `src/sync.ts` | `escapeShellArg()` | Safe — applied consistently |
| `src/github.ts` | `JSON.stringify()`, `quoteShellValue()` | Safe — both provide equivalent protection |
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

`JSON.stringify()` is used in `src/github.ts` for shell escaping in gh CLI commands. This is safe because `JSON.stringify()` produces a properly quoted and escaped string that is valid in a shell context. However, `escapeShellArg()` is recommended for new code to maintain consistency.
