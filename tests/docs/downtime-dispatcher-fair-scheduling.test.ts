/**
 * Documentation contract for the enforced fair-scheduling rule and its metric
 * (WL-0MWKY1GK4001IFUD, parent WL-0MWKE9VF800101V9 AC7).
 *
 * The dispatcher page originally promised global cross-project round-robin and
 * a guarantee ("no single project can monopolise the downtime worker") that the
 * measured history did not meet. The fix items (WL-0MWKY1839000JM5O,
 * WL-0MWKY1CIJ00462ZD, WL-0MWKY141H002LULI) changed the rule to a whole-set
 * rotation plus a twice-in-succession bound. This suite pins the *documented*
 * contract so docs and code cannot drift silently:
 *
 *  - the enforced whole-set rotation and the twice-in-succession bound, with
 *    its condition (a peer has an admissible offer and surplus capacity exists),
 *  - that a selected-but-held root is never charged, and why,
 *  - the per-project fairness metric fields and a worked audit example,
 *  - the gate-asymmetry outcome and the gates it names,
 *  - the README repeating the bound rather than the old unqualified guarantee,
 *  - the bound constant in the source matching the documented number.
 *
 * Behaviour itself is covered by `coordination-leader.test.ts`,
 * `coordination-registered-root-sweep.test.ts` and
 * `downtime-worker.fairness-diagnosis.test.ts`; this suite covers only the
 * operator-facing half.
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

const DISPATCHER_DOC = path.join(REPO_ROOT, 'docs', 'dev', 'downtime-dispatcher.md');
const HERDR_README = path.join(REPO_ROOT, 'packages', 'herdr', 'README.md');
const FAIRNESS_SRC = path.join(
  REPO_ROOT,
  'packages',
  'herdr',
  'src',
  'downtime-worker.fairness.ts',
);
const LEADER_SRC = path.join(
  REPO_ROOT,
  'packages',
  'herdr',
  'src',
  'downtime-worker.coordination-leader.ts',
);
const HEAD_SCAN_SRC = path.join(
  REPO_ROOT,
  'packages',
  'herdr',
  'src',
  'downtime-worker.head-scan.ts',
);
const STORAGE_SRC = path.join(
  REPO_ROOT,
  'packages',
  'herdr',
  'src',
  'downtime-log-storage.ts',
);
const COORD_LOG_SRC = path.join(
  REPO_ROOT,
  'packages',
  'herdr',
  'src',
  'downtime-log-coordination.ts',
);

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/**
 * Prose assertions run against a whitespace-flattened view so a reflow of a
 * paragraph (Markdown wrapping is not a contract) cannot fail a claim.
 */
const flatDoc = read(DISPATCHER_DOC).replace(/\s+/g, ' ');
const flatReadme = read(HERDR_README).replace(/\s+/g, ' ');
const fairnessSrc = read(FAIRNESS_SRC);

/** The single source of truth for the documented bound. */
function boundFromSource(): number {
  const match = fairnessSrc.match(/export const RUN_LENGTH_CEILING = (\d+);/);
  if (match === null) throw new Error('RUN_LENGTH_CEILING not found in fairness source');
  return Number.parseInt(match[1], 10);
}

describe('downtime-dispatcher documents the enforced fair-scheduling rule', () => {
  it('states that the WHOLE admissible candidate set is rotated, not just the first choice', () => {
    expect(flatDoc).toContain('Enforced rule: rotate the whole admissible candidate set');
    expect(flatDoc).toContain('orders the **entire** entry list');
    expect(flatDoc).toContain('Unknown/new roots first');
    expect(flatDoc).toContain('least-recently-DISPATCHED root first');
    // The fall-through defect the rule fixes.
    expect(flatDoc).toContain('cannot leave the fall-through in raw file order');
  });

  it('states the twice-in-succession bound and its condition', () => {
    expect(flatDoc).toContain('The twice-in-succession bound');
    expect(flatDoc).toContain('dispatched **twice in succession** is deferred behind its peers');
    expect(flatDoc).toContain(
      'a peer root has an admissible offer and surplus capacity exists',
    );
    // Ordering only, never a gate: the bound must not read as a new hold.
    expect(flatDoc).toContain('This is an **ordering** rule, never a gate');
    // The exemption must be explicit: held peers do not arm the bound.
    expect(flatDoc).toContain('If every peer is held');
  });

  it('states that a selected-but-held root is never charged, and why', () => {
    expect(flatDoc).toContain('A selected-but-held root is never charged');
    expect(flatDoc).toContain('byte-identical');
    expect(flatDoc).toContain('the cursor records **last dispatch**, not last attempt');
    // The charge is defined by the consumed-offer predicate.
    expect(flatDoc).toContain('isConsumedDispatchOutcome');
  });

  it('no longer carries the old unqualified monopolisation guarantee', () => {
    expect(flatDoc).not.toContain(
      'This prevents any single project from monopolising the downtime worker',
    );
  });
});

