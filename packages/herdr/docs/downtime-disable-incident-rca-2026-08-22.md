# RCA: downtime dispatch continued while the operator believed it disabled (2026-08-22)

**Work item:** WL-0MT4BWUHW008LIFE · **Write-up item:** WL-0MT5SMVXS004T3BK (AC6)
**Date:** 2026-08-23 (analysis of 2026-08-22 incident evidence)

## Incident summary

- ContextHub audit `WL-0MSKSMRFP001Q3XU` was dispatched at
  **2026-08-22T11:05:23.163Z** (`.worklog/downtime-dispatches.log` line 64,
  cwd `/home/rgardler/projects/ContextHub`), while the operator believed
  downtime dispatch was disabled (they had pressed `d` and seen
  `[Downtime Off]`).
- A multi-root dispatch wave followed at 11:12Z, 11:15Z, 11:42Z, 11:47Z
  (herdr-server.log pane spawns), and the operator's worklist header later
  showed `[⏳ downtime idle 40+ min]` — the enabled-and-idle worker state.

## Evidence used

| Artifact | Path | What it shows |
|---|---|---|
| Dispatch audit log | `.worklog/downtime-dispatches.log` | `WL-0MSKSMRFP001Q3XU` audit dispatched 11:05:23.163Z (cwd ContextHub); intake of the same item at 08:33:47Z earlier |
| Herdr server log | `~/.config/herdr/herdr-server.log` | 4 Downtime panes spawned 11:05:09–11:05:23Z (pane 210 pid 302077, pane 211 pid 302156, pane 212 pid 302252, pane 213 pid 302464); pane 213 spawned 11:05:23.495Z — matches the audit dispatch to the second. Further spawns 11:12:48, 11:15:22/29, 11:42:03, 11:47:25. Worklist plugin panes opened at 10:25:55 and 10:28:11 (`plugin.pane.open`) with no worklist restart between 10:28 and 11:05 |
| Plugin config | `~/.config/herdr/worklog-plugin.json` | No `downtimeEnabled` key → every worker follows the default (**enabled**) |
| Worklog command log | `~/.config/herdr/worklog-command-log.json` | No `/downtime toggle` entries — the press is an internal action, unlogged (confirmed, intake brief) |

## Hypotheses evaluated

### H1 — override lost/cycled after the press — **CONFIRMED (mechanism present)**

Two old-code failure modes both match the observed outcome:

1. **Cycle force-enable.** The pre-fix `toggle()` cycled
   `null → false → true → null` (downtime-worker.ts). A **second** `d` press —
   an accidental double-press or a deliberate press-with-confusion — set
   `override = true`, **force-enabling dispatch** even over a settings-level
   disable. This alone explains the 11:05:23Z ContextHub audit dispatch.
2. **In-memory only, lost on any lifecycle event.** The override was never
   persisted. The worklist panes were (re)opened at 10:25:55 and 10:28:11
   (`plugin.pane.open`); any press made in a pane that was closed/reopened
   before 11:05 silently reverted to `null` → followed the default-enabled
   setting. This also explains the later `[⏳ downtime idle 40+ min]` header:
   it is the honest render of a **fresh enabled worker** whose override was
   gone — the previously-disabled pane silently re-enabled.

Both variants are now removed by the fix: the toggle cycle is
`null → false → null` (no force-enable) and the disable is persisted via the
`.herdr-downtime-disabled` marker with a visible `[Downtime Off (restored)]`
header notice.

### H2 — in-flight dispatch completed after the press — **REJECTED**

An in-flight dispatch at the moment of the press could explain at most ONE
late dispatch (the one already spawning), and it would still render the
disabled header afterward. The dispatch log shows the audit entry was
*written* at 11:05:23.163Z and the pane spawned at 11:05:23.495Z — a **new**
dispatch, not a completion of an earlier one. Multi-pane waves and the
enabled-idle header are not explained by H2. Verdict: not the cause.

### H3 — scope mismatch: sibling panes kept dispatching — **CONFIRMED (contributor)**

