/**
 * packages/herdr/src/host-dispatch-budget.interactive.ts — the USER-FIRED
 * dispatch gate for the host-wide concurrency budget (WL-0MVXY0Z93002HKCZ F4,
 * parent WL-0MVXWQFGV000D2AB).
 *
 * `host-dispatch-budget.admission.ts` is the dispatcher's admission read (fail
 * CLOSED: an unreadable ledger refuses the tick). This module is the other
 * half of the contract: the path an operator takes when they fire
 * `/skill:implement` or `/skill:audit` BY HAND from the worklist. A human is
 * present and owns the decision, so the fail direction differs deliberately
 * (parent design, documented in `docs/dev/downtime-dispatcher.md`):
 *
 *  - **at / over cap** → ask first (the F4 dialog): cancel ⇒ NO claim, NO pane
 *    and NO ledger entry; proceed ⇒ the entry is reserved with
 *    `override: { by: 'user' }` so log/counter surfaces can tell a deliberate
 *    human override from drift.
 *  - **below cap** → no prompt, no extra keypress: reserve the entry and
 *    dispatch exactly as before (the ledger records user-fired work too, so
 *    the host budget is authoritative across dispatcher-fired and hand-fired
 *    work alike).
 *  - **unreadable ledger** (`unknown: true`) → FAIL OPEN with a visible notice
 *    and no reservation. A corrupt ledger must not block a human's shortcut.
 *  - **unresolvable coordination dir** → proceed silently: no machine dir
 *    means no ledger and no new failure mode (parent AC11).
 *
 * Counting semantics are the ledger's, never re-derived here: the implement
 * tier uses `liveCount` (fresh heartbeat AND pane in the machine-wide live
 * pane list). The audit tier quotes the pane-aware DISPLAY count the worklist
 * header shows (`auditDisplayCount` → `reduceAuditDisplayCounts`), so the
 * over-quota dialog never claims an audit is running when its pane is gone
 * (WL-0MW8IQNY7003JIOL). Admission itself is unchanged and still uses the
 * marker-compatible `freshCount`/`readAuditBudgetState` rule.
 *
 * The pane read is the tri-state (WL-0MW9VQX5T001GCUP): a FAILED read is
 * UNKNOWN, not "no panes". On unknown the implement tier counts by the
 * freshness rule (never reaps — a broken herdr read cannot delete ledger
 * state) and the audit display falls back to the marker-compatible count,
 * so the gate stays fail-open exactly as documented above.
 *
 * The gate runs BEFORE the claim and BEFORE any pane/background spawn, so a
 * cancel leaves every observable unchanged (AC2/AC6).
 */

import {
  HOST_BUDGET_STALE_WINDOW_MS,
  auditDisplayCount,
  liveCount,
  livePaneIdSet,
  readBudget,
  readBudgetConfig,
  reserve,
  type HostBudgetKind,
  type HostBudgetLivePane,
  type HostBudgetLivePanesResult,
  type HostBudgetOptions,
} from './host-dispatch-budget.js';
import { getMachineCoordinationDir } from './machine-coordination.js';
import type { HostBudgetDialogChoice, HostBudgetPromptRequest } from './host-budget-dialog.js';
import { extractWorkItemId } from './index.pane-capture.js';

/**
 * The visible fail-open notice text for an unreadable ledger (AC8).
 *
 * Exported so the wiring tests and operators can assert the exact sentence: a
 * human must be able to see WHY their shortcut skipped the quota check.
 */
export const HOST_BUDGET_UNREADABLE_NOTICE =
  'Host dispatch budget ledger unreadable — proceeding without the quota check.';

/**
 * The budget tier an agent command belongs to, or `undefined` when the
 * command is outside the budget (plan / intake / effort-and-risk / shell).
 *
 * `/skill:implement` covers the whole implement family
 * (`/skill:implement`, `/skill:implement-single`, `/skill:implementall`);
 * `/skill:audit` is the audit tier. Prefix matching on the first token keeps
 * the mapping independent of any trailing work-item id (which is extracted
 * separately by `extractWorkItemId`).
 */
export function budgetKindForAgentCommand(command: string): HostBudgetKind | undefined {
  const firstToken = command.trim().split(/\s+/)[0] ?? '';
  if (firstToken.startsWith('/skill:implement')) return 'implement';
  if (firstToken.startsWith('/skill:audit')) return 'audit';
  return undefined;
}

