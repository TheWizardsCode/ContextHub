/**
 * Acceptance-criteria extraction — shape-family characterisation tests.
 *
 * These tests pin the TypeScript `extractAcceptanceCriteria` helper against the
 * real-world AC shapes present in this store's worklog, so a regression names
 * the failing shape family. The fixtures under
 * `tests/fixtures/acceptance-criteria/` are read-only excerpts of real work-item
 * descriptions (see each fixture's `sourceWorkItemId`).
 *
 * The separate `acceptance-criteria-parity.test.ts` proves the TS helper returns
 * exactly what the skills' Python `extract_acceptance_criteria` returns for the
 * same text; this file proves the expected lists themselves are correct.
 *
 * Work item: WL-0MWXJGRML004YI6O.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAcceptanceCriteria } from '../../packages/shared/src/acceptance-criteria.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'acceptance-criteria');

interface Fixture {
  name: string;
  shape: string;
  sourceWorkItemId: string;
  description: string;
  expected: string[];
}

const fixtures: Fixture[] = fs
  .readdirSync(FIXTURES_DIR)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map(
    (file) =>
      JSON.parse(
        fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'),
      ) as Fixture,
  );

const byShape = new Map<string, Fixture[]>();
for (const fixture of fixtures) {
  const group = byShape.get(fixture.shape) ?? [];
  group.push(fixture);
  byShape.set(fixture.shape, group);
}

/** The five shape families the migration must reproduce. */
const MEASURED_SHAPES = ['checkbox', 'bold-led', 'numbered', 'wrapped', 'nested'];

describe('extractAcceptanceCriteria — fixture corpus', () => {
  it('covers every measured shape family', () => {
    const shapes = new Set(fixtures.map((fixture) => fixture.shape));
    for (const shape of MEASURED_SHAPES) {
      expect(shapes, `missing shape family: ${shape}`).toContain(shape);
    }
  });

  it('carries a non-empty expected list for every fixture', () => {
    for (const fixture of fixtures) {
      expect(
        fixture.expected.length,
        `fixture ${fixture.name} has no criteria`,
      ).toBeGreaterThan(0);
    }
  });

  // One describe block per family so a failing test names the shape family.
  for (const shape of [...byShape.keys()].sort()) {
    describe(`shape family: ${shape}`, () => {
      for (const fixture of byShape.get(shape) as Fixture[]) {
        it(`extracts ${fixture.name} exactly (${fixture.sourceWorkItemId})`, () => {
          expect(extractAcceptanceCriteria(fixture.description)).toEqual(
            fixture.expected,
          );
        });
      }
    });
  }
});

describe('extractAcceptanceCriteria — marker rules', () => {
  it('recognises both - and + top-level bullets', () => {
    expect(
      extractAcceptanceCriteria(
        ['## Acceptance Criteria', '- dash bullet', '+ plus bullet'].join('\n'),
      ),
    ).toEqual(['dash bullet', 'plus bullet']);
  });

  it('recognises both period- and paren-numbered ordered items', () => {
    expect(
      extractAcceptanceCriteria(
        ['## Acceptance Criteria', '1. period item', '2) paren item'].join('\n'),
      ),
    ).toEqual(['period item', 'paren item']);
  });

  it('does not recognise * star bullets as criteria markers', () => {
    // Star bullets are ignored entirely when no AC is open, so they never
    // become criteria.
    expect(
      extractAcceptanceCriteria(
        [
          '## Acceptance Criteria',
          '* star one',
          '* star two',
          '- real bullet',
          '',
          '* star three',
        ].join('\n'),
      ),
    ).toEqual(['real bullet']);
  });

  it('keeps checkbox markers as criterion text (does not strip [ ] / [x])', () => {
    expect(
      extractAcceptanceCriteria(
        ['## Acceptance Criteria', '- [ ] todo item', '- [x] done item'].join('\n'),
      ),
    ).toEqual(['[ ] todo item', '[x] done item']);
  });

  it('treats markers indented deeper than the first as nested detail', () => {
    expect(
      extractAcceptanceCriteria(
        [
          '## Acceptance Criteria',
          '- parent criterion',
          '  - nested detail one',
          '  - nested detail two',
          '- sibling criterion',
        ].join('\n'),
      ),
    ).toEqual(['parent criterion', 'sibling criterion']);
  });

  it('joins hard-wrapped continuation lines with a single space', () => {
    expect(
      extractAcceptanceCriteria(
        [
          '## Acceptance Criteria',
          '- a criterion that wraps',
          '  onto the next physical line',
          '  and a third',
        ].join('\n'),
      ),
    ).toEqual(['a criterion that wraps onto the next physical line and a third']);
  });

  it('rejoins a word hyphenated across a wrap without a space', () => {
    expect(
      extractAcceptanceCriteria(
        ['## Acceptance Criteria', '- high-', '  priority criterion'].join('\n'),
      ),
    ).toEqual(['high-priority criterion']);
  });

  it('keeps a spaced hyphen as a separator', () => {
    expect(
      extractAcceptanceCriteria(
        ['## Acceptance Criteria', '- text -', '  more'].join('\n'),
      ),
    ).toEqual(['text - more']);
  });
});

describe('extractAcceptanceCriteria — section boundaries', () => {
  it('returns an empty list when there is no AC section', () => {
    expect(
      extractAcceptanceCriteria('## Summary\n- not an acceptance criterion\n'),
    ).toEqual([]);
  });

  it('matches the AC heading case-insensitively and at any depth', () => {
    expect(
      extractAcceptanceCriteria('### acceptance criteria\n- one\n'),
    ).toEqual(['one']);
  });

  it('stops at the next level-2 heading', () => {
    expect(
      extractAcceptanceCriteria(
        [
          '## Acceptance Criteria',
          '- keep me',
          '',
          '## Testing',
          '- not an acceptance criterion',
        ].join('\n'),
      ),
    ).toEqual(['keep me']);
  });

  it('flushes the open entry at a blank line so later text is not merged', () => {
    expect(
      extractAcceptanceCriteria(
        ['## Acceptance Criteria', '- first criterion', '', 'orphan paragraph'].join(
          '\n',
        ),
      ),
    ).toEqual(['first criterion']);
  });

  it('ignores fenced code blocks and keeps criteria on either side', () => {
    expect(
      extractAcceptanceCriteria(
        [
          '## Acceptance Criteria',
          '- before code',
          '```',
          '- code line',
          '```',
          '- after code',
        ].join('\n'),
      ),
    ).toEqual(['before code', 'after code']);
  });

  it('ignores markdown table rows', () => {
    expect(
      extractAcceptanceCriteria(
        [
          '## Acceptance Criteria',
          '- before table',
          '| column | hidden |',
          '- after table',
        ].join('\n'),
      ),
    ).toEqual(['before table', 'after table']);
  });

  it('treats a thematic break as a boundary, not a criterion', () => {
    expect(
      extractAcceptanceCriteria(
        ['## Acceptance Criteria', '- before rule', '---', '- after rule'].join('\n'),
      ),
    ).toEqual(['before rule', 'after rule']);
  });
});