Leader-only dispatch (WL-0MSXHA1B0005G3E5) is blocked/unimplemented, so every
worklist pane dispatches independently. The 4-pane wave at 11:05:09–23Z (13
seconds) is the signature of **multiple roots' workers each passing their idle
gate in the same idle stretch** — the operator's `d` press disables only the
pane it was pressed in (per-instance scope, WL-0MSZ4NSOE007AQEF), never its
siblings. That is why dispatch continued across roots at 11:12–11:47Z no
matter what one pane's header said. This part is by-design per-pane scoping —
now made explicit in the README — plus the operator's observed reality that
multiple panes were concurrently enabled by default.

## Confirmed root cause (joint)

**H1 + H3.** The ContextHub audit at 11:05:23Z is best explained by the old
toggle's force-enable cycle and/or the in-memory-only override being lost on
the 10:25–10:28 worklist pane (re)opens — either way a worker with
`override = null | true` followed the default **enabled** setting. The wider
11:05–11:47Z wave is explained by H3: every other root's worklist worker was
independently enabled by default and concurrently idle-dispatching. The
operator's disable intent was per-pane and non-durable on the old code — the
exact failure class the parent item's ACs target.

## Verification steps recorded

1. `grep WL-0MSKSMRFP001Q3XU .worklog/downtime-dispatches.log` →
   dispatch at 11:05:23.163Z + earlier intake at 08:33:47Z.
2. `sed -n '21651,21720p' ~/.config/herdr/herdr-server.log` →
   panes 210–213 spawned 11:05:09–23Z; pid 302464 pane 213 at 11:05:23.495Z
   matches the audit dispatch (a new dispatch, killing H2).
3. `grep 2026-08-22T1[01]: … | grep plugin.pane.open` →
   worklist panes opened 10:25:55 + 10:28:11; no worklist restart 10:28–11:05
   (partial H1-restart evidence: presses before 10:28 were already lost;
   presses after 10:28 would have survived had no restart occurred).
4. `cat ~/.config/herdr/worklog-plugin.json` → no `downtimeEnabled` key →
   defaults-enabled for every worker (H3).
5. Header-state observation: `[⏳ downtime idle 40+ min]` in a session the
   operator disabled → consistent with a fresh enabled worker after override
   loss (H1-restart) or an untoggled sibling pane (H3).

## Open questions from intake — closure

- **OPEN Q1 (pressed `d` once or more?)** — **Unresolvable from available
  logs**: the press is an internal TUI action and is not recorded in
  worklog-command-log.json. A double-press force-enable is the single most
  economical explanation of the ContextHub audit dispatch, but it cannot be
  proven. Acknowledged; the fix removes the failure mode regardless.
- **OPEN Q2 (same pane for `[Downtime Off]` and the idle header?)** —
  **Unresolvable**: header states are TUI-rendered, not logged. The report is
  consistent with two independent panes (one disabled, one enabled) or one
  pane that re-enabled — both covered by H1/H3.
- **OPEN Q3 (worklist pane restarted between press and dispatch?)** —
  **Partially answered**: no worklist restart is logged between 10:28 and
  11:05, but the worklist panes were *opened* at 10:25–10:28, so any press
  before those opens was definitively lost, and an unlogged pane close/open
  cannot be excluded. The fix's marker makes the disable durable across all
  such events.

## Fixes the parent item ships (failure-class coverage)

1. **Toggle cycle `null → false → null`** (WL-0MT58VKOW0066XJ6 /
   WL-0MT58WFJM001REH5) — a second press can never force-enable (AC3).
2. **Persisted disable marker** `.herdr-downtime-disabled`
   (WL-0MT58WX3X0092PTK / WL-0MT5SFP990001FNW) — disable survives restarts,
   still per worklog root (AC1/AC2).
3. **Header honesty** (WL-0MT5SFX1S002YUYZ / WL-0MT5SG0VU005ARUR) —
   `[Downtime Off (restored)]` whenever the disable was restored from the
   marker; the render always agrees with the effective gate (AC4).
4. **Scope/durability docs** (WL-0MT5SMS6Z0072P2L) — per-pane scope and
   marker durability are explicit in the README (AC5).