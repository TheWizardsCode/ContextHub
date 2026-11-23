/**
 * packages/herdr/src/host-dispatch-budget.legacy-removal.test.ts — repo-wide
 * reference scan for the legacy marker / token removal
 * (WL-0MWF34IEP00221NU, parent WL-0MW50EHZ6007QBPB AC5).
 *
 * The generalisation deleted the retired `active-audit` marker surface and the
 * old audit-saturation compat token outright — no shim, no read-compat path.
 * Deleting the symbols is not enough on its own: a doc comment, a test or a
 * re-export can reintroduce the vocabulary, which is exactly how a "retired"
 * token survives a release. This scan is the durable guard the acceptance
 * criteria ask for (the same check the implement gate runs by hand):
 *
 *  - `packages/herdr/src/**` (sources AND tests) must name none of the removed
 *    symbols;
 *  - every document under `docs/` must not quote them either.
 *
 * The banned names are assembled from fragments so this guard file is itself
 * clean under the repo-wide grep it performs.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SELF = fileURLToPath(import.meta.url);
const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Symbols deleted by the legacy-marker/token removal slice. */
const REMOVED_SYMBOLS: readonly string[] = [
  // machine-coordination.ts marker surface
  ['readActiveAudit', 'Marker'],
  ['isHostAudit', 'Active'],
  ['ActiveAudit', 'Marker'],
  ['DOWNTIME_HOST_AUDIT_MARKER', '_FILE'],
  ['DOWNTIME_AUDIT_HOST_STALE_WINDOW', '_MS'],
  // synthetic legacy-marker audit count
  ['legacyActiveAudit', 'Count'],
  ['reduceMarker', 'Counts'],
  // the removed audit-saturation compat token
  ['HOST_BUDGET_AUDIT_SATURATED', '_REFUSAL'],
  ['audit-host-', 'saturated'],
].map((fragments) => fragments.join(''));

/** Every `*.ts` file under `packages/herdr/src`, excluding this scan. */
function sourceFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true })
    .map((entry) => join(SRC_DIR, entry as string))
    .filter((file) => file.endsWith('.ts') && file !== SELF);
}

/** Every markdown document under `docs/`. */
function docFiles(): string[] {
  const docsDir = join(REPO_ROOT, 'docs');
  return readdirSync(docsDir, { recursive: true })
    .map((entry) => join(docsDir, entry as string))
    .filter((file) => file.endsWith('.md'));
}

/** Find each removed symbol in `files`, reported as `<relative path>: <symbol>`. */
function findReferences(files: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const symbol of REMOVED_SYMBOLS) {
      if (text.includes(symbol)) {
        offenders.push(`${relative(REPO_ROOT, file)}: ${symbol}`);
      }
    }
  }
  return offenders;
}

describe('legacy marker & token removal — repo-wide reference scan', () => {
  it('no removed symbol remains anywhere under packages/herdr/src', () => {
    expect(findReferences(sourceFiles())).toEqual([]);
  });

  it('no document under docs/ quotes a removed symbol', () => {
    expect(findReferences(docFiles())).toEqual([]);
  });
});
