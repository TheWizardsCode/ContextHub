/**
 * packages/herdr/src/host-budget-relief.ts — model-blocked host-budget relief
 * (WL-0MWTAD9NV000IVK5, child WL-0MWTASWOE0033YEH).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS HEADER COMMENT IS THE CONTRACT OF RECORD FOR BUDGET RELIEF.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * ## Why this module exists
 *
 * The host-budget dispatcher counts every live `implement`/`audit` pane against
 * a configured cap (`maxImplement`, `maxAudit`) and refuses new work at that
 * cap. A pane parked in a machine-wide model cooldown is **not consuming the
 * model**: it is waiting for a throttled provider to come back. Counting it as
 * productive capacity idles the local LLM while the fleet waits, which is the
 * 2026-11-22/23 overnight failure this item fixes.
 *
 * A pane becomes **model-blocked** when the machine-wide cooldown signal
 * (`~/.herdr/downtime/model-cooldowns.json`, the contract in
 * `packages/shared/src/model-cooldown.ts`) carries an entry that matches the
 * pane (`paneId` first, then `sessionId`) and is still active
 * (`cooldownUntil > now`). While at least one model-blocked pane of a capped
 * kind exists, that kind's admission cap is **exactly 2x** its configured cap.
 *
 * ## The relief rule
 *
 *  - `effectiveCap(kind) = min(baseCap * 2, hardCeiling)` where
 *    `hardCeiling = baseCap * 2` — i.e. relief is exactly
 *    {@link HOST_BUDGET_RELIEF_MULTIPLIER}x and can never be more.
 *  - Relief is **per kind**: a blocked implement raises only `implement`; an
 *    audit pane raises only `audit`.
 *  - Relief is a **total live** cap: the blocked panes stay counted. The cap
 *    rises; the count is unchanged.
 *  - A disabled tier (`baseCap === 0`) is **never** revived by relief, and an
 *    uncapped kind (no configured cap) is never relieved.
 *  - Relief ends the instant the last matching cooldown expires or is cleared:
 *    this module is pure, so the next admission read recomputes the base cap.
 *    No restart, no cached double cap.
 *
 * The multiplier is a **fixed module constant**. No setting, `budget.json` key
 * or environment variable can raise it — the `2` is the hard ceiling itself.
 * `HOST_BUDGET_MAX = 32` bounds only the *configured* cap and must not clamp a
 * relieved cap (`min(2 * baseCap, 2 * baseCap)` is already bounded).
 *
 * ## Fail-closed direction (deliberately the OPPOSITE of the reader)
 *
 * {@link readModelCooldowns} returns `null` for an unreadable/corrupt signal
 * and its own contract tells consumers to treat `null` as "a cooldown may be
 * active" (the conservative branch for the mode switch). Relief inverts that
 * on purpose: an unreadable signal grants **no relief** and reports an evidence
 * reason naming the broken signal, because a corrupt file must never inflate
 * the host budget. An absent/empty signal (`[]`) grants no relief and carries
 * no unreadable evidence.
 *
 * ## No proxy availability signal
 *
 * This module consumes **only** the machine-wide cooldown file. A proxy
 * model-availability signal (`disabled`/`loading`/`switching`) is NOT read or
 * inferred; a future signal would need its own documented, tested change.
 *
 * ## One place for the arithmetic
 *
 * The predicate and the cap arithmetic live here and nowhere else. Admission
 * (`host-dispatch-budget.admission.ts`), the status counter and the decision
 * evidence all read this module; no other module re-derives the cap.
 */

import type { ModelCooldownEntry } from '@worklog/shared/model-cooldown';

import type { HostBudgetKind, HostBudgetLivePane } from './host-dispatch-budget.js';
import { decodeBudgetPaneLabel } from './host-dispatch-budget.repair.js';

/** The fixed relief multiplier. Immutable by contract — never a setting/env. */
export const HOST_BUDGET_RELIEF_MULTIPLIER = 2;

/** The capped kinds relief can raise (plan/intake/risk-effort are uncapped). */
export const HOST_BUDGET_RELIEF_KINDS = ['implement', 'audit'] as const;

/** A capped kind relief can raise. */
export type HostBudgetReliefKind = (typeof HOST_BUDGET_RELIEF_KINDS)[number];

/**
 * Evidence `reason` on a relief grant: at least one active model cooldown
 * matched a capped pane of this kind.
 */
export const HOST_BUDGET_RELIEF_REASON = 'model-blocked';

