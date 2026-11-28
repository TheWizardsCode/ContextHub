/**
 * packages/herdr/src/host-budget-relief.types.ts — the budget-relief evidence
 * shape, kept in a dependency-free leaf module.
 *
 * `DecisionEntryFields` (`downtime-worker.constants.ts`) and the dispatch
 * contracts reference {@link BudgetReliefEvidence}. Importing it from
 * `host-budget-relief.ts` would create a runtime import edge
 * (constants → relief → repair → host-dispatch-budget → … → constants) that
 * the split-guard rejects, so the type lives here with no imports of its own
 * and every consumer uses `import type`.
 *
 * Contract of record: `host-budget-relief.ts`.
 */

/** The decision-log evidence recorded on an admission or a refusal. */
export interface BudgetReliefEvidence {
  /** The capped kind relief evaluated (also used for uncapped kinds). */
  kind: string;
  /** The configured cap. */
  baseCap: number;
  /** `baseCap * 2` while relieved, else `baseCap`. */
  effectiveCap: number;
  /** Pane ids whose active cooldown raised the cap. */
  blockedPaneIds: string[];
  /** `model-blocked` (granted) or `model-cooldown-unreadable` (refused). */
  reason: string;
  /** Latest matching `cooldownUntil`, or `null` when no relief is active. */
  until: number | null;
}
