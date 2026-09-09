# RCA: Downtime Worker “3 consecutive wl CLI errors — pausing dispatch”

**Item:** WL-0MTOTCETU004YYIU
**Date:** 2026-09-06
**Status:** Fix landed (diagnosability + bounded transient retry)

## Summary

Every dispatch attempt in the observed window was followed ~90 s later by a
60-minute pause (`DOWNTIME_ERROR_STRIKE_LIMIT=3` → `pausing dispatch for
3600000ms`). The pause was triggered across all projects because the downtime
dispatcher's `wl` lookups (`wl next` / `wl list` / `wl show` / `wl dep list`)
share a single SQLite database per worklog root and a single
`DOWNTIME_WL_TIMEOUT_MS=10 s` child-process bound. A single transient
`SQLITE_BUSY` / `database is locked` contention (better-sqlite3
`busy_timeout` expiry) burned one strike; three consecutive ticks burned
three strikes → 60-minute cooldown. A 10 s `ETIMEDOUT` hang is a full
wall-clock stall and correctly remains a strike (retrying it would triple
to 30 s and risk `DOWNTIME_RUN_TIMEOUT_MS`).

Prior fixes in siblings closed distinct contributors but did not add a per-tick
backoff, so a single transient still cascaded:

- **WL-0MSKZ30SK007K9TO** — same-timestamp merge loop (deterministic tie-breaker;
  visible in `.worklog/logs/sync.log:18-24` `type=same-timestamp chosen=local`).
- **WL-0MSG8EG7P002MX2I / WL-0MT5J4Q290025O0L** — WAL growth / `wal_checkpoint(PASSIVE)`
  after `importData()` (`packages/shared/src/persistent-store.ts:importData`).
- **WL-0MTEZ5EK5002RXXD** — leader-lease expiry causing zombie dispatch during
  `no-candidate` cooldown (re-derive `leaderState` every tick + `refreshLease` self-heal).
- **WL-0MTL4PC0Y005GXTI (+ d749b192)** — pause log was undiagnosable (generic
  `recordError({message})`); now `DowntimeErrorEvent.error` and
  `DowntimeDispatchOutcome.error` propagate the captured `stderr`/timeout string
  to `pauseAfterPersistentErrors` / `.worklog/downtime-dispatches.log`.

Remaining gap (this item, AC3): **no retry/backoff on transient `wl` failures** —
`packages/herdr/src/downtime-worker.ts:213` defined only
`strike-count-then-pause`; every `getExecFileAsync('wl',…, {timeout: DOWNTIME_WL_TIMEOUT_MS})`
in `packages/herdr/src/index.ts` (`createDowntimeDeps`) failed fast.

## Evidence

- `downtime-dispatches.log` — recurring
  `{"message":"Downtime worker: 3 consecutive wl CLI errors — pausing dispatch for 3600000ms."}`
  at `2026-09-02T15:46:23Z`, `16:17:37Z`, `16:47:34Z`, `17:17:39Z`, … ~90 s apart
  (3× ~30 s ticks) across ContextHub / open_source_llm / AI_Hell. Pre-fix the
  log carried only `{cwd,at,message}` (generic text) — cause not diagnosable
  without archaeology.
- `packages/herdr/src/downtime-worker.ts:2718` `pauseAfterPersistentErrors`
  now records `error` alongside `message` and writes it via `appendDowntimeLogEntry`
  (`packages/herdr/src/downtime-log.ts:86` `DowntimeLogEntry.error/exitCode/outcome`),
  satisfying AC2/AC6.
- `packages/herdr/src/downtime-worker.ts:2718` + `packages/herdr/src/index.ts`
  `createDowntimeDeps` — `wl` invocations use `DOWNTIME_WL_TIMEOUT_MS=10_000`
  and throw on timeout/parse failure → `{ok:false}` → one `wl-error` strike.
  Three consecutive strikes → `cooldownUntil = Date.now()+noCandidateCooldownMs`
  (60 min). Successful `dispatched` or genuine `no-candidate` resets to 0.
- Sibling verification: `WL-0MSKZ30SK007K9TO`, `WL-0MSG8EG7P002MX2I`,
  `WL-0MTEZ5EK5002RXXD`, `WL-0MTL4PC0Y005GXTI` are `completed`/`done`; the parent AC
  requires those contributors to *stop cascading strikes* — diagnosability only
  (d749b192) was insufficient (audit AC3 `partial`).

## Ranking of contributors

