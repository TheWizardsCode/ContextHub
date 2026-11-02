# Herdr hydrator — self-healing `in_progress` claims

Work item: WL-0MSOJLZD9004P8PI
Folded-in scope: WL-0MTTSWE0G008M1VA (no-activity / claim-age timeout, 2026-09-13)
Active-detection rework: WL-0MV1BWETT005GSUJ (pane-title detection, 2026-10-16)
Second busy signal (live claim holder) + release trail: WL-0MVWDAZL10025P8J,
WL-0MVWDB3IG004NRIU, WL-0MVWDB7F2003SORI, WL-0MVWDBB4X007D2GS (2026-10-31)

## Problem

Work items claimed as `in_progress` are correctly excluded from downtime
dispatch (single-flight — an active claim owns them). But there is no
automatic mechanism to detect claims that are **stuck**: status `in-progress`
with no matching agent pane (pane closed, session died, claim abandoned).
Such items linger at the top of the queue and are never re-selected — they
block themselves and top the Herdr selection list as non-dispatchable wall
items (RCA `WL-0MTTS9FY00055QJV`, root cause E; evidence
`AH-0MTP19DG100472CV`).

## Design

The hydrator is a scheduler task inside the worklist pane process, exactly
like the downtime worker:

1. **Every 30 s** — `wl list --status in-progress --json` (all in-progress
   items for the pane's worklog root).
2. **Fetch live panes** — `herdr pane list --workspace <id>`; keep panes in
   the **current workspace** (`HERDR_WORKSPACE_ID`; panes without a workspace
   id are always included — fail-open toward "active").
3. **Match (primary signal)** — a pane whose **title contains** the item's
   work-item ID (e.g. `Downtime triggered implement Foo - WL-…`) counts as
   active. Every pane spawned for an item is titled by the shared
   `pane-title.ts` builders (manual, shell, downtime), and
   `truncatePaneTitlePreservingSuffix` keeps the ID as a trailing suffix
   under truncation, so the ID reliably appears in the title.
3b. **Match (second signal, WL-0MVWDAZL10025P8J / WL-0MVWDB3IG004NRIU)** — a
   **live claim holder** counts as active too: the per-child lock
   `<worklog>/locks/child-<id>.lock` is currently `flock`ed (or its recorded
   `pid` is alive and not a recycled pid). This is what keeps a **pane-less
   driven session** (`implement.py drive` → `pi -p` is headless by design)
   busy. Only items WITHOUT a pane match are probed, in ONE batched local
   probe per cycle (`claim-lock.ts`, zero `wl`/`herdr` spawns), so the pane
   rule stays primary and is never narrowed; see
   [Claim-holder probe](#claim-holder-probe-how-heldness-is-measured-wl-0mvwdazl10025p8j).
4. **Demote (release)** any item with no matching pane **and** no live claim
   holder, in this precedence order — `held` is evaluated **after** the
   `in_review` and `blocked` branches, so a live claim only suppresses the
   `open` release:
   - stage `in_review` → `status=completed`, stage `in_review`
   - an active outbound dependency blocker → `status=blocked` (stage
     repaired to a compatible value, e.g. `plan_complete` when the claim
     sat at `in_progress`)
   - otherwise → `status=open` at the claimed stage (the folded-in
     no-activity/claim-age timeout release: a no-pane claim is released
     regardless of activity age, reusing the existing 2 h dispatch stale
     window `DOWNTIME_AUDIT_STALE_WINDOW_MS` as the activity bound)

   Every release clears the scheduling hold and leaves a trail — see
   [Release trail](#release-trail-wl-0mvwdb7f2003sori).
5. **Focus-resume** — the hidden→visible transition runs the check
   immediately (same runner, no interval wait).

### Why pane titles, not tabs

An earlier revision matched the exact **label** of a workspace **tab**
(`herdr tab list`). That proved unreliable in practice
(WL-0MV1BWETT005GSUJ): tabs are created by the dispatcher *anchor* as a
placement side effect, so an item being dispatched can be evaluated before
its tab exists (a false-demotion race), and tabs can be re-parented or
renamed by the operator. Pane **titles** are set at spawn time, always carry
the item ID as a preserved suffix, and survive re-parenting — matching them
is the simple, reliable rule the producer directed:

> "It should be simple. Look for a pane in this workspace with the work item
> id as the title. If it exists then work item is busy."

That pane rule remains the **primary** signal. The live claim holder
(second busy signal, below) is a **second, mechanically verifiable** signal
added for pane-less driven sessions — an addition, never a replacement, so no
existing behaviour is narrowed.

### Safety (fail-open, never crash, never false-demote)

- An unavailable / unparseable `wl list` or `herdr pane list` **aborts the
  cycle without demoting** (no demotion on ambiguous evidence).
- An item with a matching pane is never touched (the dep query is skipped
  entirely for it).
- A dependency lookup failure treats the item as not-blocked and still
  releases it to `open`.
- **The claim-holder probe fails open, deliberately.** An unreadable /
  unenumerable `locks/` directory, a corrupt or empty lock file, an
  unexpected `fs`/`flock` error, an undecidable probe, a probe step timeout,
  or a missing per-item verdict each **suppress demotion** with a named
  reason (`locks-dir-unreadable`, `corrupt-lock-file`, `probe-error`,
  `claim-probe step timeout`, …) instead of releasing the claim. The
  asymmetry is intentional: ambiguity ⇒ no demotion, affirmative death ⇒
  release.
- **Pid-reuse guard.** The recorded-`pid` fallback is trusted only when the
  lock's `started_at` is not earlier than the recorded process start time;
  a recycled pid can therefore never be read as a live claim — the probe
  reports `held` (`pid-reuse-suspected`) and logs the reason.
- A failed `wl update` is logged and left unchanged (counted as skipped).
- Visibility-gated: a hidden worklog tab spawns zero `wl`/`herdr`
  processes.
- Single-flight + scheduler watchdog (`HYDRATOR_RUN_TIMEOUT_MS`): a hung
  run is abandoned and retried on the next tick, never wedging the task.

## Claim-holder probe: how heldness is measured (WL-0MVWDAZL10025P8J)

The second busy signal (a live per-child claim holder) is measured by the
local, side-effect-free probe in `packages/herdr/src/claim-lock.ts`. The
mechanism was spiked and measured on the dev host on 2026-10-31:

| Candidate | Result | Measured cost (50 candidates) |
|---|---|---|
| `flock(1)` spawn, fd-redirect form `sh -c 'flock -n -E 75 9 9<"$1"' sh <path>` | rc 0 = free, rc 75 = held, rc 2 = cannot open | ~7.6 ms/candidate (~0.4 s per batch, one spawn each) |
| One `/proc/locks` snapshot per batch + one `stat` per candidate (`dev:inode`) | Linux-only; zero spawns | ~0.2 ms/candidate (~10 ms per batch) |

**Chosen: hybrid** — on Linux the probe takes one `/proc/locks` snapshot per
batch and maps each candidate with a single `stat`; when `/proc/locks` is
unavailable (non-Linux, or a mount namespace that hides it) it falls back to
the portable fd-redirect `flock` spawn. Neither path creates, truncates or
rewrites a lock file, and neither blocks: plain `flock -n <path>` is never
used because util-linux 2.41.3 has no `--no-create` and would create a missing
lock file. Both paths stay far inside the 5 s per-step budget
(`HYDRATOR_STEP_TIMEOUT_MS`).

Heldness is decided per candidate by, in order: a held `flock` ⇒ `flock-held`
(held); a free `flock` with a live recorded `pid` ⇒ `pid-alive` (held, guarded
by the `started_at` vs process-start pid-reuse check ⇒ `pid-reuse-suspected`
when inconsistent); a free `flock` with a provably dead `pid` ⇒ `stale` (the
only held-file release path); no lock file ⇒ `no-lock-file`; and any ambiguity
(unreadable `locks/`, corrupt metadata, unexpected `fs`/`flock` error) ⇒
`held` with a named reason.

## Selection-list in-progress marker (WL-0MV1BWETT005GSUJ)

Demotion alone is not enough for the selection list: an item whose worklog
status is still `open` (e.g. a claim released before its pane was re-opened)
would show no marker even though a work-item pane is open. To make the marker
reflect pane existence directly, the same pane-title lookup also drives a
display overlay:

- `markItemsActiveByPane(items, activeIds)` recursively stamps
  `status = 'in-progress'` on every item whose ID is in the active pane set,
  so the row renders the in-progress icon and the item is placed in Group N.
  It is **idempotent**: each item's pre-marker status is captured on first
  sight (a non-enumerable `Symbol` property) and restored on every later
  pass, so a **closed** pane clears the marker back to the true worklog
  status without a `wl` re-fetch.
- The same pass also drives the row's **green-circle icon** (the agent slot
  of the icon prefix): an item with a matching pane gets
  `agentState = 'working'` (the green circle) and an item without one gets it
  cleared. This is the producer's rule — the green circle appears exactly
  when a work-item pane is open in this workspace and never otherwise. The
  icon no longer depends on the event-driven agent-status tracker
  (WL-0MSBQUJQX005RAT9), which could not honour that invariant (a
  freshly-spawned/`unknown` pane is absent from `herdr agent list` and was
  pruned — losing its icon permanently; an agent `done` state pruned the
  icon even while the pane stayed open).
- `applyActivePaneMarkers(items, listActivePanes, workspaceId)` fetches the
  workspace panes (fail-open) and applies the marker; the production wiring
  injects it into `runWorklistTui`'s `applyActivePaneMarkers` seam from
  `index.ts`.
- **Update cadence.** Opening or closing a work-item pane does **not** touch
  the worklog DB, so the DB-change-gated refresh tick can never update this
  marker for it. The worklist therefore re-applies it on the initial load, on
  every full refresh, on the `active-pane-marker` scheduler task (the
  hydrator cadence, `HYDRATOR_INTERVAL_MS`), on focus-resume, and after pane
  lifecycle events (`pane_agent_status_changed` / `pane_agent_detected` /
  `pane_closed` / `pane_exited`) so the green circle tracks open/closed
  panes without the 30 s wait. The marker task spawns only `herdr pane list`
  (never `wl`), so the zero-`wl`-when-idle guarantee holds; it is
  visibility- and typing-gated like the hydrator.
- Terminal `in_review`/`completed` items are deliberately left untouched by
  the STATUS marker: they already carry the review/audit marker and belong
  in the In Review group. The green circle STILL reflects pane existence for
  them — an open pane means the item is being worked regardless of stage.

## Release trail (WL-0MVWDB7F2003SORI)

When the hydrator releases a claim it must not leave the item parked on a
scheduling hold. A non-empty `assignee` is that hold (WL-0MV85WDOM007BKF8), so
a release that writes only `--status`/`--stage` produces a permanently
undispatchable item (live evidence: `LP-0MVUH9OMY004MQ3U` sat at
`open/intake_complete` with `assignee=Map` after its release). Every release
therefore:

- **clears the hold with a compare-and-swap** — `wl update <id> --status …
  --stage … --assignee "" --if-assignee <observed holder> --json`. The CAS
  mirrors `rollbackClaimWorkItem()` in `fetcher.ts`, so a concurrent assignee
  change is never clobbered; when the item had no holder there is no
  `--if-assignee` guard.
- **records the previous holder in the release audit comment** — `wl comment
  add <id> --comment "<deciding signal>; previous assignee: <holder|(none)>"
  --author herdr-hydrator --json`, e.g. `released because no pane and claim
  holder dead; previous assignee: implement` (`HYDRATOR_COMMENT_AUTHOR`). A
  comment failure is logged and tolerated: the demotion stands and the cycle
  continues — the `[hydrator] released …` log line remains the primary local
  trail.
- **logs the deciding signal** — `[hydrator] kept <id>: live claim holder pid
  <pid> session <sid>` on suppression, and `[hydrator] released <id>: … (no
  pane, claim holder dead)` (or `(no matching pane)` when no lock was
  involved) on release. Kept (pane-matched or held) items emit neither an
  assignee clear nor a comment.

## Non-goals (deliberate)

- **No wall-clock TTL and no heartbeat.** `started_at` age and file existence
  are never liveness evidence — the lock file persists after release (all 40
  `child-*.lock` files measured on the llm store on 2026-10-31 recorded dead
  pids). Only kernel `flock` heldness — with the guarded pid fallback — is.
  A TTL would re-create `WL-0MSOJLZD9004P8PI`'s original stuck-claim defect.
- **No new protocol and no cross-repo dependency.** The probe reads the
  existing lock sidecar defensively and sits behind an injected seam, so the
  lock format can change without touching orchestration.
- **No change to dispatch, the worklist selection marker, the drive
  orchestrator or `implement.py`.** The claim holder is an additional busy
  signal, not a second dispatcher.
- **Orphaned-lock cleanup and hydrator log rotation are separate items**, not
  part of this design.

## Files

- `packages/herdr/src/hydrator.ts` — module: ID extraction, active-pane
  matching (`collectPaneWorkItemIds` / `isActivePaneMatch`), demotion
  decision, pane-based selection-list marker (`markItemsActiveByPane` /
  `applyActivePaneMarkers`), compatibility repair, orchestration
  (`runHydrationOnce`), visibility-gated runner (`createHydratorRunner`),
  production deps (`createProductionHydratorDeps`).
- `packages/herdr/src/hydrator.test.ts` — unit tests (AC6 map below),
  including the pure pane-marker helper.
- `packages/herdr/src/hydrator.fixtures.ts` — recording exec seam +
  worst-case pane/item fixtures.
- `packages/herdr/src/worklist.ts` — registers the `hydrate` and
  `active-pane-marker` scheduler tasks, hooks the focus-resume path, and
  applies the injected `applyActivePaneMarkers` marker on the initial load,
  each refresh, the marker cadence, and focus-resume.
- `packages/herdr/src/worklist-active-pane-marker.test.ts` — integration
  tests for the selection-list marker wire-up (marker shown/hidden/scope).
- `packages/herdr/src/index.ts` — production wiring of the
  `applyActivePaneMarkers` seam.
- `packages/herdr/src/pane-title.ts` — `truncatePaneTitlePreservingSuffix`
  keeps the work-item ID visible in truncated pane titles, which is what makes
  the pane-title match reliable.
- `packages/herdr/src/claim-lock.ts` — `probeClaimHolders`, the local
  claim-holder heldness probe (mechanism, fail-open rules and measured cost
  above).
- `packages/herdr/src/claim-lock.test.ts` — probe contract tests (real
  `flock` holder process, stale fixtures, fail-open error classes, pid-reuse
  guard, bounded cost, no side effects).

## Test map (AC6)

| Requirement | Test |
|---|---|
| ID extraction | `extractWorkItemIdsFromText` |
| active-pane matching (title contains ID, workspace-scoped) | `active-pane matching` |
| in_review → completed | `decideDemotion` + `runHydrationOnce` |
| dependency-blocked → blocked | `decideDemotion` + `runHydrationOnce` |
| else → open | `decideDemotion` + `runHydrationOnce` |
| stage/status compatibility | `compatibleStage`, blocked-at-`in_progress` case |
| focus-resume immediate run | `createHydratorRunner` (visibility flip) |
| selection-list marker (pane → in-progress) | `pane-based active marker (selection list)` + `worklist-active-pane-marker.test.ts` |
| green circle (pane → `agentState`) stamp/clear | `markItemsActiveByPane` cases + `worklist-active-pane-marker.test.ts` |
| event-driven pane refresh (no `herdr agent list` exec) | `worklist-agent-state-event.test.ts` |
| fail-open error paths | `runHydrationOnce` (missing list, missing panes, failed demotion) |
| claim-holder heldness (probe) | `claim-lock.test.ts` — live `flock` holder, dead holder, missing file, fail-open classes, pid-reuse guard, bounded cost, no side effects |
| held suppresses only the `open` release | `decideDemotion` + `runHydrationOnce` “suppresses the open release while a claim holder is live”, “held never overrides the in_review → completed branch”, “held never overrides the blocked branch” |
| pane match stays primary (zero probes) | `runHydrationOnce` “never probes an item with a matching pane”, “queries the batched probe once per cycle…” |
| dead holder still released | `runHydrationOnce` “releases a pane-less item whose recorded holder is dead, logging the dead-holder signal” |
| probe fail-open (timeout / throw / missing verdict) | `runHydrationOnce` “aborts the cycle (no demotion) when the claim-probe step exceeds its budget” and the throw/abnormal + missing-verdict cases |
| kept / released log lines name the signal | `runHydrationOnce` kept/released log assertions |
| release clears the hold (CAS) + audit comment | `runHydrationOnce` argv assertion (`--assignee "" --if-assignee <prev>`) + `buildReleaseComment` cases |

## Related

- `WL-0MSOJLZD9004P8PI` (this feature) · `WL-0MTTSWE0G008M1VA` (folded-in
  no-activity timeout, deleted) · `WL-0MTTS9FY00055QJV` (RCA root cause E) ·
  `WL-0MSJ4E8UA005KG9Y` (pane-title format, completed) ·
  `WL-0MV1BWETT005GSUJ` (pane-title active-detection rework, this item) ·
  `WL-0MSBQUJQX005RAT9` (agent-panes association — now record-keeping only;
  the row green-circle icon is pane-title existence, WL-0MV1BWETT005GSUJ).
