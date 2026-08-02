# Pause-when-hidden: verifying zero wl process churn from hidden/idle selection lists

This document describes the pause-when-hidden behavior shipped in
WL-0MSB1N0HB0007N6N (Pi extension polls `wl list` / `wl next` even when the
selection list is not visible) and how to verify it.

> **Related:** see [wl-process-spawning-investigation.md](./wl-process-spawning-investigation.md)
> for the full root-cause analysis, spawn trace, remediation plan, and
> health-check proposal (WL-0MSB19J56006E87J).

## Background

Pi agent sessions and herdr worklist panes spawn `wl` subprocesses on a
refresh cadence. Each `wl` invocation spawns a Node.js process (~50 MB).
With 13 concurrent pi agents this produced **206 concurrent wl processes
consuming ~17 GB RAM** and load averages of 150–225 on a 16-core host —
even when no selection list interaction was happening.

Two pollers were fixed:

| Poller | File | Cadence | Fix |
|--------|------|---------|-----|
| Pi extension browse selection widget | `packages/tui/extensions/Worklog/lib/browse.ts` | 5s interval (4–5 wl spawns/tick) | **Idle gating**: pause fetch + `wl sync --if-idle` after 30s without keypresses (`IDLE_PAUSE_MS`); resume immediately on the next keypress. |
| Herdr worklist pane | `packages/herdr/src/worklist.ts` | 30s refresh + 60s sync timers (~4–5 wl spawns/tick per pane) | **Pane-focus gating**: skip timer ticks when the pane is hidden (`HERDR_PANE_ID` → `herdr pane get` → `result.pane.focused === false`); fail-open otherwise. |

## Behavior summary

### Pi browse widget (idle gating)

- Mount counts as interaction — a freshly opened selection list starts active.
- While the user browses/interacts, the 5s auto-refresh cadence is unchanged.
- After **30 seconds without a keypress**, the refresh interval skips both the
  fetch and the auto-sync trigger → **zero `wl` spawns** while idle.
- The first keypress after an idle pause triggers an immediate refresh and
  resumes the normal cadence.
- The idle threshold is a named module constant (`IDLE_PAUSE_MS`, default
  30_000ms) — no settings toggle, always on.
- Manual actions (navigation, shortcuts, `r`/`S`-style refreshes) are never
  gated; the detail-view widget (no interval) is unaffected.

### Herdr worklist pane (pane-focus gating)

- Visibility signal: `HERDR_PANE_ID` → `herdr pane get <id>` →
  `result.pane.focused`. A hidden (non-focused) tab reports `focused: false`.
- When hidden, the auto-refresh and auto-sync timer ticks are skipped →
  **zero fetcher / `wl sync --if-idle` spawns**.
- Fail-open: no `HERDR_PANE_ID`, herdr CLI missing/erroring, or unparseable
  output → the pane is treated as visible and polling continues as before.
  Standalone runs (outside Herdr) are unaffected.
- Visible-pane cadence unchanged (30s refresh / 60s sync defaults).
- The list header shows `[paused — hidden]` while gating is active.
- Manual `S` (sync), navigation, chords, and the initial data load are never
  gated.
- `PollGate` (TTL ~2s) shares one `herdr pane get` call across refresh+sync
  ticks in a cycle (≤1 visibility exec per cycle).

## Verification procedure

### 1. Count `wl` processes per session/pane

```bash
# All wl (next|list|sync) processes, grouped by parent command
ps -eo pid,ppid,etime,args | grep -E 'wl (next|list|sync)' | grep -v grep

# Count only
ps -eo args | grep -E 'wl (next|list|sync)' | grep -v grep | wc -l
```

Expected while **active/visible**:

- Pi browse widget actively browsed: ~4–5 `wl` spawns per 5s tick (transient).
- Herdr worklist pane focused: ~4–5 `wl` spawns per 30s tick (transient).

Expected while **hidden/idle**:

- Pi browse widget left idle (> 30s since last keypress): **0 auto-spawned**
  `wl` processes from that session.
- Herdr worklist pane tab hidden: **0 auto-spawned** `wl` processes from that
  pane.

### 2. Per-session measurement (pi browse widget)

1. Open a pi session with `WL_PIMAN=1` (auto-opens the browse flow) or type
   `/wl` to open the selection list.
2. Confirm the list refreshes while you interact (press `j`/`k` occasionally):
   `ps -eo args | grep -E 'wl (next|list|sync)' | wc -l` should show transient
   spawns.
3. Stop interacting for 60+ seconds. The count should drop to near zero and
   stay there (no periodic `wl` spawns from that session).
4. Press any key — the list refreshes immediately and the cadence resumes.

### 3. Per-pane measurement (herdr worklist)

1. Open the worklist pane (`prefix+l` or the plugin action). Note its pane id:
   `echo $HERDR_PANE_ID` inside the pane, or `herdr pane current`.
2. Focus the pane and confirm auto-refresh spawns:
   `ps -eo args | grep -E 'wl (next|list|sync)' | wc -l` shows transient spawns
   every 30s, and the header shows no `[paused — hidden]` marker.
3. Switch to another tab (hiding the worklist pane). Within ~2s the header
   shows `[paused — hidden]` and the `wl` process count from that pane drops
   to zero.
4. Switch back — the pane resumes its normal cadence.

### 4. System-level idle test

With N idle pi sessions and no visible selection lists / hidden herdr panes:

```bash
watch -n 2 'ps -eo args | grep -E "wl (next|list|sync)" | grep -v grep | wc -l'
```

Expected: the count stays near **0** (only transient syncs from actively
used panes). Before this fix, N idle agents produced dozens of concurrent
`wl` processes per minute per session.

## References

- Parent work item: Pi extension polls wl list / wl next even when selection
  list is not visible (WL-0MSB1N0HB0007N6N)
- Investigation: Investigate excessive wl process spawning
  (WL-0MSB19J56006E87J)
- Related: Central cache for wl read results to cut Herdr refresh spawn churn
  (WL-0MSAZQEQB008O7H3)
