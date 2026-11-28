# Diagnosis: dependency-blocked critical item dispatched to `implement`

Work item: **WL-0MWWMPA09006K8ZZ** (F0 of **WL-0MWWLLGD2001QKAL**).
Diagnosis performed 2026-11-25 against `dev` @ `774b3aedf`. Evidence is
recorded here so the follow-on fixes (F1–F5) cite measurement, not assumption.

## Question

The parent bug reported that the downtime worker dispatched
`/skill:implement` four times at `AH-0MWWARFUK009KQM7` (AI_Hell, `critical`,
`stage: plan_complete`, live outbound `depends-on` edge to the unimplemented
feature `AH-0MWW6PNA5008NC91`, a non-terminal blocker). The parent's strong
hypothesis was a six-week-stale `herdr` install. This diagnosis tests that
hypothesis and the narrower "missing dependency check on the head/coordination
paths" hypothesis with evidence.

## Conclusion (short)

The **source** is at fault, not a stale install. The dispatch came from the
**coordination-offer path**, which selects critical work through
`selectCriticalFirstCandidates` — a helper with **no dependency lookup at all**.
The dependency-frontier protection exists only in the legacy tier chain, which
production dispatch never reaches.

A *process*-staleness vector does exist and is real, but it does not explain
these four dispatches: the modules that produced them are byte-identical to
current `dev`. It does mean the fix will not take effect until the long-lived
panes restart, which is the justification for F5 (observability, not the
primary fix).

## 1. Which selection path dispatched

Direct evidence, AI_Hell decision log
(`/home/rgardler/projects/AI_Hell/.worklog/downtime-dispatches.log`):

| line | dispatchedAt | kind | selectionPath | selectionReason |
|---|---|---|---|---|
| 79–80 | 2026-11-25T19:03:55 | implement | `coordination-offer` | `leader-offer` |
| 89–90 | 2026-11-25T20:41:09 | implement | `coordination-offer` | `leader-offer` |
| 97–98 | 2026-11-25T21:20:03 | implement | `coordination-offer` | `leader-offer` |

Each dispatch writes two entries (a pre-spawn and an enriched post-spawn
record). The host-budget log corroborates the same events:

```
~/.herdr/downtime/dispatch-budget.log:184-185  19:03:55/56  reserve+confirm  AH-0MWWARFUK009KQM7  actor herdr:1911772
~/.herdr/downtime/dispatch-budget.log:193-194  20:41:09/10  reserve+confirm  AH-0MWWARFUK009KQM7  actor herdr:1911772
~/.herdr/downtime/dispatch-budget.log:201-202  21:20:03/04  reserve+confirm  AH-0MWWARFUK009KQM7  actor herdr:1911772
~/.herdr/downtime/dispatch-budget.log:215-216  21:48:42/45  reserve+confirm  AH-0MWWARFUK009KQM7  actor herdr:1912540
```

`actor`/`instanceId` is `herdr:<pid>`, so these four dispatches are attributable
to two concrete processes: **pid 1911772** (three dispatches) and **pid 1912540**
(one) — both `npx tsx src/start.ts` with cwd
`/home/rgardler/projects/ContextHub/packages/herdr`.

Code path (file:line):

- `packages/herdr/src/downtime-worker.orchestrator-dispatch.ts:616-618` — when
  `coordinationDir` **and** `deps.fetchItem` are wired, `performDispatch`
  routes to `dispatchFromCoordination`. Coordination is live in this machine
  (`~/.herdr/downtime/downtime-coordination.json` carries active entries and a
  leader lease), matching the `coordination-offer` log token.
- `packages/herdr/src/downtime-worker.coordination.ts:318` — the offer scan
  iterates `selectCriticalFirstCandidates(head.items, now, frozen)`.
- `packages/herdr/src/downtime-worker.dispatch-filter.ts:102-119` — the whole
  selector: it filters on `priority === 'critical'`, `status open|blocked`,
  `needsProducerReview !== true`, then `classifyItemForDispatch`. **No
  dependency read.**
- The only dependency-aware selection,
  `resolveDependencyFrontier` (`downtime-worker.selection.ts:532`), is called
  from exactly one place: `index.ts:1023` inside `getNextCriticalCandidate`
  (`index.ts:978`), i.e. the legacy tier chain (`downtime-worker.dispatch.ts:837`).
  That chain is only consulted when the Herdr head is empty
  (`downtime-worker.dispatch.ts:523-546`), which production
  `createDowntimeDeps` never produces, and coordination mode bypasses it
  entirely.

By inspection, none of the coordination/head modules consult dependency edges:
`grep -n "dep list|fetchCriticalBlockers|depends-on"` returns no hits in
`downtime-worker.dispatch-filter.ts`, `downtime-worker.coordination.ts`,
`downtime-worker.coordination-leader.ts` or `downtime-worker.head-scan.ts`.

The reported shape therefore classified as `implement` and was offered and
dispatched at itself, exactly as the plan predicted.

## 2. Stale-runtime hypothesis, with evidence

The parent's premise (a six-week-stale `~/.local/bin/herdr` 0.9.5 binary) does
not hold:

