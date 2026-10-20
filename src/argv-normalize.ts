/**
 * argv normalisation helpers shared by the CLI fast path and the heavy entry.
 *
 * A Space-separated `--fields` continuation such as `--fields id, title` is
 * two shell tokens; Commander would treat the trailing token as the positional
 * search/query argument and silently drop the requested fields
 * (WL-0MSLW8GHQ0092PJK). This module has no dependencies so the thin fast path
 * (`src/cli.ts`) can normalise argv before deriving the read-cache key without
 * importing the heavy graph (F4 — WL-0MVFRRKKN00544PQ).
 *
 * `src/cli-utils.ts` re-exports it for existing callers.
 */

/**
 * Merge space-separated `--fields` continuations into a single value.
 *
 * @param argv - argument list without the leading node/script entries
 * @returns a new argument list with `--fields` continuations merged
 */
export function normalizeFieldsArgv(argv: readonly string[]): string[] {
  const out: string[] = [];

  // `--fields` is unique to list/search, but the `-f` shorthand is shared
  // with `--file` on export/import/migrate/sync/doctor. Only treat `-f` as
  // `--fields` when the invocation targets a command that defines it.
  const shortFlagIsFields = argv.includes('list') || argv.includes('search');

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === '--fields' || (token === '-f' && shortFlagIsFields)) {
      out.push(token);
      if (i + 1 < argv.length) {
        let value = argv[++i];
        while (
          value.trim().endsWith(',') &&
          i + 1 < argv.length &&
          !argv[i + 1].startsWith('-')
        ) {
          value += argv[++i];
        }
        out.push(value);
      }
      continue;
    }

    if (token.startsWith('--fields=')) {
      let value = token;
      while (
        value.trim().endsWith(',') &&
        i + 1 < argv.length &&
        !argv[i + 1].startsWith('-')
      ) {
        value += argv[++i];
      }
      out.push(value);
      continue;
    }

    out.push(token);
  }

  return out;
}