describe('downtime-dispatcher documents the per-project fairness metric', () => {
  it('names the fairness fields and where they are recorded', () => {
    expect(flatDoc).toContain('Per-project fairness metric');
    expect(flatDoc).toContain('`selectedRoot`');
    expect(flatDoc).toContain('`dispatchingRoot`');
    expect(flatDoc).toContain('`consecutiveRunLength`');
    expect(flatDoc).toContain('`outcome`');
    // The sweep records the same fields, not a divergent shape.
    expect(flatDoc).toContain('registered-root sweep records the same fields');
  });

  it('works a night audit from the decision log alone', () => {
    expect(flatDoc).toContain('Worked example: auditing a night from the decision log alone');
    expect(flatDoc).toContain(
      'Derive the distribution by counting the `dispatchingRoot`',
    );
    // The two audit invariants that make the derivation trustworthy.
    expect(flatDoc).toContain('`no-dispatch` rows never break a run');
    expect(flatDoc).toContain('A held root is visible and uncharged');
  });
});

describe('downtime-dispatcher documents the gate-asymmetry outcome', () => {
  it('names the gates that hold prep work and records the fairness verdict', () => {
    expect(flatDoc).toContain('Gate asymmetry: which gates hold prep work');
    // The three gates the asymmetry is about.
    expect(flatDoc).toContain('isImplementHeldByReviewGate');
    expect(flatDoc).toContain('Host-CPU gate');
    expect(flatDoc).toContain('Audit slot minimum');
    // The ruled-out verdict, with its reason.
    expect(flatDoc).toContain('a real asymmetry, but not a fairness defect');
    expect(flatDoc).toContain('no admissible offer');
    expect(flatDoc).toContain('no gate was relaxed, reordered or duplicated');
  });
});

describe('docs and source agree on the documented bound', () => {
  it('pins the documented number to RUN_LENGTH_CEILING in the source', () => {
    const bound = boundFromSource();
    expect(bound).toBeGreaterThanOrEqual(2);
    // The prose spells the same bound out.
    expect(flatDoc).toContain(`RUN_LENGTH_CEILING = ${bound}`);
    expect(flatReadme).toContain(`RUN_LENGTH_CEILING = ${bound}`);
    // "twice in succession" is exactly ceiling 2; if the constant moves the
    // doc phrase above must move with it (this assertion fails first).
    if (bound === 2) {
      expect(flatDoc).toContain('dispatched **twice in succession**');
    }
  });

  it('keeps the module doc comments matching the documented rule', () => {
    const leader = read(LEADER_SRC).replace(/\s+/g, ' ');
    const headScan = read(HEAD_SCAN_SRC).replace(/\s+/g, ' ');
    expect(leader).toContain('Run-length bound (parent AC1)');
    expect(leader).toContain('dispatched twice in succession behind its peers');
    expect(headScan).toContain('run-length bound as the leader');
    expect(headScan).toContain('selection never charges');
  });
});

describe('herdr README repeats the enforced bound', () => {
  it('states the whole-set rotation and the bound rather than an unqualified guarantee', () => {
    expect(flatReadme).toContain('whole admissible candidate set');
    expect(flatReadme).toContain('twice in succession');
    expect(flatReadme).toContain(
      'a peer root has an admissible offer and surplus capacity exists',
    );
    expect(flatReadme).toContain('selected-but-held root is never charged');
    expect(flatReadme).toContain('RUN_LENGTH_CEILING = 2');
  });
});

describe('docs and source record the leadership-independent run-length source', () => {
  it('names the machine-scoped run ledger rather than the leader decision-log tail', () => {
    const leader = read(LEADER_SRC).replace(/\s+/g, ' ');
    const coord = read(COORD_LOG_SRC).replace(/\s+/g, ' ');
    // The module docblocks name the ledger as the ONE source and keep the
    // decision-log tail explicitly as the fail-open fallback only.
    expect(leader).toContain('machine-scoped run ledger');
    expect(leader).toContain('decision-log tail: fail-open fallback');
    expect(coord).toContain('the machine-scoped run ledger');
    expect(coord).toContain('whose fail-open fallback');
    expect(coord).toContain('is the tail of this decision log');
    // The docblock does not claim the decision log is the single source.
    expect(leader).not.toContain("decision log (the fairness metric's SINGLE run-length source)");
    expect(coord).not.toContain('derived from the tail of this decision log');
    // The operator-facing page describes the ledger too.
    expect(flatDoc).toContain('Run-length source: the machine run ledger');
  });

  it('states the measured retention window, not the retracted ≥ 24 h claim', () => {
    const storage = read(STORAGE_SRC).replace(/\s+/g, ' ');
    const coord = read(COORD_LOG_SRC).replace(/\s+/g, ' ');
    // The source constants document the measured window and the non-claim.
    expect(storage).toContain('Retained TIME is NOT bounded');
    expect(storage).toContain('≈ 6.5–9.7 h');
    expect(coord).toContain('it retains ≈ 6.5–9.7 h, NOT ≥ 24 h');
    // No stale assumption-driven claim survives in these docblocks.
    expect(storage).not.toContain('carries the 24 h retention');
    expect(storage).not.toContain('≥ 25 h at the observed ≥ 60');
    expect(coord).not.toContain('≈ ≥ 24 h at the');
    // The page states the measurement and points at the capture recipe.
    expect(flatDoc).toContain('the ≥ 24 h claim was wrong');
    expect(flatDoc).toContain('capture the aggregates while the evidence is live');
  });
});