- `~/.config/herdr/plugins.json:169-176` registers `worklog-selection-list`
  with `plugin_root` `/home/rgardler/projects/ContextHub/packages/herdr`; the
  pane command is `npx tsx src/start.ts` (confirmable in `ps`). The dispatcher
  runs from **checkout TypeScript sources**, not from the multiplexer binary.
- `~/.local/bin/herdr` (0.9.5, mtime 2026-10-15) is the **multiplexer**; it
  contains no dispatcher logic. Its age cannot change dispatch selection.
- The staleness axis that *could* matter is the long-lived **process** module
  graph: both dispatching pids started `2026-11-24 12:19:25` / `12:19:38`, i.e.
  the checkout at that instant (`862339848`, committed 2026-11-24 11:35). They
  had been running ~31 h by the first dispatch.

Measured against current `dev` (`774b3aedf`), blob-for-blob at `862339848`:

| Module | Same as current `dev`? | Source mtime vs process start (Nov 24 12:19) |
|---|---|---|
| `downtime-worker.dispatch-filter.ts` | identical | 2026-11-23 — **older** (loaded version is current) |
| `downtime-worker.coordination.ts` | identical | 2026-11-17 — **older** |
| `downtime-worker.selection.ts` | identical | 2026-11-17 — **older** |
| `downtime-worker.head-scan.ts` | identical | 2026-11-24 11:41 — **older** |
| `downtime-worker.orchestrator-dispatch.ts` | identical | 2026-11-24 11:41 — **older** |
| `downtime-worker.coordination-leader.ts` | **differs by a doc comment only** (`b5c5efcc6`, 2026-11-24 13:29) | newer |
| `index.ts` | differs (`ba7f4e89f`, 2026-11-25 21:52 — pane-close reaper) | newer |

So the executing module graph reproduces the defect on current `dev`; the two
"newer" files cannot affect critical-first selection (`coordination-leader.ts`
change is comment-only, and `index.ts`'s change landed 30 min after the last
dispatch and touches pane-close bookkeeping).

**Residual, genuine staleness risk:** `tsx src/start.ts` (no `--watch`) loads
the module graph once. Any fix merged to `dev` is invisible to these panes until
they restart. That is a *deployment/observability* problem, not the cause of
this bug, and it is what F5 should cover (e.g. record the running commit /
source mtimes at startup and warn when the checkout moves ahead).

## 3. `needsProducerReview` measurement (parent AC3 premise)

Measured in a throwaway worklog (`wl init` in `/tmp`, `DG-…` item, `critical`,
`open`):

| state | `wl worklist --json .subsets.critical` |
|---|---|
| `needsProducerReview: false` | contains the item |
| `needsProducerReview: true` | **still contains the item** (count unchanged) |

`needsProducerReview` is therefore a *dispatch-path* filter only
(`downtime-worker.dispatch-filter.ts:108`) and remains in the display subsets, so
the display/dispatch divergence is intended and must be preserved (parent AC4,
`WL-0MV6TFX0600145M2`) — but the flag is not a dependency guard and cannot be
relied upon as one.

Note: `AH-0MWWARFUK009KQM7` now reads `status: blocked`,
`needsProducerReview: true` (post-hoc state change made after the dispatches).
That is why no further dispatch has occurred; it does **not** invalidate the
logged evidence, which records four dispatches while the item was `open` with
the flag false.

## 4. What the conclusion means for follow-on work

- **Primary fix: source.** The dispatch/offer selection must consult dependency
  edges — F2 (dependency-frontier guard for the Herdr-head/coordination offer
  paths) and F3 (dispatch-time re-check before claim and spawn). F1 already
  encodes the blocked-leaf regression.
- **Secondary: deployment/observability.** F5 is justified, but as a freshness
  signal for the long-lived pane processes, not as the root-cause fix: the
  running code *was* the current code, yet the same failure would recur silently
  if a future fix needed a restart nobody noticed.
- **Not a packaging defect:** nothing needs rebuilding or reinstalling for
  selection behaviour; `~/.local/bin/herdr` 0.9.5 is irrelevant here.
- **Preserved invariant:** display keeps dependency-blocked items; only dispatch
  changes. No `--include-blocked`-style filter is added.

## 5. Evidence limits

- The decision log's `selectionPath` token is the authoritative record of the
  dispatch entry; it is written by the dispatcher itself, so no inference is
  needed to identify the path.
- The exact loaded module bytes cannot be read back from a running process;
  the blob comparison plus source-mtime comparison above is the strongest
  available proxy and is decisive for every module that participates in
  critical-first selection.
- The 21:48 dispatch (pid 1912540) appears in the host-budget log but not in the
  AI_Hell decision log, whose last write is 21:25; its kind (`implement`) and
  target are still recorded, so the count of four implement dispatches is
  evidenced, but the per-dispatch `selectionPath` token is available for three
  of them. All three say `coordination-offer`, and pid 1912540 ran the same
  checkout, so treating the fourth as the same path is a documented inference,
  not an assumption about the code.