/** Injected seams for {@link prepareInteractiveAgentDispatch}. */
export interface InteractiveAgentDispatchDeps {
  /** Ask the human (worklist-backed in production; cancel when no TUI). */
  confirm(request: HostBudgetPromptRequest): Promise<HostBudgetDialogChoice>;
  /** Visible notice channel for the fail-open path (stderr in production). */
  notify(message: string): void;
  /**
   * Machine-wide live pane read — the tri-state (WL-0MW9VQX5T001GCUP):
   * `{ok:true}` carries an AUTHORITATIVE list, `{ok:false}` means pane
   * liveness UNKNOWN. Unknown must never be treated as "no panes": the
   * implement tier falls back to the freshness rule and nothing is ever
   * reaped on this state.
   */
  readLivePanes(): Promise<HostBudgetLivePanesResult>;
  /** Claim the item before the spawn (index.claim's claim function). */
  claim(command: string): Promise<void>;
  /** Absolute worklog root recorded on the ledger entry. */
  root: string;
  /** Instance identity recorded on the entry (diagnostics only). */
  instanceId?: string;
  /** Ledger clock/env/dir seams — tests pass a temp coordination dir. */
  budget?: HostBudgetOptions;
}

/** The gate's verdict for one user-fired agent dispatch. */
export interface InteractiveAgentDispatchPreparation {
  /** False only when the human cancelled (no claim, no pane, no ledger). */
  proceed: boolean;
  /** The budget tier the command belongs to (absent outside the budget). */
  kind?: HostBudgetKind;
  /** The work item the dispatch targets (absent when the command carries none). */
  itemId?: string;
  /** True when a ledger entry was reserved for this dispatch. */
  reserved: boolean;
  /** Set when the human deliberately proceeded over quota (AC7). */
  override?: { by: 'user' };
  /** Fail-open notice, when the ledger could not be trusted (AC8). */
  notice?: string;
}

/**
 * Read the tier's live count with the ledger's own per-tier semantics.
 *
 * Returns `null` when the ledger cannot be read but SHOULD exist (corrupt /
 * unreadable / lock contention) — the fail-open notice path. `{ live: 0 }`
 * for the unresolvable-coordination-dir case is handled by the caller via
 * `noLedger`, because that case must NOT produce a notice (parent AC11).
 *
 * The implement tier uses the admission rule `liveCount` (fresh heartbeat AND
 * pane in the live list). The audit tier quotes the pane-aware DISPLAY count
 * the worklist header shows (WL-0MW8IQNY7003JIOL): a confirmed audit whose
 * pane is gone must not inflate the dialog, so the operator sees the same
 * number on both surfaces. Admission itself is untouched — the dispatcher
 * still uses `freshCount`/`readAuditBudgetState` (fail-closed, marker-
 * compatible). This read is non-mutating: unlike `freshCount` it never reaps
 * or rewrites the ledger.
 *
 * `livePanes` of `undefined` = pane liveness UNKNOWN (WL-0MW9VQX5T001GCUP):
 * the implement branch counts by the freshness rule and never reaps, the
 * audit branch falls back to the marker-compatible count — a failed pane
 * read must neither delete entries nor invent a zero.
 */
type CountReadout =
  | { state: 'counted'; live: number }
  | { state: 'noLedger' }
  | { state: 'unreadable' };

function readTierCount(
  kind: HostBudgetKind,
  max: number,
  livePanes: readonly HostBudgetLivePane[] | undefined,
  dir: string | null,
  opts: HostBudgetOptions,
): CountReadout {
  // A disabled tier (`max 0`) admits nothing, so the count is irrelevant —
  // the prompt still quotes the documented 0/0 evidence.
  if (max === 0) return { state: 'counted', live: 0 };
  if (kind === 'implement') {
    // `livePanes` `undefined` = pane liveness UNKNOWN (WL-0MW9VQX5T001GCUP):
    // `liveCount` counts by the freshness rule and NEVER reaps on this state,
    // so the interactive gate cannot delete a stale-but-live entry.
    const result = liveCount(kind, livePanes, opts);
    if (!result.ok) {
      if (!result.unknown && result.reason === 'no-coordination-dir') {
        return { state: 'noLedger' };
      }
      return { state: 'unreadable' };
    }
    return { state: 'counted', live: result.count };
  }

  // Audit tier: pane-aware DISPLAY count, identical to the worklist header
  // (`readHostBudgetStatus` → `auditDisplayCount`). A trusted pane list lets
  // a confirmed entry whose pane is gone be excluded; without one (an
  // UNKNOWN pane read), fall back to the freshness rule rather than
  // inventing a zero.
  const read = readBudget(opts);
  if (!read.ok) {
    if (!read.unknown && read.reason === 'no-coordination-dir') {
      return { state: 'noLedger' };
    }
    return { state: 'unreadable' };
  }
  const now = opts.now ?? Date.now();
  const windowMs = opts.staleWindowMs ?? HOST_BUDGET_STALE_WINDOW_MS;
  const live = auditDisplayCount(
    read.ledger.entries,
    livePanes === undefined ? undefined : livePaneIdSet(livePanes),
    now,
    windowMs,
    dir,
  );
  return { state: 'counted', live };
}