/**
 * Evidence `reason` on an unreadable/corrupt cooldown read. Relief is refused
 * (fail closed) and this token names the broken signal.
 */
export const HOST_BUDGET_RELIEF_UNREADABLE_REASON = 'model-cooldown-unreadable';

/** True for the two capped kinds relief can raise. */
export function isHostBudgetReliefKind(
  kind: HostBudgetKind | null | undefined,
): kind is HostBudgetReliefKind {
  return kind === 'implement' || kind === 'audit';
}

/**
 * One live pane as the relief predicate sees it. Extends the budget's live-pane
 * shape with the pi session id (derived by the caller from the pane's
 * `agent_session` path) so a session-only cooldown entry can match.
 */
export interface ReliefPane extends HostBudgetLivePane {
  /** pi session id, when the pane's agent session path is known. */
  sessionId?: string;
}

/** One model-blocked pane and the cooldown that blocked it. */
export interface ModelBlockedPane {
  paneId: string;
  sessionId?: string;
  kind: HostBudgetReliefKind;
  /** Epoch-ms instant the matching cooldown expires. */
  cooldownUntil: number;
}

/** The predicate result: blocked panes per capped kind. */
export interface ModelBlockedResolution {
  /** Model-blocked implement panes, in input order. */
  implement: ModelBlockedPane[];
  /** Model-blocked audit panes, in input order. */
  audit: ModelBlockedPane[];
  /**
   * True when the cooldown signal was unreadable/corrupt (`null`). Relief is
   * refused and {@link reason} names the broken signal.
   */
  unreadable: boolean;
  /** Evidence reason (`model-cooldown-unreadable`) only when `unreadable`. */
  reason?: string;
}

/** Input for {@link resolveModelBlockedPanes}. */
export interface ModelBlockedInput {
  /**
   * The active cooldowns from {@link readModelCooldowns}: a list, `[]` for
   * "nothing recorded", or `null` for "unreadable/corrupt".
   */
  cooldowns: readonly ModelCooldownEntry[] | null | undefined;
  /** The live panes to classify (blocked panes stay counted). */
  panes: readonly ReliefPane[];
  /** Injected clock (epoch ms). */
  now: number;
}

/**
 * Resolve the model-blocked panes of the two capped kinds.
 *
 * Matching is `paneId` first, then `sessionId` (a session-only entry with no
 * `paneId` matches only when the pane's session id is known). The kind comes
 * from the cooldown entry when it names `implement`/`audit`; otherwise from the
 * pane label. A pane with neither a capped entry kind nor a capped label kind is
 * not blocked. Pure and total: never throws, never reads the clock or I/O.
 */
export function resolveModelBlockedPanes(input: ModelBlockedInput): ModelBlockedResolution {
  const result: ModelBlockedResolution = {
    implement: [],
    audit: [],
    unreadable: false,
  };
  if (input.cooldowns === null) {
    result.unreadable = true;
    result.reason = HOST_BUDGET_RELIEF_UNREADABLE_REASON;
    return result;
  }
  const cooldowns = input.cooldowns ?? [];
  if (cooldowns.length === 0 || input.panes.length === 0) return result;

  for (const pane of input.panes) {
    const entry = matchActiveCooldown(pane, cooldowns, input.now);
    if (entry === null) continue;
    const kind = resolvedKind(entry, pane);
    if (kind === null) continue;
    const blocked: ModelBlockedPane = {
      paneId: pane.paneId,
      kind,
      cooldownUntil: entry.cooldownUntil,
      ...(pane.sessionId !== undefined ? { sessionId: pane.sessionId } : {}),
    };
    result[kind].push(blocked);
  }
  return result;
}

/** Match one pane to the first active cooldown by `paneId`, then `sessionId`. */
function matchActiveCooldown(
  pane: ReliefPane,
  cooldowns: readonly ModelCooldownEntry[],
  now: number,
): ModelCooldownEntry | null {
  const isActive = (entry: ModelCooldownEntry): boolean =>
    Number.isFinite(entry.cooldownUntil) && entry.cooldownUntil > now;
  // paneId first — the primary key. At least one entry should carry it.
  for (const entry of cooldowns) {
    if (entry.paneId !== null && entry.paneId === pane.paneId) {
      return isActive(entry) ? entry : null;
    }
  }
  // Fall back to the session id only when the pane's is known.
  if (pane.sessionId === undefined) return null;
  for (const entry of cooldowns) {
    if (entry.paneId === null && entry.sessionId === pane.sessionId) {
      return isActive(entry) ? entry : null;
    }
  }
  return null;
}

