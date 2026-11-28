/**
 * Acceptance-criteria extraction — TypeScript ↔ Python parity.
 *
 * The TypeScript `extractAcceptanceCriteria` helper must return exactly what the
 * skills' reference `extract_acceptance_criteria` in
 * `skill/shared/tree_coverage.py` returns for the same description, field for
 * field (text and order). Without this guarantee the table back-fill (child 7)
 * and the description-parsing skills would drift from the first AC edit.
 *
 * The comparison fails on **any** disagreement. It skips only when the parity
 * oracle is genuinely unavailable — no `python3` on PATH or the skills helper
 * cannot be located — and records the concrete reason in the skipped result.
 *
 * Work item: WL-0MWXJGRML004YI6O.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAcceptanceCriteria } from '../../packages/shared/src/acceptance-criteria.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES_DIR = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'acceptance-criteria',
);

interface Fixture {
  name: string;
  shape: string;
  sourceWorkItemId: string;
  description: string;
  expected: string[];
}

function loadFixtures(): Fixture[] {
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map(
      (file) =>
        JSON.parse(
          fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'),
        ) as Fixture,
    );
}

/** Locate the skills directory containing `shared/tree_coverage.py`, or null. */
function findSkillsDir(): string | null {
  const candidates = [
    process.env.TREE_COVERAGE_SKILLS_DIR,
    path.join(os.homedir(), '.pi', 'agent', 'skills'),
    path.join(REPO_ROOT, '..', 'SorraAgents', 'skill'),
  ].filter((value): value is string => Boolean(value));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'shared', 'tree_coverage.py'))) {
      return dir;
    }
  }
  return null;
}

function pythonAvailable(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

type Oracle =
  | { kind: 'ok'; skillsDir: string }
  | { kind: 'skip'; reason: string };

/** Resolve the parity oracle once; a `skip` carries an explicit reason. */
function resolveOracle(): Oracle {
  if (!pythonAvailable()) {
    return { kind: 'skip', reason: 'python3 is not available on PATH' };
  }
  const skillsDir = findSkillsDir();
  if (!skillsDir) {
    return {
      kind: 'skip',
      reason:
        'skills helper shared/tree_coverage.py not found (looked in ' +
        'TREE_COVERAGE_SKILLS_DIR, ~/.pi/agent/skills and ../SorraAgents/skill)',
    };
  }
  return { kind: 'ok', skillsDir };
}

const ORACLE = resolveOracle();

/** Run the Python reference helper over many descriptions in one subprocess. */
function pythonExtractAll(
  skillsDir: string,
  descriptions: string[],
): string[][] {
  const script = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'from shared.tree_coverage import extract_acceptance_criteria',
    'payload = json.loads(sys.stdin.read())',
    'print(json.dumps([extract_acceptance_criteria(d) for d in payload]))',
  ].join('\n');
  const out = execFileSync(
    'python3',
    ['-c', script, skillsDir],
    {
      input: JSON.stringify(descriptions),
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return JSON.parse(out) as string[][];
}

describe('acceptance-criteria parity (TS vs Python tree_coverage)', () => {
  const fixtures = loadFixtures();

  it('returns the same criteria as the Python helper for every fixture', (ctx) => {
    if (ORACLE.kind === 'skip') {
      ctx.skip(`parity oracle unavailable: ${ORACLE.reason}`);
      return;
    }

    const python = pythonExtractAll(
      ORACLE.skillsDir,
      fixtures.map((fixture) => fixture.description),
    );
    expect(python).toHaveLength(fixtures.length);

    for (let i = 0; i < fixtures.length; i += 1) {
      const fixture = fixtures[i];
      // The recorded expected list is the ground truth; the Python helper and
      // the TypeScript helper must both reproduce it.
      expect(
        python[i],
        `Python output disagrees with recorded fixture: ${fixture.name} (${fixture.sourceWorkItemId})`,
      ).toEqual(fixture.expected);

      expect(
        extractAcceptanceCriteria(fixture.description),
        `TS/Python disagreement: ${fixture.name} (${fixture.sourceWorkItemId})`,
      ).toEqual(python[i]);
    }
  });

  it('agrees on marker rules the fixtures cannot all exhibit', (ctx) => {
    if (ORACLE.kind === 'skip') {
      ctx.skip(`parity oracle unavailable: ${ORACLE.reason}`);
      return;
    }

    const samples = [
      // Star bullets are not criteria markers.
      '## Acceptance Criteria\n* star one\n* star two\n- real bullet\n\n* star three\n',
      // A wrapped hyphenated word is rejoined without a space.
      '## Acceptance Criteria\n- high-\n  priority criterion\n',
      // A wrapped, spaced hyphen keeps the separating space.
      '## Acceptance Criteria\n- text -\n  more\n',
      // Fenced code blocks and table rows are not AC text.
      '## Acceptance Criteria\n- before\n```\n- code line\n```\n| a | b |\n- after\n',
      // A level-2 heading ends the section.
      '## Acceptance Criteria\n- keep me\n\n## Testing\n- not an ac\n',
      // No AC section at all.
      '## Summary\n- not an ac\n',
    ];

    const python = pythonExtractAll(ORACLE.skillsDir, samples);
    expect(samples.map((sample) => extractAcceptanceCriteria(sample))).toEqual(
      python,
    );
  });
});
