/**
 * CLI contract tests for critical-child priority promotion on `wl create`.
 *
 * When a new child is created with `--priority critical --parent <id>`, every
 * non-critical ancestor is promoted to `critical` — transitively to the root
 * (parent WL-0MWDD2JE6006CL7I, operator answer Q1-B / "promote to root").
 * The promotion is reported in JSON output (`promotedAncestors`) and as a
 * human-readable summary line, mirroring the existing `downgradedChildren`
 * reporting of `wl update --priority`.
 *
 * Work item: WL-0MWETWJQK008TIPE
 *
 * RED-pinned: the promotion tests are wrapped in `it.fails(...)` because the
 * create-side cascade lands with the sibling implementation children
 * (WL-0MWETWNSO001UL2M shared primitive, WL-0MWETWWBE005CJEL create wiring).
 * The pin keeps the gated suite green while the behaviour is pending; the
 * implementation child flips `it.fails(` → `it(` once `wl create` promotes.
 * The non-critical / own-priority specs assert behaviour that already holds
 * today and therefore stay green (`it`) either way.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
} from './cli-helpers.js';

/** An entry of `promotedAncestors` — a full WorkItem, nearest ancestor first. */
interface PromotedAncestor {
  id: string;
  priority: string;
}

describe('create priority promotion', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  async function createItem(title: string, flags = ''): Promise<string> {
    // --allow-duplicate: the dedup guard (WL-0MSTNG2QF0049B97) would
    // otherwise reuse a recent same-title item and collapse the parent/child
    // chains these tests build.
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json create -t "${title}" --allow-duplicate ${flags}`
    );
    return JSON.parse(stdout).workItem.id;
  }

  async function createItemJson(title: string, flags = ''): Promise<any> {
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json create -t "${title}" --allow-duplicate ${flags}`
    );
    return JSON.parse(stdout);
  }

  async function showItem(id: string): Promise<any> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    return JSON.parse(stdout).workItem;
  }

  /** Ids of the reported ancestors, nearest first. */
  function promotedIds(result: any): string[] {
    const entries = (result.promotedAncestors ?? []) as PromotedAncestor[];
    return entries.map((entry) => entry.id);
  }

  // =======================================================================
  // Behaviour that already holds — stays green while the cascade is pending
  // =======================================================================
  it('never promotes ancestors when the new child is not critical', async () => {
    const parents: Array<{ id: string; priority: string }> = [];
    for (const priority of ['medium', 'low'] as const) {
      parents.push({
        id: await createItem(`Non-critical parent ${priority}`, `-p ${priority}`),
        priority,
      });
    }

    for (const parent of parents) {
      const result = await createItemJson(
        `Non-critical child of ${parent.id}`,
        `-p high --parent ${parent.id}`
      );

      expect(result.success).toBe(true);
      expect(promotedIds(result)).toEqual([]);
      // Ancestor untouched in the database too.
      expect((await showItem(parent.id)).priority).toBe(parent.priority);
    }
  });

  it("keeps the created item's own priority exactly as requested", async () => {
    const parentId = await createItem('Parent for own-priority', '-p medium');

    const criticalChild = await createItem(
      'Critical child keeps its priority',
      `-p critical --parent ${parentId}`
    );
    expect((await showItem(criticalChild)).priority).toBe('critical');

    const highChild = await createItem(
      'High child keeps its priority',
      `-p high --parent ${parentId}`
    );
    expect((await showItem(highChild)).priority).toBe('high');
  });

  // =======================================================================
  // RED pins — the create-side promotion cascade (flip to `it` when it lands)
  // =======================================================================
  it.fails(
    'promotes the direct parent of a critical child and reports it in JSON',
    async () => {
      const parentId = await createItem('Promote direct parent', '-p medium');

      const result = await createItemJson(
        'Critical child of direct parent',
        `-p critical --parent ${parentId}`
      );

      expect(result.success).toBe(true);
      expect(Array.isArray(result.promotedAncestors)).toBe(true);
      expect(promotedIds(result)).toEqual([parentId]);
      expect(result.promotedAncestors[0].priority).toBe('critical');
      // The child's own priority is unchanged.
      expect(result.workItem.priority).toBe('critical');
      expect((await showItem(parentId)).priority).toBe('critical');
    },
    60_000
  );

  it.fails(
    'promotes every ancestor to the root when a grandchild is created critical',
    async () => {
      const root = await createItem('Deep root', '-p high');
      const middle = await createItem('Deep middle', `-p low --parent ${root}`);
      const parent = await createItem('Deep parent', `-p medium --parent ${middle}`);

      const result = await createItemJson(
        'Deep critical grandchild',
        `-p critical --parent ${parent}`
      );

      // Nearest-first walk order, all the way to the root.
      expect(promotedIds(result)).toEqual([parent, middle, root]);
      expect(
        result.promotedAncestors.every((a: PromotedAncestor) => a.priority === 'critical')
      ).toBe(true);
      expect((await showItem(parent)).priority).toBe('critical');
      expect((await showItem(middle)).priority).toBe('critical');
      expect((await showItem(root)).priority).toBe('critical');
      expect((await showItem(result.workItem.id)).priority).toBe('critical');
    },
    60_000
  );

  it.fails(
    'skips an already-critical ancestor but keeps promoting above it',
    async () => {
      const root = await createItem('Skip-walk root', '-p high');
      const alreadyCritical = await createItem(
        'Skip-walk already critical',
        `-p critical --parent ${root}`
      );
      const parent = await createItem(
        'Skip-walk parent',
        `-p medium --parent ${alreadyCritical}`
      );

      const result = await createItemJson(
        'Skip-walk critical child',
        `-p critical --parent ${parent}`
      );

      const ids = promotedIds(result);
      expect(ids).toEqual([parent, root]);
      // The already-critical ancestor is left untouched and not reported.
      expect(ids).not.toContain(alreadyCritical);
      expect((await showItem(alreadyCritical)).priority).toBe('critical');
      expect((await showItem(root)).priority).toBe('critical');
    },
    60_000
  );

  it.fails(
    'prints a human-readable summary line naming the promoted ancestors',
    async () => {
      const parentId = await createItem('Human summary parent', '-p medium');

      const { stdout } = await execAsync(
        `tsx ${cliPath} create -t "Human summary critical child" --allow-duplicate -p critical --parent ${parentId}`
      );

      const summaryLines = stdout
        .split('\n')
        .filter((line) => /promot/i.test(line));
      expect(summaryLines.length).toBeGreaterThan(0);
      expect(summaryLines.some((line) => line.includes(parentId))).toBe(true);
      expect((await showItem(parentId)).priority).toBe('critical');
    },
    60_000
  );
});