/** Resolve the capped kind for an entry: entry kind, else the pane label. */
function resolvedKind(
  entry: ModelCooldownEntry,
  pane: ReliefPane,
): HostBudgetReliefKind | null {
  if (isHostBudgetReliefKind(entry.kind)) return entry.kind;
  if (entry.kind !== null) return null; // a known non-capped kind: never relieves
  const decoded = decodeBudgetPaneLabel(pane.title);
  // An unknown token falls back to `implement` with `kindKnown: false` in the
  // repair decoder; that conservative over-count is for the LEDGER, not for
  // relief. Relief must not grant on an unknown label, so require known.
  if (!decoded.kindKnown) return null;
  return isHostBudgetReliefKind(decoded.kind) ? decoded.kind : null;
}

/** The decision-log evidence recorded on an admission or a refusal. */
export interface BudgetReliefEvidence {
  kind: HostBudgetKind;
  baseCap: number;
  effectiveCap: number;
  /** Pane ids whose active cooldown raised the cap. */
  blockedPaneIds: string[];
  /** `model-blocked` (granted) or `model-cooldown-unreadable` (refused). */
  reason: string;
  /** Latest matching `cooldownUntil`, or `null` when no relief is active. */
  until: number | null;
}

/** The effective-cap verdict for one kind. */
export interface EffectiveHostBudgetCap {
  /** The configured cap (unchanged). */
  baseCap: number;
  /** `baseCap * 2` while relieved, else `baseCap`. */
  effectiveCap: number;
  /** `null` when no relief is active; evidence otherwise. */
  relief: BudgetReliefEvidence | null;
}

/** Input for {@link resolveEffectiveHostBudgetCap}. */
export interface EffectiveHostBudgetCapInput {
  kind: HostBudgetKind;
  baseCap: number;
  /** The model-blocked panes for this kind (from the predicate). */
  blockedPanes?: readonly ModelBlockedPane[];
  /** Kill switch (`downtimeBudgetReliefEnabled`); defaults to enabled. */
  reliefEnabled?: boolean;
  /**
   * When the cooldown read was unreadable/corrupt, pass the evidence reason so
   * the verdict names the broken signal. Relief is always refused in that case
   * (fail closed).
   */
  unreadableReason?: string;
}

/**
 * Compute the effective admission cap for one kind.
 *
 * The configured cap is returned unchanged unless EVERY condition holds:
 * relief is enabled, the kind is capped (`baseCap > 0`), the kind is one of
 * {@link HOST_BUDGET_RELIEF_KINDS}, and at least one model-blocked pane of that
 * kind exists. The multiplier is the fixed module constant.
 */
export function resolveEffectiveHostBudgetCap(
  input: EffectiveHostBudgetCapInput,
): EffectiveHostBudgetCap {
  const baseCap = input.baseCap;
  const noRelief: EffectiveHostBudgetCap = { baseCap, effectiveCap: baseCap, relief: null };

  // Fail closed on an unreadable signal: no relief, but the evidence names it.
  if (input.unreadableReason !== undefined) {
    return {
      baseCap,
      effectiveCap: baseCap,
      relief: {
        kind: input.kind,
        baseCap,
        effectiveCap: baseCap,
        blockedPaneIds: [],
        reason: input.unreadableReason,
        until: null,
      },
    };
  }

  if (input.reliefEnabled === false) return noRelief;
  if (!isHostBudgetReliefKind(input.kind)) return noRelief;
  if (!(baseCap > 0)) return noRelief; // a disabled/uncapped tier is never relieved

  const blocked = (input.blockedPanes ?? []).filter((pane) => pane.kind === input.kind);
  if (blocked.length === 0) return noRelief;

  const hardCeiling = baseCap * HOST_BUDGET_RELIEF_MULTIPLIER;
  const effectiveCap = Math.min(baseCap * HOST_BUDGET_RELIEF_MULTIPLIER, hardCeiling);
  const until = blocked.reduce<number | null>(
    (latest, pane) =>
      latest === null || pane.cooldownUntil > latest ? pane.cooldownUntil : latest,
    null,
  );
  return {
    baseCap,
    effectiveCap,
    relief: {
      kind: input.kind,
      baseCap,
      effectiveCap,
      blockedPaneIds: blocked.map((pane) => pane.paneId),
      reason: HOST_BUDGET_RELIEF_REASON,
      until,
    },
  };
}
