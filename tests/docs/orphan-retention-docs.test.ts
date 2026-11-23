/**
 * Documentation contract for orphan retention and remediation
 * (WL-0MWGRLBJL007EZ72, parent WL-0MWFMKWZA005ZT4T; AC5/AC7).
 *
 * The behaviour itself is covered by `tests/cli/orphan-guard-*.test.ts`. This
 * suite covers the other half of the work item: the reference an operator reads
 * when a child survives its parent. Each assertion ties a documented claim to a
 * shipped behaviour, so a code change that is not carried into the docs (or a
 * doc rewrite that contradicts the code) fails here instead of shipping:
 *
 *   - CLI.md's `delete` section documents the explicit-orphaning opt-in and the
 *     attribution comment written on each surviving child;
 *   - CLI.md's `update` section documents the detach (`--parent null`)
 *     attribution comment and the promote-vs-retire rationale tokens;
 *   - CLI.md's `doctor` section lists `dangling-parents` and documents the
 *     cascade-or-refuse `--cascade-children` opt-in for the hard-delete paths;
 *   - CLI.md has a `doctor dangling-parents` section documenting the dry-run
 *     default, grouped orphan output and the retention remediation path;
 *   - DOCTOR_AND_MIGRATIONS.md documents the promote-when-live /
 *     retire-when-superseded retention rule, the remediation path, grouped
 *     orphan reporting (including soft-deleted parents) and the destructive
 *     cascade opt-ins.
 *
 * Sections are sliced out of the Markdown (heading → next heading of the same
 * or a higher level, code fences skipped) so a claim documented in an unrelated
 * section cannot satisfy an assertion here.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

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

describe('orphan retention and remediation documentation', () => {
  it('CLI.md documents explicit orphaning and its attribution comment on `delete`', () => {
    const section = markdownSection(readDoc('CLI.md'), /^###\s+`delete`/);
    expect(section, 'CLI.md has no `### `delete`` section').not.toBe('');

    // The explicit opt-in and the orphan comment on each surviving child.
    expect(section).toContain('--no-recursive');
    expect(section).toMatch(/orphan/i);
    expect(section).toMatch(/comment/i);
    expect(section).toMatch(/previous parent/i);
    // The comment is traceable back to the deleted parent.
    expect(section).toMatch(/trace|record|attribut/i);
  });

  it('CLI.md documents the `--parent null` detach attribution and rationale tokens on `update`', () => {
    const section = markdownSection(readDoc('CLI.md'), /^###\s+`update`/);
    expect(section, 'CLI.md has no `### `update`` section').not.toBe('');

    expect(section).toContain('--parent null');
    expect(section).toMatch(/comment/i);
    expect(section).toContain('promote-because-live');
    expect(section).toContain('retire-because-stale');
    expect(section).toMatch(/previous parent/i);
  });

  it('CLI.md lists `dangling-parents` and the cascade-or-refuse opt-in on `doctor`', () => {
    const section = markdownSection(readDoc('CLI.md'), /^###\s+`doctor`\s+\[options\]/);
    expect(section, 'CLI.md has no `### `doctor` [options]` section').not.toBe('');

    expect(section).toContain('dangling-parents');
    // Both hard-delete paths expose the destructive cascade opt-in.
    expect(section).toContain('--cascade-children');
    expect(section).toMatch(/refuse|protect/i);
  });

  it('CLI.md has a `doctor dangling-parents` section documenting dry-run, grouped output and retention', () => {
    const section = markdownSection(
      readDoc('CLI.md'),
      /^###\s+`doctor dangling-parents`/,
    );
    expect(section, 'CLI.md has no `### `doctor dangling-parents`` section').not.toBe('');

    // Dry-run is the default; --apply is the explicit write.
    expect(section).toContain('--dry-run');
    expect(section).toContain('--apply');
    // Orphans are summarised per lost parent, not only per child.
    expect(section).toMatch(/group/i);
    expect(section).toMatch(/per lost parent|keyed by|grouped by/i);
    // The retention decision an operator makes after a detach.
    expect(section).toMatch(/promote/i);
    expect(section).toMatch(/retire|close/i);
  });

  it('DOCTOR_AND_MIGRATIONS.md documents the retention rule, remediation path and grouped reporting', () => {
    const section = markdownSection(
      readDoc('DOCTOR_AND_MIGRATIONS.md'),
      /^###\s+Orphan retention and remediation/,
    );
    expect(
      section,
      'DOCTOR_AND_MIGRATIONS.md has no `### Orphan retention and remediation` section',
    ).not.toBe('');

    // The retention rule: promote while live, retire when superseded.
    expect(section).toMatch(/promote/i);
    expect(section).toMatch(/still live|subject is still live/i);
    expect(section).toMatch(/retire/i);
    expect(section).toMatch(/superseded/i);
    // The abandoned parent's feature was never delivered is the third retire
    // condition named by the plan.
    expect(section).toMatch(/never delivered|feature was never/i);
    // The remediation path for each branch.
    expect(section).toContain('--parent null');
    expect(section).toMatch(/`wl close|close/i);
    expect(section).toMatch(/delete/i);
    // Grouped orphan reporting, including the soft-deleted parent case.
    expect(section).toMatch(/group/i);
    expect(section).toMatch(/soft-deleted parent/i);
    // The rationale tokens recorded on promotion.
    expect(section).toContain('promote-because-live');
    expect(section).toContain('retire-because-stale');
  });

  it('DOCTOR_AND_MIGRATIONS.md documents the cascade-or-refuse opt-in for both hard-delete paths', () => {
    const md = readDoc('DOCTOR_AND_MIGRATIONS.md');

    const prune = markdownSection(md, /^###\s+Pruning deleted items/);
    expect(prune).toContain('--cascade-children');
    expect(prune).toMatch(/refused/i);

    const foreign = markdownSection(md, /^###\s+Detecting foreign work items/);
    expect(foreign).toContain('--cascade-children');
    expect(foreign).toMatch(/protected/i);
  });
});
