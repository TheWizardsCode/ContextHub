/**
 * Release-window vs. host dispatch-budget evaluation — documentation tests
 * (WL-0MW7YIBG70021YI3).
 *
 * The deliverable is analysis-only, so the evaluation document IS the artefact
 * under test. These assertions pin the facts an operator or future maintainer
 * must be able to find without re-deriving them from source:
 *
 *  - the code-freeze gate's tier table (what is skipped, what is allowed),
 *  - the per-root scope of the freeze vs. the host-wide scope of the ledger,
 *  - the release subprocesses that bypass the budget gate entirely,
 *  - the recorded recommendation (no dedicated release budget slot) and the
 *    residual gaps it leaves,
 *  - the cross-references from the dispatcher doc and the herdr README so the
 *    durable guidance is discoverable from the existing budget documentation.
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

const EVALUATION_DOC = path.join(
  REPO_ROOT,
  'docs',
  'dev',
  'release-dispatch-budget-evaluation.md',
);
const DISPATCHER_DOC = path.join(REPO_ROOT, 'docs', 'dev', 'downtime-dispatcher.md');
const HERDR_README = path.join(REPO_ROOT, 'packages', 'herdr', 'README.md');

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

const evaluation = read(EVALUATION_DOC);
const dispatcherDoc = read(DISPATCHER_DOC);
const readme = read(HERDR_README);

describe('release-window vs host-budget evaluation document', () => {
  it('records the recommendation: no dedicated release budget slot', () => {
    expect(evaluation).toMatch(/not recommended/i);
    expect(evaluation).toContain('code-freeze');
    // The rationale must rest on the ledger counting dispatched panes, not
    // release subprocesses.
    expect(evaluation).toMatch(/release subprocesses?/i);
    expect(evaluation).toMatch(/not\s+(?:a\s+)?(?:dispatched\s+)?pane/i);
  });

  it('tabulates which tiers the freeze skips and which it still allows', () => {
    // Skipped tiers.
    expect(evaluation).toMatch(/audit/);
    expect(evaluation).toMatch(/non-critical implement/i);
    expect(evaluation).toMatch(/critical[^\n]*implement[^\n]*skip/i);
    // Allowed tiers.
    expect(evaluation).toMatch(/plan/);
    expect(evaluation).toMatch(/intake/);
    expect(evaluation).toMatch(/critical[^\n]*(?:plan|intake)[^\n]*(?:still|allowed)/i);
    // Fail-closed ambiguity.
    expect(evaluation).toContain('ambiguous');
  });

  it('states that in-progress panes continue while new dispatches are prevented', () => {
    expect(evaluation).toMatch(/in-progress/i);
    expect(evaluation).toMatch(/continue/i);
  });

  it('records the per-root freeze vs host-wide ledger scope mismatch as the real gap', () => {
    expect(evaluation).toMatch(/per-root/i);
    expect(evaluation).toMatch(/host-wide|machine-scoped/i);
    expect(evaluation).toMatch(/another (?:project|root)|cross-project/i);
  });

  it('names every release subprocess that bypasses the budget gate', () => {
    expect(evaluation).toContain('audit_runner.py');
    expect(evaluation).toContain('run_tests.py');
    expect(evaluation).toMatch(/git\/gh|git merge|gh pr/);
    // The release's own skill is not a budget tier.
    expect(evaluation).toContain('/skill:ship');
  });

  it('is explicit that release subprocesses never pass through admission', () => {
    expect(evaluation).toMatch(/pass through the dispatcher'?s budget admission/i);
    expect(evaluation).toMatch(/admission/i);
  });

  it('records the residual subprocess-resource gap and its existing bounds', () => {
    expect(evaluation).toMatch(/SHIP_AUDIT_REMEDIATION|remediation budget/i);
    expect(evaluation).toMatch(/host-CPU gate|cpu-saturated/i);
    expect(evaluation).toMatch(/serial/i);
  });

  it('assesses the generalisation item and the release budget as separate concerns', () => {
    expect(evaluation).toContain('WL-0MW50EHZ6007QBPB');
    expect(evaluation).toMatch(/dispatch kinds?|work item types?/i);
  });

  it('links the follow-up implementation work item', () => {
    // The evaluation must not leave implementation implicit (AC6).
    expect(evaluation).toMatch(/WL-0M[A-Z0-9]+/);
    expect(evaluation).toMatch(/[Ff]ollow-up/);
  });

  it('records the evaluation date and the work-item id', () => {
    expect(evaluation).toContain('WL-0MW7YIBG70021YI3');
    expect(evaluation).toMatch(/20\d\d-\d\d-\d\d/);
  });
});

describe('durable guidance is discoverable from the budget documentation', () => {
  it('the dispatcher budget section links the evaluation', () => {
    expect(dispatcherDoc).toContain('release-dispatch-budget-evaluation.md');
    expect(dispatcherDoc).toMatch(/release window/i);
  });

  it('the herdr README budget bullet notes the release window bypass', () => {
    expect(readme).toMatch(/release(?:'s)?\s+(?:own\s+)?subprocesses/i);
    expect(readme).toMatch(/code-freeze/i);
  });
});
