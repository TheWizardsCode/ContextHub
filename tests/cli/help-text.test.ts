/**
 * Help-text and documentation contract for cross-repo dependencies
 * (WL-0MVWEETA9006LFED, parent WL-0MVWABT2Z001XMSD, parent AC6).
 *
 * The behaviour of foreign dependency edges, gating and clone remediation is
 * covered by the cross-repo suites (`tests/cross-repo-dep-edges.test.ts`,
 * `tests/cross-repo-gating.test.ts`, `tests/cross-repo-discovery.test.ts`,
 * `tests/cross-repo-project-add.test.ts`). This module covers the other half of
 * AC6: what an operator reads *before* running the commands.
 *
 * Every spec ties a documented claim to a source of truth that can drift
 * independently of the prose:
 *
 *   - the `wl dep` / `wl project` help text must state that foreign ids are
 *     supported (the AC's explicit help-text assertion);
 *   - every non-global flag the CLI advertises for `dep add|rm|list` and
 *     `project list|add` must appear in that command's `CLI.md` section, so a
 *     new option cannot ship undocumented;
 *   - `CLI.md` must carry the `unknown_project` payload and the foreign-id
 *     support for all three `dep` subcommands;
 *   - `MULTI_PROJECT_GUIDE.md` must carry a "Cross-repo dependencies" section
 *     covering the discovery rule (genuine-store markers, worktree stubs
 *     excluded), duplicate-prefix ambiguity, the fail-safe `unresolved`
 *     behaviour, the three `foreign_dependency` states and the clone
 *     remediation flow;
 *   - `README.md` must mention cross-repo dependencies and link to that
 *     section.
 *
 * The JSON fields these docs describe are asserted behaviourally elsewhere —
 * `foreign`, `foreign_dependency`, `unresolved`, `blocking`, `reason` in
 * `cross-repo-gating.test.ts` / `cross-repo-dep-edges.test.ts`;
 * `error_code: "unknown_project"`, `prefix`, `projects_root`, `remediation` in
 * `cross-repo-gating.test.ts`; `projectsRoot`, `projects`, `ambiguous`,
 * `warnings` in `cross-repo-discovery.test.ts`; `cloned`, `gitUrl`,
 * `prefix_mismatch`, `clone_failed`, `missing_git_url` in
 * `cross-repo-project-add.test.ts`. This suite keeps the prose in step with
 * those assertions.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runCliProcess } from './cli-bundle.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

/** Every long option (`--foo`) named by a CLI help text, sorted and unique. */
function helpFlags(helpText: string): string[] {
  const flags = helpText.match(/(?<![\w-])--[a-z][a-z-]*/g) ?? [];
  return [...new Set(flags)].sort();
}

/** Run a `wl …` help invocation through the pre-compiled bundle. */
function help(args: string[]): string {
  const result = runCliProcess([...args, '--help'], { timeout: 60000 });
  expect(result.status, `wl ${args.join(' ')} --help failed: ${result.stderr}`).toBe(0);
  return result.stdout;
}

describe('cross-repo dependency help text', () => {
  it('`wl dep --help` states that foreign cross-project ids are supported', () => {
    const text = help(['dep']);
    expect(text).toMatch(/foreign cross-project ids/i);
    expect(text).toMatch(/supported/i);
  });

  it('every `dep` subcommand advertises its foreign-id support', () => {
    for (const sub of ['add', 'rm', 'list']) {
      const text = help(['dep', sub]);
      expect(text, `wl dep ${sub} --help does not mention foreign ids`).toMatch(
        /foreign cross-project (id|targets)/i,
      );
    }
  });

  it('`wl project --help` describes cross-repo dependency discovery and both subcommands', () => {
    const text = help(['project']);
    expect(text).toMatch(/cross-repo dependencies/i);
    expect(text).toContain('list');
    expect(text).toContain('add');
    // `add` is the remediation for an unknown prefix — a reader must be able to
    // connect the two commands from the help text alone.
    expect(help(['project', 'add'])).toMatch(/unknown_project/);
  });
});

