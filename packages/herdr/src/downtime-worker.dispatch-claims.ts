/**
 * packages/herdr/src/downtime-worker.dispatch-claims.ts — the claim → marker →
 * spawn pipeline a dispatch runs once a candidate is selected.
 *
 * Single responsibility: run ONE already-selected candidate (or one due
 * scheduled prompt) through the fixed, fail-closed pipeline — placement
 * resolution, CAS claim, local-capacity reservation, marker write before
 * spawn, spawn, claim rollback on failure, best-effort post-spawn enrichment.
 *
 * Parent: WL-0MVF3F9A7000HKP7 (decompose the `downtime-worker.ts` god class).
 * Moved verbatim out of `downtime-worker.ts` by WL-0MVLII0NO007JJBA (extract
 * the downtime-worker dispatch pipeline). Internal to the dispatch entry: not
 * re-exported by the barrel (only consumer-used symbols are public). No
 * behaviour change: claim CAS semantics, rollback rules, marker fields, spawn
 * call sites and log lines are identical.
 */

import {
  BACKGROUND_LOCAL_PREFERENCE,
  resolveDispatchLocalPreferenceDecision,
  type LocalPreference,
  type LocalPreferenceMode,
  type LocalPreferenceReason,
} from './local-preference.js';
import { buildLocalReservationRequest } from './downtime-worker.local-reservation.js';
import { buildDowntimePrompt } from './downtime-worker.prompts.js';
import { TIER_EXPECTED } from './downtime-worker.gates.js';
import {
  DOWNTIME_PANE_LABEL_PREFIX,
  countRunningDowntimePanes,
  paneLabelItemId,
} from './downtime-worker.pane.js';
import type { ScheduledPrompt } from './scheduled-prompts.js';
import type {
  DispatcherAnchor,
  DispatcherPrefixTabAnchor,
  ItemTabAnchor,
  ProjectWorkspaceTarget,
} from './dispatcher-anchor.js';
import type {
  DowntimeDispatchDeps,
  DowntimeDispatchOutcome,
  DowntimeReservationEvidence,
} from './downtime-worker.dispatch-contract.js';
import type {
  DowntimeCandidate,
  DowntimeClaimExpected,
  DowntimeSkillKind,
  LocalReservationResult,
} from './downtime-worker.types.js';

/**
 * Roll back a failed dispatch's CAS claim (WL-0MT32F908002YFFA) without ever
 * crashing the worker: `deps.rollbackClaim` is contracted never to throw, but
 * a throwing stub/regression must be swallowed here too (fail-closed — the
 * item simply stays claimed, no worse than the pre-fix state).
 */
export async function rollbackClaimForFailure(
  deps: DowntimeDispatchDeps,
  itemId: string,
  original: DowntimeClaimExpected,
  cwd: string,
): Promise<boolean> {
  try {
    return await deps.rollbackClaim(itemId, original, cwd);
  } catch {
    return false;
  }
}

/**
 * Dispatch one already-selected candidate through the fixed pipeline:
 * project-workspace anchor resolution → CAS claim → marker write (before
 * spawn) → spawn.
 *
 *  - Project workspace + item-ID tab (WL-0MU321YK70035AYT): BEFORE the claim,
 *    resolve the candidate's project workspace from `opts.cwd` via
 *    `deps.resolveProjectWorkspace`, ensure/reuse the tab labelled with the
 *    exact work-item id via `deps.getItemTabAnchor`, and forward that tab's
 *    root pane as `anchorId` so the pane lands in the project workspace under
 *    the item's tab. This is the PRIMARY placement path. When no project
 *    workspace resolves, placement falls back to the per-prefix tab in the
 *    `Dispatcher` workspace (C1, WL-0MTRQT482001SNXC), then to the retained
 *    machine-wide `deps.getDispatcherAnchor` (AC4). A null/failed
 *    project-workspace resolution does not abort when a fallback is wired;
 *    a failed item-tab provision aborts with reason 'anchor-unavailable' —
 *    never the leader's pane and never another project's workspace.
 *  - Claim (compare-and-swap): exactly one concurrent pane wins; a loser
 *    (or a wl claim failure) ABORTS the dispatch — no pane, no marker, no
 *    success record. A lost race resolves reason 'claim-failed' (neutral,
 *    the winner's pane will busy the proxy); a wl claim failure resolves
 *    'wl-error' (counts toward the three-strike rule). Neither is ever
 *    silently discarded (WL-0MSLWJ310000ND0X absorbed).
 *  - Marker write BEFORE the pane spawns: if the marker cannot be written
 *    the dispatch aborts BEFORE spawning (fail-closed — an unmarked item is
 *    never dispatched). The claim is then rolled back to its pre-claim
 *    status+stage (WL-0MT32F908002YFFA AC1) so the item is re-selectable on
 *    the next idle period instead of being stranded in `in_progress` with no
 *    marker and no pane.
 *  - Spawn: a handled spawn `error` or non-zero script exit resolves reason
 *    'spawn-failed' — the outcome is NOT success, and a failure trace
 *    (`outcome: 'spawn-failed'` entry with the error/exit details) is
 *    appended to the rolling audit log so the log never claims success for
 *    a pane that never appeared (WL-0MSLWJ3I70031Z8U absorbed). Spawn-failed
 *    entries are excluded from the dispatched-marker readers (AC2,
 *    WL-0MT32F908002YFFA) AND the claim is rolled back, so the item is
 *    re-eligible for selection on the next idle period (AC2/AC4) rather
 *    than permanently removed from the queue.
 */
