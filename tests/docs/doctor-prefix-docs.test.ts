/**
 * Documentation contract for `wl doctor prefix` (WL-0MVZ2U6R70030DBG, parent
 * WL-0MVM8V79C003XH2J).
 *
 * The command's behaviour is covered by `tests/cli/doctor-prefix.test.ts` and
 * `tests/unit/doctor-prefix-check.test.ts`. This suite covers the other half of
 * the work item: the documentation an operator reads *before* running it. A
 * rewrite of hundreds of IDs is only safe when the reference matches the
 * shipped command, so each spec ties a documented claim to a source of truth
 * that can drift independently of the prose:
 *
 *   - CLI.md's `doctor prefix` options are checked against the flags the CLI
 *     itself advertises (`wl doctor prefix --help` minus the global flags from
 *     `wl --help`), so adding/renaming an option without documenting it fails
 *     here instead of shipping an incomplete reference;
 *   - CLI.md's `doctor` subcommand list must mention the subcommand (a reader
 *     scanning the list must not conclude the command does not exist);
 *   - DOCTOR_AND_MIGRATIONS.md must document the migration path an operator
 *     follows (preview → confirm → rename map) plus its transactional rollback,
 *     idempotent replay and the out-of-scope external sweep;
 *   - MULTI_PROJECT_GUIDE.md must point at the managed rename instead of the
 *     stale "hand-edit the config and let old and new prefixes coexist" recipe.
 *
 * Sections are sliced out of the Markdown (heading → next heading of the same
 * or a higher level, code fences skipped) so a claim documented in an unrelated
 * section cannot satisfy an assertion here.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { cliPath, execAsync } from '../cli/cli-helpers.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

/** Read a repository-root document. */
function readDoc(name: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, name), 'utf-8');
}

/**
 * Slice a Markdown section: the heading that matches `headingPattern` up to
 * (excluding) the next heading of the same or a higher level. Lines inside a
 * fenced code block are never treated as headings, so a `# comment` in a shell
 * example cannot end the section early.
 */
function markdownSection(markdown: string, headingPattern: RegExp): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => headingPattern.test(line));
  if (start === -1) {
    return '';
  }
  const level = (lines[start].match(/^#+/) as RegExpMatchArray)[0].length;
  let end = lines.length;
  let inFence = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const heading = lines[i].match(/^(#+)\s/);
    if (heading && heading[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** Every long option (`--foo`) named by a CLI help text. */
function helpFlags(helpText: string): string[] {
  const flags = helpText.match(/(?<![\w-])--[a-z][a-z-]*/g) ?? [];
  return [...new Set(flags)].sort();
}

describe('wl doctor prefix documentation', () => {
  it(
    'CLI.md documents every option the CLI advertises for `doctor prefix`',
    async () => {
      const [{ stdout: commandHelp }, { stdout: rootHelp }] = await Promise.all([
        execAsync(`tsx ${cliPath} doctor prefix --help`),
        execAsync(`tsx ${cliPath} --help`),
      ]);

      // Options inherited from the top-level program (--json, --verbose, …) are
      // documented once in the global-options section; only the flags this
      // subcommand adds must appear in its own section.
      const globalFlags = new Set(helpFlags(rootHelp));
      const ownFlags = helpFlags(commandHelp).filter((flag) => !globalFlags.has(flag));
      expect(ownFlags).toEqual(['--apply', '--confirm', '--prefix', '--to']);

      const section = markdownSection(readDoc('CLI.md'), /^###\s+`doctor prefix`/);
      expect(section, 'CLI.md has no `### `doctor prefix`` section').not.toBe('');
      for (const flag of ownFlags) {
        expect(section, `CLI.md does not document ${flag}`).toContain(flag);
      }
    },
    60000,
  );

  it('CLI.md documents the preview default, the confirmation gate, JSON output and exit codes', () => {
    const section = markdownSection(readDoc('CLI.md'), /^###\s+`doctor prefix`/);

    // Preview is the default and never writes.
    expect(section).toMatch(/preview\s+is\s+the\s+default/i);
    expect(section).toMatch(/nothing is written|writes nothing|never writes/i);
    // Confirmation gate: interactive `y`, `--confirm` for non-interactive runs.
    expect(section).toMatch(/`y`/);
    expect(section).toMatch(/non-interactive/i);
    // Machine-readable output.
    expect(section).toMatch(/--json/);
    // Exit codes: success plus the refusal/validation contract.
    expect(section).toMatch(/exit codes?/i);
    expect(section).toMatch(/`1`/);
  });

  it('CLI.md lists `doctor prefix` among the doctor subcommands', () => {
    const section = markdownSection(readDoc('CLI.md'), /^###\s+`doctor`/);
    expect(section, 'CLI.md has no `### `doctor`` section').not.toBe('');
    expect(section).toContain('`prefix [options]`');
  });

  it('DOCTOR_AND_MIGRATIONS.md documents the rename path, rollback, replay and out-of-scope sweep', () => {
    const section = markdownSection(
      readDoc('DOCTOR_AND_MIGRATIONS.md'),
      /^###\s+Renaming the project prefix/,
    );
    expect(section, 'DOCTOR_AND_MIGRATIONS.md has no prefix-rename section').not.toBe('');

    // The operator's path: preview → confirm → rename map.
    expect(section).toMatch(/preview/i);
    expect(section).toContain('--confirm');
    expect(section).toContain('prefix-rename-<timestamp>.json');
    // Transactional/recoverable behaviour.
    expect(section).toMatch(/transaction/i);
    expect(section).toMatch(/roll(s|ed)?\b.*\bback/i);
    // Idempotent replay.
    expect(section).toMatch(/idempotent no-op/i);
    // Out-of-scope external reference sweep, enabled by the map.
    expect(section).toMatch(/out of scope/i);
    expect(section).toMatch(/(code comments|external reference)/i);
  });

  it('MULTI_PROJECT_GUIDE.md points at `wl doctor prefix` instead of the stale manual recipe', () => {
    const section = markdownSection(
      readDoc('MULTI_PROJECT_GUIDE.md'),
      /^##\s+Migrating Existing Data/,
    );
    expect(section, 'MULTI_PROJECT_GUIDE.md has no data-migration section').not.toBe('');

    expect(section).toContain('wl doctor prefix');
    expect(section).toContain('prefix-rename-<timestamp>.json');
    // The pre-command recipe claimed old and new prefixes could coexist; the
    // managed rename renumbers the whole backlog, so that advice is stale.
    expect(section).not.toMatch(/coexist/i);
  });
});