describe('CLI.md documents the cross-repo command surface', () => {
  it(
    'documents every non-global flag the `dep` subcommands advertise',
    () => {
      const globalFlags = new Set(helpFlags(help([])));
      const documented = markdownSection(readDoc('CLI.md'), /^###\s+`dep`/);
      expect(documented, 'CLI.md has no `### `dep`` section').not.toBe('');

      const expected: Record<string, string[]> = {
        add: ['--prefix'],
        rm: ['--prefix'],
        list: ['--incoming', '--outgoing', '--prefix'],
      };
      for (const [sub, expectedFlags] of Object.entries(expected)) {
        const ownFlags = helpFlags(help(['dep', sub])).filter(
          (flag) => !globalFlags.has(flag),
        );
        expect(ownFlags, `wl dep ${sub} advertises unexpected flags`).toEqual(expectedFlags);
        for (const flag of ownFlags) {
          expect(documented, `CLI.md does not document \`dep ${sub}\` ${flag}`).toContain(flag);
        }
      }
    },
    120000,
  );

  it(
    'documents every non-global flag the `project` subcommands advertise',
    () => {
      const globalFlags = new Set(helpFlags(help([])));
      const documented = markdownSection(readDoc('CLI.md'), /^###\s+`project`/);
      expect(documented, 'CLI.md has no `### `project`` section').not.toBe('');

      const expected: Record<string, string[]> = {
        list: ['--projects-root'],
        add: ['--git-url', '--interactive', '--path', '--projects-root'],
      };
      for (const [sub, expectedFlags] of Object.entries(expected)) {
        const ownFlags = helpFlags(help(['project', sub])).filter(
          (flag) => !globalFlags.has(flag),
        );
        expect(ownFlags, `wl project ${sub} advertises unexpected flags`).toEqual(expectedFlags);
        for (const flag of ownFlags) {
          expect(documented, `CLI.md does not document \`project ${sub}\` ${flag}`).toContain(flag);
        }
      }
    },
    120000,
  );

  it('documents foreign-id support for all three `dep` subcommands', () => {
    const section = markdownSection(readDoc('CLI.md'), /^###\s+`dep`/);

    // The foreign-id paragraph must name every subcommand it applies to.
    const start = section.indexOf('Foreign (cross-project) ids');
    expect(start, 'CLI.md has no foreign cross-project ids paragraph').toBeGreaterThanOrEqual(0);
    const end = section.indexOf('\n\n', start);
    const paragraph = section.slice(start, end === -1 ? undefined : end);

    for (const sub of ['`dep add`', '`dep rm`', '`dep list`']) {
      expect(paragraph, `the foreign-id paragraph does not name ${sub}`).toContain(sub);
    }
    // Read-only resolution is the isolation contract an operator must know.
    expect(paragraph).toMatch(/read-only/i);
  });

  it('documents the `unknown_project` remediation payload and the `project add` mapping fields', () => {
    const depSection = markdownSection(readDoc('CLI.md'), /^###\s+`dep`/);
    expect(depSection).toContain('"error_code": "unknown_project"');
    expect(depSection).toContain('projects_root');
    expect(depSection).toContain('remediation');

    const projectSection = markdownSection(readDoc('CLI.md'), /^###\s+`project`/);
    expect(projectSection).toContain('projectsRoot');
    expect(projectSection).toContain('ambiguous');
    expect(projectSection).toContain('cloned');
    expect(projectSection).toContain('gitUrl');
    expect(projectSection).toContain('prefix_mismatch');
    expect(projectSection).toContain('clone_failed');
    expect(projectSection).toContain('missing_git_url');
  });
});

describe('MULTI_PROJECT_GUIDE.md cross-repo dependency section', () => {
  const guide = readDoc('MULTI_PROJECT_GUIDE.md');
  const section = markdownSection(guide, /^##\s+Cross-repo dependencies/);

  it('exists and documents the discovery rule with genuine-store markers', () => {
    expect(section, 'MULTI_PROJECT_GUIDE.md has no "Cross-repo dependencies" section').not.toBe('');
    expect(section).toContain('.worklog/initialized');
    expect(section).toContain('.worklog/worklog.db');
    // Worktree-shaped stubs are explicitly excluded, non-git/hidden folders too.
    expect(section).toMatch(/worktree-shaped stub/i);
    expect(section).toMatch(/excluded/i);
    expect(section).toContain('projectsRoot');
  });

  it('documents duplicate-prefix ambiguity without guessing', () => {
    expect(section).toMatch(/ambiguous/i);
    expect(section).toMatch(/never guess|never guessing|instead of picking/i);
  });

  it('documents the fail-safe `unresolved` behaviour', () => {
    expect(section).toMatch(/never silently\s+unblocks/i);
    expect(section).toContain('unresolved: true');
    expect(section).toContain('--include-blocked');
    expect(section).toContain('dependency.foreign-unresolved');
  });

  it('documents all three `foreign_dependency` states and what each one blocks', () => {
    for (const state of ['`resolved`', '`unresolved`', '`unavailable`']) {
      expect(section, `the guide does not document ${state}`).toContain(state);
    }
    expect(section).toContain('`blocking`');
    expect(section).toContain('coordination note');
  });

  it('documents the clone remediation flow end to end', () => {
    expect(section).toContain('unknown_project');
    expect(section).toContain('wl project add');
    expect(section).toContain('--git-url');
    expect(section).toContain('--interactive');
    expect(section).toContain('cloned');
    expect(section).toContain('prefix_mismatch');
    expect(section).toContain('clone_failed');
    // The remediation is a retry loop: clone, then re-run the failing command.
    expect(section).toMatch(/re-run the `dep` command/i);
  });

  it('documents the foreign `dep` commands it describes', () => {
    for (const command of ['wl dep add', 'wl dep rm', 'wl dep list']) {
      expect(section, `the guide does not show ${command}`).toContain(command);
    }
    expect(section).toMatch(/read-only/i);
  });
});

describe('README.md entry point', () => {
  const readme = readDoc('README.md');

  it('mentions cross-repo dependencies and links to the guide section', () => {
    expect(readme).toMatch(/cross-repo dependencies/i);
    expect(readme).toContain('MULTI_PROJECT_GUIDE.md#cross-repo-dependencies');
  });
});