/**
 * Decide whether a user-fired agent command may dispatch, prompting for an
 * over-quota override (AC2/AC5/AC6/AC7/AC8).
 *
 * Never throws for ledger/confirm failures except a `claim` rejection, which
 * is the caller's existing behaviour to swallow (a claim failure has never
 * blocked a dispatch).
 */
export async function prepareInteractiveAgentDispatch(
  command: string,
  deps: InteractiveAgentDispatchDeps,
): Promise<InteractiveAgentDispatchPreparation> {
  const kind = budgetKindForAgentCommand(command);
  const itemId = extractWorkItemId(command);
  if (kind === undefined || itemId === undefined) {
    // Outside the budget (no tier, or no work item to record): the claim path
    // is unchanged.
    await deps.claim(command);
    return { proceed: true, reserved: false };
  }

  const budgetOptions: HostBudgetOptions = { ...deps.budget };
  const { config } = readBudgetConfig(budgetOptions);
  const max = kind === 'implement' ? config.maxImplement : config.maxAudit;
  // Fail-open liveness read: a pane-list hiccup must not block a human. The
  // tri-state (WL-0MW9VQX5T001GCUP) distinguishes UNKNOWN (`undefined` here)
  // from an authoritative empty list: unknown falls back to the freshness rule
  // and never reaps, so a failed pane read cannot delete ledger state or
  // invent a zero. Trust (the former `livePanesTrusted` heuristic) derives
  // from the tri-state itself — `livePanes !== undefined` — not from a caught
  // throw (a `{ok:false}` result never throws).
  let livePanes: readonly HostBudgetLivePane[] | undefined = undefined;
  if (max !== 0) {
    try {
      const result = await deps.readLivePanes();
      livePanes = result.ok ? result.panes : undefined;
    } catch {
      livePanes = undefined; // a throwing seam is UNKNOWN too, never "no panes"
    }
  }
  const dir =
    budgetOptions.dir !== undefined
      ? budgetOptions.dir
      : getMachineCoordinationDir();
  const counted = readTierCount(
    kind,
    max,
    livePanes,
    dir,
    budgetOptions,
  );

  if (counted.state === 'noLedger') {
    // Parent AC11: no machine dir ⇒ no ledger, no new failure mode.
    await deps.claim(command);
    return { proceed: true, kind, itemId, reserved: false };
  }
  if (counted.state === 'unreadable') {
    // AC8: fail open with a visible notice; no reservation (the ledger cannot
    // be trusted, so it is never rewritten from this path).
    deps.notify(HOST_BUDGET_UNREADABLE_NOTICE);
    await deps.claim(command);
    return {
      proceed: true,
      kind,
      itemId,
      reserved: false,
      notice: HOST_BUDGET_UNREADABLE_NOTICE,
    };
  }

  const entryBase = {
    kind,
    itemId,
    root: deps.root,
    instanceId: deps.instanceId ?? `herdr:${process.pid}`,
  };

  if (counted.live < max) {
    // Below quota: no dialog, no extra keypress (AC2). Best-effort reservation
    // so hand-fired work counts against the budget like dispatcher-fired work.
    const reserved = reserve({ ...entryBase }, budgetOptions).ok;
    await deps.claim(command);
    return { proceed: true, kind, itemId, reserved };
  }

  // At or over cap: ask. `formatHostBudgetHeadline` (the dialog renderer)
  // quotes the same live/max/overshoot figures.
  const request: HostBudgetPromptRequest = { kind, live: counted.live, max };
  const choice = await deps.confirm(request);
  if (choice !== 'proceed') {
    // Cancel is the safe default: NO claim, NO pane, NO ledger entry (AC6).
    return { proceed: false, kind, itemId, reserved: false };
  }

  // Proceed anyway: record the deliberate human override (AC7).
  const override = { by: 'user' } as const;
  const reserved = reserve({ ...entryBase, override }, budgetOptions).ok;
  await deps.claim(command);
  return { proceed: true, kind, itemId, reserved, override };
}
