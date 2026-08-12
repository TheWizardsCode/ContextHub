# Downtime worker configuration audit — 2026-08-08 idle window

**Date:** 2026-08-08/09 · **Work items:** WL-0MSKUG2WW0058A7W (evaluation), parent RCA WL-0MSK9TUCA00206M7

## Purpose

Document the enabled/disabled/paused/window-rule configuration state of every
dispatch-capable herdr downtime worker pane that observed the idle window of
2026-08-07 21:55Z → 2026-08-08 (RCA: zero dispatches overnight despite
continuous status polling). This answers RCA hypothesis 4 (config/disablement)
and is acceptance-criterion 1 of WL-0MSKUG2WW0058A7W: *"Config state
(enabled/disabled/paused/window rules) documented for every dispatch-capable
pane that observed the idle window."*

## Method

1. Settings schema + defaults read from source (`packages/herdr/src/settings.ts`,
   `packages/herdr/src/downtime-worker.ts`).
2. Live settings file inspected: `~/.config/herdr/worklog-plugin.json`.
3. Per-project dispatch logs inspected:
   `<project>/.worklog/downtime-dispatches.log` (written by every successful
   dispatch and by the three-strike `recordError` path).

## 1. Settings schema — no dispatch-window-rule setting exists

The `PluginSettings` schema (`packages/herdr/src/settings.ts:43-60`) has
exactly these downtime keys: `downtimeEnabled`, `downtimeIdleThresholdMs`,
`downtimeRequiredFreeSlots`, `downtimePollIntervalMs`, `downtimeProxyUrl`,
`downtimeModel`, `downtimeNoCandidateCooldownMs`.

There is **no dispatch-window-rule setting** (no start/end time, no
day-of-week gate). The worker dispatches whenever the proxy reports idle
continuously for `downtimeIdleThresholdMs` — there is no calendar/window
constraint to disable.

The only gating that exists is the pane-visibility rule, and the downtime task
is the **one** scheduler task that is deliberately **NOT** visibility-gated
(`packages/herdr/src/worklist.ts:3378-3385`): unlike refresh/sync it runs
while the worklist pane is open, hidden or not. A hidden pane still dispatches.

## 2. Defaults in force

`defaultSettings` (`packages/herdr/src/settings.ts:73-79`) and module constants
(`packages/herdr/src/downtime-worker.ts:80,117`):

| Setting | Default | Meaning |
|---|---|---|
| `downtimeEnabled` | `true` | worker enabled |
| `downtimeProxyUrl` | `http://192.168.0.199:8000` | llama-proxy endpoint |
| `downtimeNoCandidateCooldownMs` | `3_600_000` (60 min) | pause after genuine empty backlog |
| `downtimeIdleThresholdMs` | `240_000` (4 min) | min continuous idle before dispatch |
| `downtimePollIntervalMs` | `30_000` | proxy poll cadence |
| `downtimeModel` | `plan` | pi model for dispatched panes |

Missing keys fall back to these defaults (`settings.ts:149-166`).

## 3. Live config — defaults in force

`~/.config/herdr/worklog-plugin.json` (inspected 2026-08-09) contains **no**
`downtime*` keys — only `browseItemCount`, `showHelpText`, `autoRefresh`,
`refreshIntervalMs`, `showIcons`, `autoSync`, `syncIntervalMs`. Therefore every
pane loading this settings file runs the worker **enabled** with the defaults
above.

## 4. Dispatch-capable panes observed in the idle window

Five worklist panes — one per project worklog root on this host — each with an
active `.worklog/downtime-dispatches.log`:

| Worklog root | Log entries | Error entries | Last dispatch (UTC) |
|---|---|---|---|
| `/home/rgardler/projects/ContextHub` | 29 | 0 | 2026-08-09T13:49:30Z |
| `/home/rgardler/projects/SorraAgents` | 17 | 0 | 2026-08-09T13:05:09Z |
| `/home/rgardler/projects/Tableau-Card-Engine` | 18 | 0 | 2026-08-09T13:49:30Z |
| `/home/rgardler/projects/dev-scripts` | 15 | 0 | 2026-08-09T10:22:16Z |
| `/home/rgardler/projects/open_source_llm` | 22 | 0 | 2026-08-09T00:46:25Z |

Evidence notes:

- **Enabled:** all panes load the shared settings file with no `downtime*`
  keys → `downtimeEnabled: true` (defaults in force).
- **Not paused (no-candidate cooldown):** a paused worker stops proxy polling
  entirely. The proxy log shows continuous ~16 polls/min status polling
  through the idle window (per Map's comment on WL-0MSKUG2WW0058A7W,
  2026-08-08T23:56Z), so no pane was in the 60-min no-candidate pause.
- **No three-strike pause:** `recordError` writes to the same rolling log; all
  five logs have **zero error entries**, so no pane ever hit three consecutive
  wl CLI errors.
- **Dispatch-capable after the window:** dispatch activity resumed 2026-08-09
  (ContextHub/SorraAgents/Tableau/dev-scripts entries from 05:36Z onward),
  corroborating enabled, working workers.

## Conclusion

Every dispatch-capable pane that observed the idle window was **enabled with
default settings**: no window rules exist to constrain dispatch, no worker was
in no-candidate cooldown (polling never paused), and no three-strike pause
ever fired (zero error entries). **RCA hypothesis 4 (config/disablement) is
refuted** for these panes. The zero-dispatch night is attributed to the
proxy-side status evaluation (stale dispatch lease / stuck global
`active_query`), captured in follow-ups WL-0MSL2ZQIF006QB4Q (prefer
`local_active_query`) and WL-0MRE6JDT3004OSTF (proactive lease release) — see
the RCA WL-0MSK9TUCA00206M7.