export async function dispatchClaimedTier(
  deps: DowntimeDispatchDeps,
  kind: DowntimeSkillKind,
  candidate: DowntimeCandidate,
  opts: {
    model: string;
    cwd: string;
    selectionPath?: string;
    selectionReason?: string;
    /** Per-turn locality preference forwarded to the pane (C4-AC1). */
    localPreference?: LocalPreference;
    /**
     * Locality-preference precedence opt-in (WL-0MVNUIW77000VYAX AC4). Set by
     * the plugin's `config()` only: `operator-setting` keeps a persisted
     * setting verbatim, `priority-rule` lets a `low`-priority candidate
     * resolve to `local-only`. Absent → legacy caller: forward
     * `localPreference` verbatim and add no marker fields.
     */
    localPreferenceMode?: LocalPreferenceMode;
  },
): Promise<DowntimeDispatchOutcome> {
  const expected = TIER_EXPECTED[kind];
  // Locality preference (WL-0MVNUIW77000VYAX AC4): resolved ONCE at this
  // dispatch boundary — coordination offers, own-backlog fallback, audit-batch
  // continuation, critical-first/normal scans and the legacy tier chain all
  // funnel through here with the candidate in hand, so the priority rule can
  // never diverge between paths. `undefined` = legacy caller (forward
  // `opts.localPreference` verbatim, no marker fields).
  const resolvedLocalPreference = resolveDispatchLocalPreferenceDecision(
    candidate.priority,
    opts.localPreference,
    opts.localPreferenceMode,
  );
  const localPreference = resolvedLocalPreference?.preference ?? opts.localPreference;
  // Placement precedence (AC1, WL-0MUR5FUWD00024XN): resolve the anchor
  // BEFORE the claim so a provisioning failure degrades to "no dispatch this
  // cycle" (F1 AC6 — caller fail-safe) without claiming/marking an item that
  // can never spawn a pane. The precedence is:
  //   (a) project workspace + item-ID tab (primary);
  //   (b) per-prefix Dispatcher tab (fallback when no project workspace
  //       resolves);
  //   (c) legacy single Dispatcher anchor.
  // Absent deps (legacy/test callers) → no anchor, legacy current-pane
  // behavior.
  let anchorId: string | undefined;
  // True when `anchorId` is a tab root pane (a project item tab or a
  // per-prefix Dispatcher tab). Tab roots are provisioned with herdr's
  // initial root pane (an empty bash pane) which is only needed as the split
  // anchor for the FIRST dispatch — after the dispatch pane spawns it is
  // closed so the tab shows only the productive pane. The legacy Dispatcher
  // fallback anchor is deliberately exempt: its root pane is the persisted
  // dispatch anchor and closing it would trigger a blank re-provision loop.
  let anchorIsTabRoot = false;
  // Extract the work-item id prefix (e.g. `WL-0MTO…` → `WL`, `TCE-…` → `TCE`).
  const prefix = candidate.id.split('-', 1)[0];

  // ── Primary path: project workspace + item-ID tab (WL-0MU321YK70035AYT) ─
  // Resolve the candidate's project workspace from its worklog root, ensure/
  // reuse a tab labelled with the exact work-item id, and anchor the pane to
  // that tab's root pane. This is the PRIMARY placement path: when a project
  // plugin pane resolves for the root, the Dispatcher workspace is NOT used
  // (AC2/AC3). A null resolution falls through to the per-prefix fallback.
  if (typeof deps.resolveProjectWorkspace === 'function') {
    let projectTarget: ProjectWorkspaceTarget | null = null;
    try {
      projectTarget = await deps.resolveProjectWorkspace(opts.cwd);
    } catch {
      projectTarget = null; // fail-closed on any resolver error
    }
    if (projectTarget !== null && typeof deps.getItemTabAnchor === 'function') {
      let tabAnchor: ItemTabAnchor | null = null;
      try {
        tabAnchor = await deps.getItemTabAnchor(opts.cwd, projectTarget.workspaceId, candidate.id);
      } catch {
        tabAnchor = null; // fail-closed
      }
      if (tabAnchor === null) {
        // The workspace resolved but its item tab could not be provisioned:
        // fail closed rather than place a project pane in the Dispatcher
        // workspace (never a wrong placement).
        return { dispatched: false, reason: 'anchor-unavailable' };
      }
      anchorId = tabAnchor.paneId;
      anchorIsTabRoot = true;
    }
  }

  // ── Fallback: per-prefix tab in Dispatcher workspace (AC3) ────────────
  // Reached only when no project workspace resolved for the item's root.
  // When wired, the per-prefix resolver REPLACES the legacy single anchor —
  // a null/failed resolution is 'anchor-unavailable' (no dispatch this
  // cycle) and NEVER falls back to the legacy Dispatcher anchor or the
  // leader's pane (constraint: fail-safe, never a wrong-tab placement).
  if (anchorId === undefined && typeof deps.getDispatcherTabAnchor === 'function') {
    if (!prefix) {
      // No prefix extractable (empty/invalid id) → cannot route by prefix.
      return { dispatched: false, reason: 'anchor-unavailable' };
    }
    let prefixAnchor: DispatcherPrefixTabAnchor | null = null;
    try {
      prefixAnchor = await deps.getDispatcherTabAnchor(opts.cwd, prefix);
    } catch {
      prefixAnchor = null; // fail-closed
    }
    if (prefixAnchor === null) {
      return { dispatched: false, reason: 'anchor-unavailable' };
    }
    anchorId = prefixAnchor.paneId;
    // Per-prefix Dispatcher tabs use herdr's initial root pane as anchor.
    anchorIsTabRoot = true;
  }

  // ── Fallback: legacy Dispatcher single anchor (AC4) ───────────────────
  // When this dep IS wired, a null/failed resolution fails closed
  // ('anchor-unavailable') — never a current-pane placement. When it is NOT
  // wired (pre-C0 / legacy/test callers), no anchor is set and the spawn
  // uses the legacy current-pane behaviour.
  if (anchorId === undefined && typeof deps.getDispatcherAnchor === 'function') {
    let anchor: DispatcherAnchor | null = null;
    try {
      anchor = await deps.getDispatcherAnchor(opts.cwd);
    } catch {
      anchor = null; // fail-closed on any anchor error
    }
    if (anchor === null) {
      return { dispatched: false, reason: 'anchor-unavailable' };
    }
    anchorId = anchor.paneId;
    // The legacy Dispatcher anchor is NOT a tab root — it is the persisted
    // dispatch pane and must never be closed.
    anchorIsTabRoot = false;
  }

  // Cross-root claim (WL-0MTQ14W7L003II5A): opts.cwd is the item's worklog
  // root — the coordination leader passes the OFFER's root so the CAS claim
  // lands in the item's own database (never the leader's module override).
  //
  // Retired-stage recovery (WL-0MTYL7DX9000MZOH): when the candidate is
  // stuck on the removed `in_progress` stage, the tier's normalised stage
  // CAS can never match. Claim it using the item's ACTUAL stage as the CAS
  // guard (race-safe) while atomically migrating the stored stage to the
  // tier's target — without this the `wl update` status/stage validator
  // rejects the claim and the dispatcher records a hard wl-error strike.
  const retiredStage = (candidate.stage as string) === 'in_progress';
  // Blocked-status claim (operator change: 'blocked' is an allowable dispatch
  // status). The tier's nominal CAS expects `open`, but a blocked item is
  // selected while `blocked` — the guard must match its ACTUAL status or the
  // claim aborts as stale (`claim-failed`) and the item is never dispatched.
  const claimStatus = candidate.status === 'blocked' ? 'blocked' : expected.status;
  const claimExpected: DowntimeClaimExpected = retiredStage
    ? { status: claimStatus, stage: candidate.stage }
    : { ...expected, status: claimStatus };
  // Keep the normal-path arity unchanged (3 args) so existing callers /
  // assertions see the historical shape; only the retired-stage recovery
  // passes the migration stage.
  const claim = retiredStage
    ? await deps.claimItem(candidate.id, claimExpected, opts.cwd, expected.stage)
    : await deps.claimItem(candidate.id, claimExpected, opts.cwd);
  if (!claim.ok) {
    return claim.reason === 'stale'
      ? { dispatched: false, reason: 'claim-failed' }
      : { dispatched: false, reason: 'wl-error', error: claim.error ?? 'claim failed' };
  }

  // ── Local capacity reservation gate (parent WL-0MVIKRFP0005JDL8, slice C2) ──
  //
  // The dispatcher never launches without a ticket: it ASKS the proxy for an
  // admission ticket after winning the CAS claim and BEFORE the success
  // marker/spawn — never poll-then-hope. The call rides the existing
  // single-flight poll cadence (this function is reached at most once per
  // tick with a won claim, so there is no second request and no new timer).
  //
  //   - granted → the ticket id is forwarded to the pane, so the session's
  //     first request carries `X-Local-Reservation` (AC1);
  //   - refused (`429`) → DEFER with the proxy's `retry_after_s`, roll the
  //     claim back (the item must become selectable again) and never write a
  //     marker or run the spawn path (AC2);
  //   - `null` / throwing client → fail OPEN: proceed exactly as today, with
  //     no ticket (an older proxy is fully supported, AC3).
  //
  // A granted ticket is single-use: when it cannot be forwarded (a later
  // marker/spawn failure) it is recorded as released/expired and the next
  // idle period asks for a fresh one — it is never reused or leaked.
  let reservation: DowntimeReservationEvidence | undefined;
  let reservationTicketId: string | undefined;
  if (typeof deps.reserveLocalCapacity === 'function') {
    let reserveResult: LocalReservationResult | null = null;
    try {
      reserveResult = await deps.reserveLocalCapacity(buildLocalReservationRequest(candidate));
    } catch {
      reserveResult = null; // fail-open: a throwing client never blocks dispatch
    }
    if (reserveResult?.status === 'refused') {
      // The proxy's OPEN-vocabulary reason becomes the decision reason (its
      // own distinct header token via decisionHeaderToken) and the deferral
      // advice is carried in the evidence fields (AC2/AC4).
      const rollbackOk = await rollbackClaimForFailure(deps, candidate.id, expected, opts.cwd);
      return {
        dispatched: false,
        reason: reserveResult.refusal.reason,
        // A failed rollback leaves the item claimed (no worse than the
        // pre-fix state) — it is still not a spawn.
        ...(rollbackOk ? {} : { error: 'claim rollback failed after reserve refusal' }),
        reservation: {
          admit: false,
          retryAfterS: reserveResult.refusal.retryAfterSeconds,
          projectedWaitS: reserveResult.refusal.retryAfterSeconds,
        },
      };
    }
    if (reserveResult?.status === 'granted') {
      reservationTicketId = reserveResult.ticket.ticketId;
      reservation = {
        admit: true,
        reservationTicket: {
          id: reserveResult.ticket.ticketId,
          grantedAt: new Date().toISOString(),
        },
        projectedWaitS: 0,
      };
    }
  }

  let marked = false;
  // Capture ONE timestamp shared by the success marker and its post-spawn
  // enrichment entry (WL-0MUBVL251006JAQ0 / F6 AC6.2) so the marker readers
  // (last-entry-wins) see an unchanged `dispatchedAt`.
  const dispatchedAt = new Date().toISOString();
  try {
    marked = await deps.recordDispatch({
      itemId: candidate.id,
      kind,
      dispatchedAt,
      cwd: opts.cwd,
      title: candidate.title,
      // The worklog stage at dispatch powers the plan/intake change-guard
      // (exclude while the item is still at this stage; release on advancement).
      stage: expected.stage,
      // Selection provenance (WL-0MUBVL251006JAQ0 / F6 AC6.1): which loop
      // selected this candidate and why — makes the log self-explanatory.
      ...(opts.selectionPath !== undefined ? { selectionPath: opts.selectionPath } : {}),
      ...(opts.selectionReason !== undefined ? { selectionReason: opts.selectionReason } : {}),
      // Locality-preference evidence (WL-0MVNUIW77000VYAX AC5): the resolved
      // preference and its machine-readable reason, so an operator can confirm
      // whether the priority rule, the deployment default or an explicit
      // operator setting decided the route. Absent for legacy callers.
      ...(resolvedLocalPreference !== undefined
        ? {
            localPreference: resolvedLocalPreference.preference,
            localPreferenceReason: resolvedLocalPreference.reason,
          }
        : {}),
      // Reservation provenance (parent WL-0MVIKRFP0005JDL8 AC4, slice C2):
      // the marker records the granted ticket so the dispatch can be
      // correlated with the pane's route log. Absent on a fail-open dispatch.
      ...(reservationTicketId !== undefined
        ? {
            reservationTicketId,
            ...(reservation?.reservationTicket !== undefined
              ? { reservationGrantedAt: reservation.reservationTicket.grantedAt }
              : {}),
          }
        : {}),
    });
  } catch {
    // Fail-closed: a throwing recordDispatch (stub or regression) is a marker
    // write failure — abort before spawn.
    marked = false;
  }
  if (!marked) {
    // Marker-write recovery (WL-0MT32F908002YFFA AC1): the CAS claim
    // succeeded but the marker write failed — the item is stranded in
    // `in_progress` with no marker, invisible to all future tiers.
    // Roll back the claim so the next idle period can re-select it.
    //
    // A granted reservation ticket can no longer reach a pane here: record
    // it as released/expired (single-use, never leaked) on the outcome.
    const releasedReservation: DowntimeReservationEvidence | undefined =
      reservation === undefined ? undefined : { ...reservation, reservationReleased: true };
    const rollbackOk = await rollbackClaimForFailure(deps, candidate.id, expected, opts.cwd);
    if (!rollbackOk) {
      // The item was already moved by a concurrent agent/human — nothing
      // to roll back; report marker-write-failed so the caller can fall
      // through to the next candidate.
      return {
        dispatched: false,
        reason: 'marker-write-failed',
        ...(releasedReservation !== undefined ? { reservation: releasedReservation } : {}),
      };
    }
    return {
      dispatched: false,
      reason: 'claim-rolled-back',
      ...(releasedReservation !== undefined ? { reservation: releasedReservation } : {}),
    };
  }

  const spawn = await deps.spawnAgentPane(
    buildDowntimePrompt(kind, candidate),
    {
      model: opts.model,
      cwd: opts.cwd,
      // Descriptive pane title (WL-0MSJ4E8UA005KG9Y): thread the candidate's
      // title/id so buildDowntimePaneArgs can name the pane
      // `Downtime triggered <kind> <title> - <id>`.
      itemTitle: candidate.title,
      itemId: candidate.id,
      // Request priority (parent AC3): the candidate's raw work-item
      // priority, mapped through the downtime table by the spawn boundary.
      priority: candidate.priority,
      // Dispatcher anchor (C0): split from the dedicated Dispatcher anchor
      // pane so this pane lands in the Dispatcher workspace regardless of
      // leadership. Only set when the anchor resolved (never a bare
      // undefined key — legacy callers keep their exact opts shape).
      ...(anchorId !== undefined ? { anchorId } : {}),
      // Granted reservation ticket (slice C2 AC1): forwarded to the pane so
      // its first request carries `X-Local-Reservation`. Absent on a
      // fail-open (older proxy) dispatch.
      ...(reservationTicketId !== undefined ? { reservationTicketId } : {}),
      // Per-turn locality preference (slice C4 AC1): forwarded to the pane so
      // the extension sends `X-Local-Preference` and writes the route log.
      // WL-0MVNUIW77000VYAX: the value resolved above (priority rule /
      // explicit setting) is what reaches the wire. Absent → today's
      // byte-identical launch (fail-open C4-AC3).
      ...(localPreference !== undefined ? { localPreference } : {}),
    },
  );
  if (!spawn.ok) {
    // The granted ticket could not be forwarded to a pane: it is single-use,
    // so it is DROPPED here (the next idle period asks for a fresh one) and
    // recorded as released/expired — never leaked or reused.
    const released: DowntimeReservationEvidence | undefined =
      reservation === undefined ? undefined : { ...reservation, reservationReleased: true };
    // Spawn-failure freshness re-check (WL-0MT8KSTOE00871E7): between
    // selection and spawn, a valid audit may have been recorded. If so, the
    // pane is moot — do NOT record a failure trace or comment. The failure
    // was against a stale/unaudited state that no longer exists.
    if (kind === 'audit') {
      try {
        const fresh = await deps.hasFreshAudit(candidate.id, opts.cwd);
        if (fresh) {
          process.stderr.write(
            `[worklog-plugin] Downtime spawn-failed skip: fresh audit recorded during interim (item ${candidate.id})\n`,
          );
          // Skip the failure trace — the pane was dispatched against a stale
          // candidate; do NOT log as a failure.
          return {
            dispatched: false,
            reason: 'spawn-failed',
            error: spawn.error,
            exitCode: spawn.exitCode,
            ...(released !== undefined ? { reservation: released } : {}),
          };
        }
      } catch {
        // Fail-open on the freshness check: if we can't verify, log the
        // failure trace as normal (conservative default).
      }
    }
    // Failure trace (WL-0MSLWJ3I70031Z8U AC2): the audit log distinguishes
    // "attempted" (failed spawn) from "opened" (success marker) — append
    // an outcome:'spawn-failed' entry with the error/exit trace. Fail-
    // closed: audit logging must never crash the worker, so a throwing
    // trace is swallowed (the stderr line in spawnDowntimePane is the
    // transient trail; the marker already stands).
    try {
      await deps.recordDispatchFailure({
        itemId: candidate.id,
        kind,
        dispatchedAt: new Date().toISOString(),
        cwd: opts.cwd,
        title: candidate.title,
        stage: expected.stage,
        error: spawn.error,
        exitCode: spawn.exitCode,
      });
    } catch {
      // fail-closed: audit logging must never crash the worker
    }
    // Spawn-failure recovery (WL-0MT32F908002YFFA AC2/AC4): the pane never
    // appeared, so the claim left the item in `in_progress` with no agent.
    // Roll the claim back to its pre-claim status+stage (audit → completed/
    // in_review, every other tier → open at the same stage). Combined with
    // the non-excluding spawn-failed marker, the item is re-selectable on the
    // next idle period (immediate re-dispatch, the documented decision); the
    // failure trace stays in the rolling log and the outcome is not success.
    // Fail-closed: a rollback failure leaves the item claimed (no worse than
    // the pre-fix state).
    await rollbackClaimForFailure(deps, candidate.id, expected, opts.cwd);
    return {
      dispatched: false,
      reason: 'spawn-failed',
      error: spawn.error,
      exitCode: spawn.exitCode,
      ...(released !== undefined ? { reservation: released } : {}),
    };
  }

  // Root-pane cleanup (WL-0MU2EOHK900425VU): a project-workspace item tab is
  // provisioned with herdr's initial root pane (an empty bash pane) that is
  // only used as the split anchor for the FIRST dispatch. Once the dispatch
  // pane has spawned, close that root pane so the tab shows only the
  // productive pane. Only ever close a ROOT pane: an anchor pane already
  // carrying a downtime dispatch label is a live agent session and must stay
  // open. Best-effort — cleanup must never block or fail the dispatch
  // outcome.
  if (
    anchorIsTabRoot &&
    anchorId !== undefined &&
    typeof deps.closePane === 'function'
  ) {
    try {
      // Fail-safe: close the anchor unless liveness POSITIVELY confirms it is
      // a live downtime dispatch pane. The check must use the running DOWNTIME
      // pane ids (`paneIds`), NEVER the full machine-wide pane set (`records`
      // contains the anchor itself, so checking it would suppress every
      // close — the WL-0MU2EOHK900425VU audit regression). A `records`-only
      // payload is filtered to downtime panes via `countRunningDowntimePanes`.
      // When liveness cannot be confirmed (query failed/absent) the anchor is
      // left open (fail-safe), so a live agent pane is never closed.
      let confirmedRootPane = false;
      if (typeof deps.getRunningDowntimePanes === 'function') {
        const running = await deps.getRunningDowntimePanes(opts.cwd);
        if (running.ok) {
          const liveIds = Array.isArray(running.paneIds)
            ? running.paneIds
            : running.records !== undefined
              ? countRunningDowntimePanes(running.records)
              : null;
          if (liveIds !== null) confirmedRootPane = !liveIds.includes(anchorId);
        }
      }
      if (confirmedRootPane) {
        await deps.closePane(anchorId, opts.cwd);
      }
    } catch {
      // fail-open: root-pane cleanup must never block the dispatch outcome
    }
  }

  // Post-spawn enrichment (WL-0MUBVL251006JAQ0 / F6 AC6.2/AC6.3): best-effort
  // resolve the spawned pane's id and append a second log entry that copies
  // the marker fields (`itemId`/`kind`/`stage`/`dispatchedAt`) so the marker
  // readers see the SAME marker state. Fail-open: ANY failure (missing dep,
  // thrown resolver, unresolved pane) never blocks or un-marks the dispatch —
  // an unresolved pane is recorded as `paneId: null` rather than omitted or
  // guessed.
  await recordDispatchEnrichmentBestEffort(deps, {
    itemId: candidate.id,
    kind,
    dispatchedAt,
    cwd: opts.cwd,
    title: candidate.title,
    stage: expected.stage,
    ...(opts.selectionPath !== undefined ? { selectionPath: opts.selectionPath } : {}),
    ...(opts.selectionReason !== undefined ? { selectionReason: opts.selectionReason } : {}),
    // Copy the locality evidence onto the enrichment entry too
    // (WL-0MVNUIW77000VYAX AC5) so the last-entry-wins readers never lose it.
    ...(resolvedLocalPreference !== undefined
      ? {
          localPreference: resolvedLocalPreference.preference,
          localPreferenceReason: resolvedLocalPreference.reason,
        }
      : {}),
  });

  return { dispatched: true, candidate, kind };
}

