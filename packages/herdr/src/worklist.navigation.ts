/**
 * packages/herdr/src/worklist.navigation.ts — navigation history and the
 * stage-filter cycler for the worklist.
 *
 * Single responsibility: the two small, self-contained navigation helpers —
 * `NavigationStack` (a LIFO of saved parent contexts the user returns to with
 * Escape) and `StageFilter` (cycles the CLI stages, `null` = off). No state of
 * the list itself, no rendering, no I/O. Leaf module: imports the stage
 * vocabulary from `worklist.constants.ts` and the entry type from
 * `worklist.types.ts` only (parent WL-0MVGKGD2Y0038S6B AC4 — no barrel
 * imports, no new cycles).
 *
 * Moved verbatim out of `worklist.ts` (parent WL-0MVGKGD2Y0038S6B; extraction
 * WL-0MVND6F9V004IQ3V). Move-only: no logic, rename or field-order change.
 */

import { STAGES, type Stage } from './worklist.constants.js';
import type { NavigationStackEntry } from './worklist.types.js';

// ── Navigation Stack ──────────────────────────────────────────────────

/**
 * A LIFO stack that tracks navigation history for hierarchical browsing.
 * Each entry captures the parent's scroll position and selection so they
 * can be restored when the user navigates back via Escape.
 */
export class NavigationStack {
  private stack: NavigationStackEntry[] = [];

  /**
   * Push a new entry onto the stack.
   */
  push(entry: NavigationStackEntry): void {
    this.stack.push(entry);
  }

  /**
   * Pop and return the top entry, or undefined if the stack is empty.
   */
  pop(): NavigationStackEntry | undefined {
    return this.stack.pop();
  }

  /**
   * Return the top entry without removing it, or undefined if empty.
   */
  peek(): NavigationStackEntry | undefined {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : undefined;
  }

  /**
   * Remove all entries from the stack.
   */
  clear(): void {
    this.stack = [];
  }

  /**
   * Remove the topmost entry whose parentId matches, if any.
   * Used when collapsing a parent: the saved context for that parent is no
   * longer reachable, so keeping it would make a later Escape pop into a
   * collapsed parent.
   */
  removeForParent(parentId: string): void {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].parentId === parentId) {
        this.stack.splice(i, 1);
        return;
      }
    }
  }

  /** Current depth of the navigation stack. */
  get depth(): number {
    return this.stack.length;
  }

  /** Whether the navigation stack is empty (at root level). */
  get isEmpty(): boolean {
    return this.stack.length === 0;
  }
}

// ── Stage filter helper ───────────────────────────────────────────────

export class StageFilter {
  private _current: string | null = null;
  private _index = -1;

  get current(): string | null {
    return this._current;
  }

  set(stage: string | null): void {
    this._current = stage;
    if (stage === null) {
      this._index = -1;
    } else {
      this._index = STAGES.indexOf(stage as Stage);
    }
  }

  /** Cycle to the next stage. Wraps around (including null/off). */
  cycle(): void {
    this._index += 1;
    if (this._index >= STAGES.length) {
      this._index = -1;
      this._current = null;
    } else {
      this._current = STAGES[this._index];
    }
  }
}