1. **Transient `SQLITE_BUSY` / `database is locked`** — highest. Concurrent
   writers to the same `.worklog/worklog.db` (herdr pane's own transaction
   vs `wl sync` import vs parallel downtime tick) contend on
   `better-sqlite3` with `busy_timeout = 250–5000 ms`. The waiter surfaces
   `SQLITE_BUSY: database is locked` instantly (well inside the 10 s
   `DOWNTIME_WL_TIMEOUT_MS`); without retry that single fast transient
   burns a strike. A 10 s `ETIMEDOUT` hang is the slow path and stays a
   strike — it already consumed the wall-clock budget.
2. **WAL growth / checkpoint pressure** — second. Fixed by passive checkpoint
   after bulk imports; still a transient on hot import windows.
3. **Same-timestamp sync-conflict loop** — third. Fixed by deterministic
   lexicographic tie-breaker; no longer a persistent loop but contributed to
   churn before.
4. **Leader lease zombie during cooldown** — fourth. Fixed by per-tick
   re-derive + self-heal; no longer dispatchs while stale.

## Fix (this iteration)

- **Diagnosability (AC2/AC6, landed d749b192):** every `wl-error` path
  (`DowntimeNextResult`, `DowntimeItemResult`, `DowntimeMostImportantItemResult`,
  `DowntimeClaimResult`, `DowntimeActiveAuditResult`, `DowntimeErrorEvent`) now
  carries the captured error string to `pauseAfterPersistentErrors`; rolling
  log entry retains `error`/`exitCode`/`outcome`.

- **Bounded transient retry (AC3, this change):** new helpers in
  `packages/herdr/src/downtime-worker.ts`:
  - `isTransientDowntimeError(msg)` — matches `SQLITE_BUSY`, `database is locked`,
    `database busy` only (fast contention). `ETIMEDOUT`/`timed out`/`timeout`
    are intentionally NOT retried: each attempt already cost ~10 s; retrying
    would be ~30 s and wedge the tick toward `DOWNTIME_RUN_TIMEOUT_MS=60 s`.
  - `withTransientRetry(fn, retries=2, baseDelayMs=50)` — retries only transient
    errors with exponential backoff `50 ms, 100 ms` (< 200 ms extra wall-clock,
    well inside `DOWNTIME_RUN_TIMEOUT_MS=60_000`). Non-transient (parse /
    author-identity gate) fails fast.
  - Wrapped every `getExecFileAsync('wl', …, {timeout: DOWNTIME_WL_TIMEOUT_MS})`
    in `packages/herdr/src/index.ts` `createDowntimeDeps`:
    `fetchCriticalBlockers` (`dep list` + `show`), `fetchAuditItemById`
    (`show` + audit `list`), `getNextItem` (`next`), `getNextAuditCandidate`
    (`list`), `getActiveAudit` (`list`), `getNextImplementCandidate` (`next`),
    `getNextCriticalCandidate` (`list`). A single transient no longer burns a
    strike; persistent transients (3 attempts) still fail closed as a strike,
    preserving the three-strike safety valve.

- **Three-strike rule preserved:** `DOWNTIME_ERROR_STRIKE_LIMIT=3` unchanged;
  only the *classification* of transient vs persistent changes. Persistent
  `wl` failures still pause for `noCandidateCooldownMs` (60 min).

## Verification (AC4/AC5)

- **AC4 — strikes no longer cascade:** unit tests
  `isTransientDowntimeError` / `withTransientRetry` and retry-wiring tests
  simulate `SQLITE_BUSY` on first attempt and verify success on retry (no
  `wl-error` outcome) vs persistent `SQLITE_BUSY` after 3 attempts (single
  `wl-error` strike, not 3 strikes from 1 transient). The dispatcher resets
  `errorStrikes=0` on `dispatched` / genuine `no-candidate`; a fast
  transient retried within the tick never increments `errorStrikes`.
- **AC5 — no regressions:** `npm run build` clean; full suite green
  (`packages/herdr/src/downtime-worker.test.ts`, `coordination-dispatch`,
  `sync-conflict`); pre-push hook re-runs full suite on push to `dev`.
- **AC1/AC2 — durable observability:** pause entry now includes `error` field
  (`SQLITE_BUSY: database is locked`, `spawn ETIMEDOUT`, parse failure)
  so future pauses are diagnosable from the rolling log alone.

## Follow-ups

- Consider adding the same transient retry to `packages/herdr/src/fetcher.ts`
  `runWl` for the TUI refresh path (same busy-timeout pragmas).
- Monitor `.worklog/downtime-dispatches.log` for post-fix `error` distribution
  to confirm the transient class.