/**
 * Best-effort pane-id resolution + enrichment append (WL-0MUBVL251006JAQ0 /
 * F6). Never throws and never affects the dispatch outcome. Resolves the pane
 * by matching a live downtime pane's label suffix to the item id; a missing
 * dep or any failure records `paneId: null`.
 */
export async function recordDispatchEnrichmentBestEffort(
  deps: DowntimeDispatchDeps,
  base: {
    itemId: string;
    kind: DowntimeSkillKind;
    dispatchedAt: string;
    cwd: string;
    title?: string;
    stage?: string;
    selectionPath?: string;
    selectionReason?: string;
    /** Resolved locality preference + reason copied from the success marker. */
    localPreference?: LocalPreference;
    localPreferenceReason?: LocalPreferenceReason;
  },
): Promise<void> {
  if (typeof deps.recordDispatchEnrichment !== 'function') return; // legacy callers
  let paneId: string | null = null;
  try {
    if (typeof deps.getRunningDowntimePanes === 'function') {
      const panes = await deps.getRunningDowntimePanes(base.cwd);
      if (panes.ok && Array.isArray(panes.records)) {
        const match = panes.records.find(
          (rec) => rec.label?.startsWith(DOWNTIME_PANE_LABEL_PREFIX) && paneLabelItemId(rec.label) === base.itemId,
        );
        paneId = match?.paneId ?? null;
      }
    }
  } catch {
    paneId = null; // fail-open — never block the dispatch on a pane lookup
  }
  try {
    await deps.recordDispatchEnrichment({
      ...base,
      paneId,
      enrichment: true,
      // Never comment twice for one dispatch (the success marker already did).
      noItemComment: true,
    });
  } catch {
    // fail-open: enrichment logging must never crash the worker
  }
}

/**
 * Dispatch one due scheduled prompt (WL-0MSS1Q5ER007QDKX). Unlike the
 * worklog tiers there is NO work item: no pre-dispatch claim, no wl item
 * comment. Fixed pipeline, fail-closed at every boundary:
 *
 *  1. PERSIST first: `lastTriggeredAt` is written to the config (atomic
 *     tmp+rename) BEFORE anything else. A persist failure ABORTS the
 *     dispatch — an unrecorded dispatch never runs (AC4) — and the entry
 *     stays due for the next idle slot.
 *  2. Rolling-log MARKER (kind `scheduled`) before the pane spawns: a
 *     marker failure ALSO aborts before the spawn (fail-closed).
 *  3. SPAWN the pane through the existing send-to-pi.sh path running the
 *     prompt text, named `Downtime <entryId>` (--no-focus, --cwd, --model).
 *     A handled spawn failure appends an outcome:'spawn-failed' trace and
 *     resolves 'spawn-failed' (the outcome is NOT success); the marker and
 *     the persisted lastTriggeredAt stand (the entry is not re-selected
 *     until its frequency elapses — a best-effort cadence tolerates the
 *     failed run).
 */
export async function dispatchScheduledPrompt(
  deps: DowntimeDispatchDeps,
  prompt: ScheduledPrompt,
  opts: {
    model: string;
    cwd: string;
    localPreference?: LocalPreference;
    /**
     * Locality-preference precedence opt-in (WL-0MVNUIW77000VYAX AC4/AC5).
     * A scheduled prompt has no work item and therefore no priority, so the
     * resolution yields the deployment default (`default`) or the explicit
     * operator setting (`operator-setting`).
     */
    localPreferenceMode?: LocalPreferenceMode;
  },
): Promise<DowntimeDispatchOutcome> {
  const at = new Date().toISOString();
  // Scheduled prompts carry no priority: the rule can only leave the
  // deployment default in place (or honour an explicit operator setting).
  const resolvedLocalPreference = resolveDispatchLocalPreferenceDecision(
    undefined,
    opts.localPreference,
    opts.localPreferenceMode,
    BACKGROUND_LOCAL_PREFERENCE,
  );

  // Dispatcher anchor (C0 WL-0MTR01EU7005SYZG): scheduled-prompt panes are
  // downtime-worker spawns too — resolve the dedicated Dispatcher anchor
  // BEFORE the trigger persist so a provisioning failure degrades to "no
  // dispatch this cycle" without consuming the scheduled entry (it stays
  // due for the next idle slot). Absent dep (legacy/test callers) → no
  // anchor, legacy current-pane behavior.
  let anchorId: string | undefined;
  if (typeof deps.getDispatcherAnchor === 'function') {
    let anchor: DispatcherAnchor | null = null;
    try {
      anchor = await deps.getDispatcherAnchor(opts.cwd);
    } catch {
      anchor = null; // fail-closed on any anchor error
    }
    if (anchor === null) {
      return { dispatched: false, reason: 'anchor-unavailable' };
    }
    anchorId = anchor.paneId;
  }

  // 1. Persist lastTriggeredAt (atomic tmp+rename). A failure aborts BEFORE
  // the log marker or the spawn — an unrecorded dispatch never runs and the
  // entry remains due (AC4 fail-closed).
  const persisted = await deps.recordScheduledPromptTrigger(opts.cwd, prompt.id, at);
  if (!persisted) {
    return { dispatched: false, reason: 'marker-write-failed' };
  }

  // 2. Rolling-log marker (kind `scheduled`, noItemComment — there is no
  // work item to comment). A marker failure aborts BEFORE the spawn.
  let marked = false;
  try {
    marked = await deps.recordDispatch({
      itemId: prompt.id,
      kind: 'scheduled',
      dispatchedAt: at,
      cwd: opts.cwd,
      title: `Scheduled prompt: ${prompt.prompt}`,
      noItemComment: true,
      selectionPath: 'scheduled-prompt',
      selectionReason: 'scheduled-due',
      // Locality evidence (WL-0MVNUIW77000VYAX AC5): scheduled prompts have no
      // priority, so the reason is `default` (deployment default) or
      // `operator-setting`. Absent for legacy callers.
      ...(resolvedLocalPreference !== undefined
        ? {
            localPreference: resolvedLocalPreference.preference,
            localPreferenceReason: resolvedLocalPreference.reason,
          }
        : {}),
    });
  } catch {
    // Fail-closed: a throwing recordDispatch (stub or regression) is a
    // marker write failure — abort before spawn.
    marked = false;
  }
  if (!marked) {
    return { dispatched: false, reason: 'marker-write-failed' };
  }

  // 3. Spawn the pane running the prompt text, named `Downtime <entryId>`.
  const spawn = await deps.spawnAgentPane(prompt.prompt, {
    model: opts.model,
    cwd: opts.cwd,
    paneName: `Downtime ${prompt.id}`,
    ...(anchorId !== undefined ? { anchorId } : {}),
    // Scheduled/background work defaults to `remote-ok` (C4-AC1): it must
    // never queue local capacity the operator may need for interactive work.
    // WL-0MVNUIW77000VYAX: an explicit operator setting still wins; otherwise
    // the resolved deployment default is forwarded.
    localPreference:
      resolvedLocalPreference?.preference ??
      opts.localPreference ??
      BACKGROUND_LOCAL_PREFERENCE,
  });
  if (!spawn.ok) {
    // Failure trace (WL-0MSLWJ3I70031Z8U AC2 pattern): the audit log
    // distinguishes "attempted" (failed spawn) from "opened" (success
    // marker). Fail-closed: audit logging must never crash the worker, so a
    // throwing trace is swallowed (the marker + persisted trigger already
    // stand).
    try {
      await deps.recordDispatchFailure({
        itemId: prompt.id,
        kind: 'scheduled',
        dispatchedAt: new Date().toISOString(),
        cwd: opts.cwd,
        title: `Scheduled prompt: ${prompt.prompt}`,
        noItemComment: true,
        error: spawn.error,
        exitCode: spawn.exitCode,
      });
    } catch {
      // fail-closed: audit logging must never crash the worker
    }
    return {
      dispatched: false,
      reason: 'spawn-failed',
      error: spawn.error,
      exitCode: spawn.exitCode,
    };
  }

  return { dispatched: true, kind: 'scheduled' };
}
