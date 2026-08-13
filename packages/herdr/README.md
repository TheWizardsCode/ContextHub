# Worklog Selection List — Herdr Plugin

A Herdr plugin that provides a keyboard-navigable work item selection list for browsing, filtering, and selecting [Worklog](https://github.com/your-org/worklog) work items from within Herdr.

## Features

- **Browse work items** — Lists work items from `wl next` in a scrollable, keyboard-navigable list. The top-level list is root-only: child work items are hidden and appear only under their parent via expand — **at any depth** (epic → feature → task and deeper): any item with children (its `childCount > 0`) can be expanded with Tab/Enter, its children fetched on demand via `wl list --parent` and shown indented at their hierarchy depth (WL-0MSQ3FH1K000MMJW). Expanded parents **stay expanded across refreshes**: each auto/manual refresh re-fetches their children in parallel with the top-level list and swaps both in atomically, so the hierarchy never momentarily collapses or flickers (WL-0MSBVBNGH002RDP5).
- **Filter by stage** — Press `f` followed by a chord key (`i`=idea, `n`=intake, `p`=plan, `r`=review, `s`=sprint back to the default view), or type `/wl <stage>` (shorthand alias or canonical stage name, e.g. `/wl intake_complete` or `/wl progress`), to filter items by stage. Stage-filtered views show every root item in the selected stage matching the stage's status rule (open items for most stages; `completed`/`in-progress`/`open` for the in_review stage) — no `browseItemCount` cap and no `wl next` selection omission (WL-0MSDT8X1V003206G, WL-0MSKCRX730052IIW)
- **View details** — Press Enter on any item to see its full details (description, acceptance criteria, metadata, tags, priority, GitHub issue number, and audit status information such as audit result, review status, and last audit timestamp)
- **Audit indicators** — The list view shows audit icons next to `in_review` items (✅ audited, ❌ failed, ❓ unaudited). The detail view metadata section additionally shows the review status (❌ needs review / ✅ reviewed) and the last audit timestamp.
- **Chord shortcuts** — Multi-key chord sequences provide quick actions like updating priorities, stage/status, title, closing/deleting items, running workflows, and toggling review status (configurable via `shortcuts.json`)
- **Command output** — When a chord resolves to a non-`/wl` command (e.g., `!!wl update <id> --priority high`), the resolved command is executed **visibly in a new herdr pane** (see `scripts/run-in-pane.sh`) so the user sees the command line and its output; the wrapper keeps the pane's process alive so the pane stays open for inspection — dismiss it with Enter or close it with `prefix+x`
- **Command input form** — When a chord command contains unknown `<identifier>` placeholders (e.g. `!!wl update <id> --status <status> --stage <stage>`), the plugin shows a modal input form so you can fill in the values before the command runs. Known identifiers like `<id>` are still auto-substituted with the selected item's ID. The form is a full-pane page (no border/centering) that wraps text at the pane width and grows downward as content is entered. See [Command input form](#command-input-form).
- **Keyboard navigation** — Arrow keys or j/k to navigate (wraps at list boundaries), Page Up/Down, g/G for first/last, Enter to select, Escape to go back
- **Pi agent pane dispatch** — Agent commands (`/skill:*`, `/intake`, `/plan`) are automatically dispatched to a new pi agent pane opened to the right, where pi receives the command as its initial prompt. Free-form prompts use the `/prompt:` prefix: the routing prefix is stripped so pi receives only the prompt text.
- **Agent status tracking** — When an agent command carrying a work-item ID is dispatched, the worklist records which pi agent pane is attached to that item (persisted to the gitignored `.worklog/agent-panes.json`, shared across worklist panes). The list shows a live agent-status icon at the start of each row's icon prefix: 🟢 working, ⛔ blocked, ⚪ idle. Done/closed items (and items without an agent) show no icon. The icon is a fixed-width slot so the item-ID column never shifts. See [Agent status icons](#agent-status-icons).
- **Open Pi Agent action** — The plugin provides an action to open a fresh interactive pi session pane
- **Tab-based opening** — The worklist opens in a new tab in the current workspace, providing full-screen access without reducing space for existing panes
- **Podcast Editing tab** — The `open-podcast-editor-tab` action (bound to `prefix+l`) opens the worklist pane in a new tab and renames that tab to **`Podcast Editing`** so it is instantly recognisable in the tab row during podcast production. See [Podcast Editing tab](#podcast-editing-tab).
- **Quit** — Press `q` to exit
- **Metadata panel** — The bottom portion of the list view (roughly 20–40% of the pane height, responsive to terminal size) is reserved for the selected item's metadata: ID, title, status, stage, priority, type, risk, effort, tags, audit info, and more, plus a **description preview** (first up-to-3 lines of the item's description) so you can see what an item is about at a glance. The panel scrolls independently with `m`/`M` (down/up) so long metadata never affects list navigation. See [Metadata panel](#metadata-panel).
- **Command log** — Every plugin-dispatched command that targets a work item (via `<id>` substitution or an explicit item ID) is recorded to a local JSON log. For `in_progress` items the panel shows the **last command** at the bottom, so you can see exactly what was last dispatched against the item. See [Command log](#command-log).
- **Stage grouping** — Work items are grouped by their Worklog stage (standard lifecycle stages only: `idea`, `intake_complete`, `plan_complete`, `in_progress`, `in_review`, `done` — no custom stage values). Podcast episode items group exactly as their frontmatter stages map 1:1 (PRD §7.2). See [Stage grouping](#stage-grouping).
- **Generic md viewer** — When a work item's description carries a `Key Files:` path to a markdown document (e.g. a podcast episode `.podcast.md`), the detail view renders the file with a generic markdown viewer (frontmatter skipped, full GFM rendering: headings, lists, tables, blockquotes, code, links) as a preview. The description section is rendered with the same markdown renderer. A persistent **Related Docs** table of contents at the top of the detail view lists every `.md` Key File (`↑↓/j:k` to navigate, `Enter` to open in the viewer), and the metadata panel shows a display-only `Related Docs` row. See [Markdown viewer](#markdown-viewer).
- **Inline note links** — Inline `[NOTE <id>: ...]` markers (PRD §7.1) render as clickable links to the note work items: the marker is displayed as `<id>↗`, and the note text is never shown in the viewer. See [Inline note links](#inline-note-links).
- **Code Freeze awareness** — While a ship-it release is in progress the project is in *Code Freeze*: the worklist shows a prominent banner and blocks all implement commands (`/skill:implement*`) with a notice dialog until the release finishes. See [Code Freeze](#code-freeze).

## Requirements

- [Herdr](https://herdr.dev) v0.7.0 or later
- [Worklog CLI (`wl`)](https://github.com/your-org/worklog) installed and on PATH

## Installation

### From source (development)

```bash
# Clone the repository
cd /path/to/worklog-repo

# Build the repo — the postbuild hook automatically links the herdr plugin
# and registers the prefix+l keybinding (idempotent; safe to re-run)
npm run build

# Build the plugin (also triggered by herdr's own [[build]] step)
cd packages/herdr && npm run build
```

`npm run build` runs `scripts/install-herdr.sh` via the root `postbuild` hook. The script:

- Links the plugin with `herdr plugin link packages/herdr/herdr-plugin.toml` (a no-op when already linked).
- Inserts the `prefix+l` → `worklog-selection-list.open-podcast-editor-tab` keybinding into your herdr config (`~/.config/herdr/config.toml`, or `$HERDR_CONFIG_PATH` when set) **only if** it is not already present — re-running the build never creates duplicate keybindings.
- Migrates a legacy `prefix+l` → `worklog-selection-list.open-worklist` binding in-place to the new action, so the Podcast Editing tab name takes effect without a manual config edit.
- Warns (without failing the build) when `herdr` is not on PATH or the config cannot be written, so `npm run build` succeeds in CI/offline environments.

Manual install (fallback, if you prefer not to run the build):

```bash
# Link the plugin in Herdr
herdr plugin link packages/herdr/herdr-plugin.toml

# Add the keybinding to ~/.config/herdr/config.toml if not already present
# [[keys.command]]
# key = "prefix+l"
# command = "herdr plugin action invoke worklog-selection-list.open-podcast-editor-tab"
# description = "Open the Podcast Editing tab (Worklog work item selection pane)."
```

The plugin pane will then be available via the Herdr plugin system.

## Usage

### From the Herdr UI

1. Open the worklist pane:
   - Press `prefix+l` to open the Podcast Editing tab (worklist pane in a new tab named `Podcast Editing`)
   - Right-click in any pane → Plugins → Worklog Selection List → Open worklist
   - Or use the Herdr command palette: `herdr plugin action run worklog-selection-list open-worklist`

2. Navigate the list:
   - `↑`/`k` — Move up (wraps to last item when at top)
   - `↓`/`j` — Move down (wraps to first item when at bottom)
   - `PgUp` — Page up
   - `PgDn` — Page down
   - `g` — Go to first item
   - `G` — Go to last item (last visible item in expanded hierarchy)
   - `Enter` — View item details, or expand a parent item with children (at any depth)
   - `Tab` — Toggle expand/collapse a parent item with children (at any depth)
   - `Escape` — Go back (from detail or filter mode); in a child list, return to the parent level at the previous scroll position. When inside a child list the footer shows a `[esc] back` hint (with `(N levels)` when nested deeper than one level).

3. Filter by stage using chord shortcuts (or type `/wl <stage>`):
   - Press `f` then `i` — Filter to idea-stage items
   - Press `f` then `n` — Filter to intake_complete items
   - Press `f` then `p` — Filter to plan_complete items
   - Press `f` then `r` — Filter to in_review items
   - Press `f` then `s` (sprint) — Return to the default unfiltered browse list
   - `/wl <stage>` accepts shorthand aliases (`idea`, `intake`, `plan`, `progress`, `review`) and canonical stage names (`intake_complete`, `plan_complete`, `in_progress`, `in_review`)
   - `/wl` with no stage argument returns to the default unfiltered browse list
   - Filtered views show every root item in the selected stage matching the stage's status rule (see [Selection List Behaviour](#selection-list-behaviour))
   - Press `Escape` to cancel an incomplete chord

4. Workflow shortcuts (single-key):
   - Press `c` — Create a new work item
   - Press `i` — Run the implement workflow on the selected item (intake_complete, plan_complete, in_progress)
   - Press `n` — Run the intake workflow on the selected item (idea stage)
   - Press `p` — Run the plan workflow on the selected item (intake_complete stage)
   - Press `s` — Insert a search command
   - Press `S` (Shift+s) — **Ship It**: run the dev→main release. A typed-confirmation dialog anchored to the bottom of the list (the list stays visible above it) asks you to type `ship` (case-insensitive) and press Enter to dispatch `/skill:ship release`; Esc cancels. The release is a global command — no work item id is involved. `S` is distinct from lowercase `s` (Search). See [Ship It confirmation dialog](#ship-it-confirmation-dialog).

5. Producer review shortcut:
   - Press `r` — Toggle 'Needs Producer Review' flag and add a comment to the selected item

6. Priority update chords (press `u` then `p` then a priority key):
   - Press `u`, `p`, `l` — Set priority to low
   - Press `u`, `p`, `m` — Set priority to medium
   - Press `u`, `p`, `h` — Set priority to high
   - Press `u`, `p`, `c` — Set priority to critical

7. Other update chords (press `u` then a key):
   - Press `u`, `s` — Insert an update stage/status template
   - Press `u`, `t` — Insert an update title template

8. Close/delete chords (press `x` then a key):
   - Press `x`, `c` — Close the selected item
   - Press `x`, `d` — Delete the selected item

9. Audit chords (in_review stage only, press `a` then a key):
   - Press `a`, `a` — Run automatic audit on the selected item
   - Press `a`, `y` — Approve the selected item (mark ready to close)
   - Press `a`, `r` — Reject the selected item (mark not ready to close)

10. Quit:
   - Press `q` to close the worklist pane

### Agent status icons

Rows that have a worklist-spawned pi agent pane attached show the agent's live status as the first icon in the row's icon prefix:

| Icon | Meaning |
|------|---------|
| 🟢 | Agent is working on the item |
| ⛔ | Agent is blocked |
| ⚪ | Agent is idle (spawned but not currently active) |
| *(none)* | No agent attached, or the agent finished (`done`/closed) |

The icon occupies a fixed-width slot, so the remaining icons and the item-ID column stay perfectly aligned whether or not a row has an agent. State is refreshed from the herdr CLI on each worklist refresh (with a short TTL); if the CLI is unavailable the list renders without icons rather than failing.
### From the command line

```bash
# Direct invocation (opens in a new tab)
herdr plugin action run worklog-selection-list open-worklist

# Open the Podcast Editing tab (worklist pane renamed to "Podcast Editing")
herdr plugin action run worklog-selection-list open-podcast-editor-tab
```

### Podcast Editing tab

`herdr plugin pane open` has no tab-title option, so a worklist pane opened in a tab gets a generated numeric label. The `open-podcast-editor-tab` action (bound to `prefix+l`) fixes that: it opens the worklist pane in a new tab exactly like `open-worklist` (same flags and working-directory resolution) and then renames the created tab to **`Podcast Editing`** via `herdr tab rename`, so the podcast production tab is instantly recognisable among several open tabs. Each press opens a new tab — there is deliberately no focus-if-open toggle.

The underlying script (`scripts/open-podcast-editor-tab.sh`) fails fast with a clear error and non-zero exit when the herdr CLI is unavailable, the pane open fails, or the created `tab_id` cannot be parsed — a missing rename is never silently skipped. The tab label can be overridden with the `TAB_LABEL` environment variable.

### Configuration

The plugin respects the following environment variables:

- `WL_COUNT` — Number of work items to fetch (default: 20, now superseded by `browseItemCount` in settings)

#### Plugin Settings (config file)

Settings are persisted in `~/.config/herdr/worklog-plugin.json`. Key settings include:

- `autoRefresh` — Enable periodic auto-refresh of the work item list (default: `true`)
- `refreshIntervalMs` — Interval in ms between auto-refreshes (default: `30000`). Refresh cycles are single-flight: a tick that fires while the previous refresh is still awaiting its `wl` calls is skipped (no overlapping refresh cycles / wl spawn bursts from a pane), and the cadence resumes on the next tick (WL-0MSBVYBMD004007C). Each refresh is **atomic with respect to expanded state**: children of expanded parents are re-fetched in parallel with the top-level list and applied in one synchronous swap, so an expanded hierarchy never momentarily collapses mid-refresh (WL-0MSBVBNGH002RDP5).
- `autoSync` — Enable periodic background `wl sync` before auto-refreshes (default: `true`). Background syncs use a single-flight in-process guard and pass `wl sync --if-idle`, so overlapping syncs (from this pane or other panes/TUI instances) are skipped instead of piling up — preventing wl sync lock storms (WL-0MSAB7ZUC004SK7E).
- `syncIntervalMs` — Interval in ms between background `wl sync` calls (default: `60000`, minimum: `60000`; set to `0` to disable auto-sync)
- `browseItemCount` — Max number of non-mandatory items to show in the list (default: `20`, range `1`–`50`; critical and completed/in_review items are always shown regardless)
- `showHelpText` — Show the shortcut hint line at the bottom of the list (default: `true`). When `false`, **all** shortcut hint lines are hidden — including the chord-in-progress footer (`chord: <keys> _ <hints>`) — consistent with the pi browse widget (WL-0MSGJDSMJ004128E). Chord key *handling* still works while hints are hidden; only rendering is affected. Changes apply on the next render without a plugin restart
- `showIcons` — Toggle icons in the list (default: `true`); changes apply on the next render without a plugin restart

### Downtime worker (local-LLM idle dispatch)

When the local LLM (llama-server behind the llama-proxy) is idle, the plugin
can use that compute to advance the worklog backlog automatically: after the
proxy reports idle continuously for the configured threshold, it opens a
visible (non-focus-stealing) pi agent pane. Dispatch priority
(WL-0MSI8H3HP000K0RG, WL-0MSMAYPQP001FLR6):
first a completed/in_review item **without a valid audit** → `/skill:audit
<id>`; else the highest-priority open `plan_complete` item with risk `Low`
and effort `Small`/`Extra Small` → `/skill:implement <id>`; else
`/skill:plan` on the next `intake_complete` item; else falls back
to `/skill:intake` on the next `idea` item (parent WL-0MSF49FMW009M06K).

A "valid" audit is defined by the review-icon freshness rule: the audit is
current — i.e. the review icon is **neither** the hourglass `⏳` (stale passed)
**nor** the magnifying glass `🔍` (no audit / stale failed). Concretely,
`isAuditFresh(auditedAt, updatedAt)` returns `true` (auditedAt within the 60s
staleness buffer of updatedAt); missing audit timestamps are treated as
not-fresh and therefore selected.

Settings (all re-read each poll, so changes apply without a plugin restart):

- `downtimeEnabled` — Enable the downtime worker (default: `true`)
- `downtimeIdleThresholdMs` — Minimum continuous idle duration before a
dispatch (default: `240000` = 4 minutes, floor 1s)
- `downtimeRequiredFreeSlots` — Required free slots; `0` means **all** slots
must be free (default). A positive integer N is accepted; with per-slot
identity data the worker requires the **same N slots** continuously free (see
per-slot idle tracking below) for `0 < N < total`; without per-slot data it
fails closed to all-slots-free for `0 < N < total` (never any-N dispatch);
`N > total` never dispatches.
- `downtimePollIntervalMs` — Poll interval for the proxy status endpoint
(default: `30000`, hard floor `10000`)
- `downtimeProxyUrl` — Base URL of the llama-proxy (default:
`http://192.168.0.199:8000`)
- `downtimeModel` — pi model pattern for dispatched panes (default: `plan`)
- `downtimeNoCandidateCooldownMs` — Full pause (no proxy polling, no idle
  tracking, no dispatch) after the worker finds no candidate in either
  stage — a genuine empty backlog (default: `3600000` = 60 minutes, floor
  60s so the pause cannot be disabled or set trivially small)

The worker polls `GET {proxyUrl}/llama/local/status` on the poll interval.
Idle means: llama-server running, no active **local** query (when the proxy
serves `local_active_query` — preferred over the global `active_query`, so
remote-only streams with free local slots do not block dispatch; absent on
pre-fix proxies, the global `active_query` is used as the fallback), no model
switch, no active local lease, and the required free-slot condition met.
Endpoint failures, timeouts, and ambiguous responses are treated as **busy**
(no dispatch) and never crash the plugin. Each poll is single-flight with a
per-poll timeout.

**Per-slot idle tracking** (LP-0MSG5TA7Y002GN39) — when the proxy serves
per-slot detail (`slots: [{slot_id, is_processing}]`) in the status payload
AND `downtimeRequiredFreeSlots` is `0 < N < total`, the worker tracks the
idle duration of **each slot individually** and dispatches only when the
**same N slots** have each been continuously free for the full
`downtimeIdleThresholdMs` — a slot that starts processing resets only its
*own* idle timer, so transient any-N availability never counts. Any *global*
busy condition (active query, model switch, local lease, server down, or an
ambiguous/unparseable poll) resets **all** slot timers, requiring a fresh
full idle period. This assumes `slot_id` values are stable across polls
(they identify the physical slots on the llama-server). Malformed per-slot
data (non-array, missing/empty `slot_id`, non-boolean `is_processing`, or
duplicate ids) is treated as busy (fail-closed). Without per-slot data — or
when N is `0` or ≥ `total` — the worker falls back to the count-based
all-slots-free logic: N of `total` slots free never dispatches without
per-slot identity.

**Dispatch behaviour** — once idle has been continuous for the threshold, the
worker first runs `wl list --status completed --stage in_review --json` and
selects the first completed/in_review item **without** a valid audit that was
**modified within the last 7 days** (`updatedAt` recency window; a candidate
with a missing `updatedAt` is still selected — recency cannot be verified —
while an unparseable one is skipped), dispatching `/skill:audit <id>` (pane
named `Downtime audit`). The audit tier additionally applies the
**dispatched-marker exclusion** (WL-0MSLIY8ZR004QUSY): an item the downtime
worker has already dispatched for `/skill:audit` (a `kind:audit` entry in
`.worklog/downtime-dispatches.log`) is never re-selected while it still
lacks a fresh audit — closing the loop where a dispatched audit run reverts
the item to completed/in_review without recording a fresh audit. The
exclusion composes with the freshness rule: a *fresh* audit since the
dispatch still governs (fresh → not a candidate). A missing or unreadable
log is treated as empty (fail-safe), so audit dispatch keeps working on a
fresh worklog.

> **Audit-tier selection note (WL-0MSMAIP5F003WAGG):** the audit tier keeps
> its `wl list --status completed --stage in_review --json` selection rather
> than converting to `wl next --stage in_review`. `wl next` is strictly
> root-only, so converting would silently drop completed child items from
> audit dispatch (32 children in the completed/in_review queue as of the
> decision); the audit tier must audit the full completed/in_review set,
> including children. The conversion was scoped to the implement tier only
> (AC5 escape hatch — decision recorded).

If none, it runs `wl next --stage intake_complete
--json` and dispatches `/skill:plan <id>`; if no such item it runs `wl next
--stage idea --json` and dispatches `/skill:intake <id>`; if all four are
empty nothing is dispatched. A `wl`/CLI error on the `intake_complete` lookup
does **not** skip the `idea` lookup — a tier-3 candidate can still dispatch.
The item is claimed (`wl update <id> --status in_progress`) *before* the pane
spawns, so it appears in-progress immediately and a second pane's `wl next`
cannot select it. Panes are named `Downtime audit` / `Downtime implement` /
`Downtime plan` /
`Downtime intake`, opened
with `--no-focus` (visible, never steals focus), `--cwd <worklog root>` and
`--model <downtimeModel>`.

**Implement tier (WL-0MSMAYPQP001FLR6)** — after the audit tier, the worker
runs `wl next --stage plan_complete --risk low --effort small -n 10 --json`
and selects the first candidate that is `status: open` (wl next keeps
completed epics under a stage filter — the implement tier filters them out
client-side), re-verifying the risk/effort thresholds fail-closed (only risk
exactly `Low`; effort `Small`/`Extra Small`/`XS`; unset values never match),
and excluding items already dispatched for `/skill:implement` (a `kind:
implement` entry in `.worklog/downtime-dispatches.log` — AC6 dispatched-
marker exclusion, same pattern as the audit tier). Dependency-blocked items
are excluded by `wl next` itself. Dispatch is `/skill:implement <id>` (pane
named `Downtime implement`). A `wl`/CLI error or empty result at the
implement tier is fail-closed (never a candidate) and does **not**
short-circuit the plan/intake fallback (AC5/AC6).

**Empty-backlog cooldown** — when the implement, plan, and intake `wl next`
lookups genuinely return no candidate (the tab's project has nothing to
dispatch), the worker enters a full **pause** for `downtimeNoCandidateCooldownMs`
(default 60 minutes): no
proxy polling, no idle tracking, and no dispatch until the pause expires — so
it stops burning cycles (proxy polling + `wl` spawns) during empty periods.
Only a *genuine* empty backlog triggers the pause: transient `wl`/CLI errors
and the in-flight dispatch guard fail closed to busy and never start a
cooldown on their own. When the pause expires the worker resumes polling and
requires a fresh full idle period before the next dispatch (no stale idle
credit). The worker re-reads the setting every tick, so a change applies from
the next cooldown entry without a plugin restart.

**Code-freeze gate (WL-0MSQ0RPQP00636JY)** — the dispatcher honours the
ship-it code-freeze marker (see [Code Freeze](#code-freeze)): the marker is
re-read **fresh on every dispatch attempt** (never cached), so a freeze that
starts or ends mid-idle-period is honored on the next dispatch. While the
marker is **frozen or ambiguous** (fail-closed), the audit and implement tiers
are skipped — no new audits or implementation work starts during a release —
and dispatch continues with the plan/intake tiers, which are low-risk prep
work. A freeze skip is never treated as an empty backlog: it reports reason
`code-freeze` (never `no-candidate`), so it does **not** trigger the
no-candidate cooldown — polling continues and implement/audit dispatch
resumes immediately when the freeze lifts. The implement skill's own
freeze enforcement remains the backstop for the TOCTOU window between the
dispatcher's marker read and the pane spawn.

**Three-strike rule on CLI errors** — a dispatch attempt that ends in a `wl`
CLI error counts as one strike. Three **consecutive** strikes pause the
worker entirely (same full pause as the empty-backlog cooldown) *after*
logging the persistent error to the rolling downtime log, so a persistently
broken `wl` CLI stops burning idle cycles instead of retrying forever. A
successful dispatch, a genuine no-candidate outcome, or an expired pause
resets the strike counter; a single transient error never pauses on its own.

**Hang protection** — every downtime `wl` invocation (`wl next` and
`wl list` selection lookups) runs with a bounded 10s timeout, so a hung `wl`
child is killed and the lookup fails closed to a CLI-error strike within a
bounded time instead of wedging the dispatch task until a pane restart
(previously the two selection lookups had **no** timeout, so a single hang
permanently stopped downtime dispatch — silently). As a belt-and-suspenders
backstop, the scheduler also wraps each downtime-task run in a 60s watchdog:
a tick run that hangs past the bound is abandoned and the task's
single-flight flag resets, so the next scheduler tick retries. Healthy runs
complete in well under a second and are unaffected (the watchdog timer is
cleared when the run settles).

**Worklog-root routing** — the downtime worker's `wl next` selection and its
`wl comment add` audit trail run through the same `--worklog-dir` override as
the worklist, so idle dispatch picks (and comments on) items from the tab's
resolved project root (e.g. SorraAgents) rather than the plugin process's own
directory.

**Blocked-questions handling** — the dispatched prompt instructs the agent:
if it cannot proceed because it needs answers, record the questions in a
comment on the work item (`wl comment add <id> --comment ...`) and mark the
item as needing producer review (`wl update <id> --needs-producer-review
true`), then stop — it never blocks indefinitely.

**No lock file (cross-pane decision Q5)** — concurrent panes are serialized
by the idle→busy cadence (a dispatch consumes the local slot, so the proxy
reports busy and the worker requires a fresh full idle period) and by the
pre-dispatch claim, which is a **compare-and-swap** (`wl update <id>
--status in_progress --if-status <expected> [--if-stage <expected>]`, RCA
WL-0MSRBFFLN005W3VT design point 1): the transition only applies while the
item is still in the exact state the tier selected it in, so exactly one
concurrent pane wins and a losing pane aborts its dispatch (no pane, no
marker, no success record). There is deliberately **no cross-pane lock
file** — the CAS claim is the serialization point, and it is atomic at the
SQLite layer (`BEGIN IMMEDIATE`).

**Audit trail** — every successful dispatch records two traces: (1) a
comment on the dispatched item (`wl comment add`, author
`herdr-downtime`) stating the automatic dispatch, the skill run, and the
UTC timestamp — this survives `wl sync` and is the durable trail; and (2) a
bounded JSONL entry in `.worklog/downtime-dispatches.log` under the
resolved worklog root (rolling — only the most recent 100 entries are
kept). The marker is written **before** the pane spawns (fail-closed: an
unmarked item is never dispatched). The `kind:audit` entries double as the
dispatched-marker exclusion source for the audit tier (WL-0MSLIY8ZR004QUSY);
`kind:implement` entries for the implement tier; and `kind:plan` /
`kind:intake` entries (which also record the item's `stage` at dispatch)
for the plan/intake change-guard — an item already dispatched for its tier
is excluded while it is still at its dispatched-at stage, and a stage
advancement releases it (RCA WL-0MSRBFFLN005W3VT design point 3). Plan /
intake markers are scoped to their own tiers and never suppress audit
selection. A three-strike CLI-error pause additionally writes a JSONL entry
to the same rolling log (with the `at` timestamp and an error message) so
the persistent failure is auditable even though nothing was dispatched. The
`.worklog` log file is gitignored and local-only.

**Failure-path logging** — a complete account of what each dispatch outcome
leaves behind (documented for WL-0MSKUG2WW0058A7W, audit gap AC2):

| Outcome | Trace in `.worklog/downtime-dispatches.log` | Notes |
|---|---|---|
| Successful dispatch | comment on the item + JSONL entry (`kind`, `itemId`, `dispatchedAt`, `stage` for plan/intake) | the only fully-visible success outcome |
| Genuine empty backlog (no-candidate) | **none** — intentionally silent | full cooldown pause (default 60 min); worker stops polling |
| 1–2 transient wl CLI errors (strikes) | **none** — silent | one strike per `wl-error` outcome; retries on the next idle window |
| 3rd consecutive wl CLI error | `recordError` JSONL entry | three-strike pause; the only failure path that logs |
| Audit-tier wl/parse failure | **none** — silent, and **no strike** | `getNextAuditCandidate` collapses the failure to `null` like an empty tier; worker falls through to the plan tier and looks healthy — known silent path, follow-up WL-0MSLWJ2KP0002SV0 |
| Lost CAS claim race (`--if-status`/`--if-stage` stale) | **none** — and **no marker, no pane, no success record** | the dispatch ABORTS with reason `claim-failed` (neutral — another pane won); the failure is observable via the outcome and a stderr line, never silently discarded (WL-0MSLWJ310000ND0X absorbed) |
| Claim wl CLI failure (non-stale) | **none** — counts as a `wl-error` strike | dispatch aborts; three consecutive such failures pause the worker |
| Marker write failure | **none** — the item stays claimed (`in_progress`) | dispatch ABORTS **before** the pane spawns with reason `marker-write-failed` (fail-closed: an unmarked item is never dispatched; the claim still removes it from `wl next`, so no other pane selects it) |
| Pane spawn failure (`send-to-pi.sh`) | marker already written (pre-spawn) | a spawn `error` is handled (no unhandled-exception crash) and the outcome is **not** success (`spawn-failed`); the marker stands so the item is not re-dispatched (WL-0MSLWJ3I70031Z8U absorbed) |
| `recordError` write failure | **none** | fail-closed by design: logging must never crash or block the worker |

Consequence: the log's *absence* of an entry is still ambiguous (it cannot
distinguish "no candidate (paused)" from "worker disabled" or from a
lost claim race), but the code-level silent failure paths are closed: a
failed claim or spawn can no longer produce a false success record.

**Known re-dispatch gaps** (RCA WL-0MSRBFFLN005W3VT, evidence reproduced by
`packages/herdr/scripts/scan_duplicate_dispatches.py`; see
[docs/downtime-redispatch-rca-2026-08-13.md](docs/downtime-redispatch-rca-2026-08-13.md)):

These were closed by WL-0MSRDEWES0059TZN (implement RCA fix design):

- **Same-instant cross-pane race (closed)** — the pre-dispatch claim is now a
  compare-and-swap (`--if-status`/`--if-stage`) executed atomically at the
  SQLite layer, so exactly one pane wins; a losing pane aborts with no pane,
  no marker, no success record. (Formerly: selection preceded an idempotent
  claim, so two panes could both proceed — observed as a `kind:audit` pair
  14 ms apart, SA-0MSN4AXIQ007IZG2, 2026-08-10.)
- **Plan/intake tiers had no dispatched-marker exclusion (closed)** — the
  plan (`--stage intake_complete`) and intake (`--stage idea`) tiers now
  exclude items already dispatched for their tier while the item is still at
  its dispatched-at stage (kind-scoped `plan`/`intake` markers carrying the
  stage at dispatch; a stage advancement releases the item), and both tiers
  filter client-side to `status === 'open'` so a `completed`/`in_review`
  item whose stage matches is never dispatched. (Formerly: a plan run whose
  error/abort path reset status only — stage left at `intake_complete` —
  left the item selectable; observed `kind:plan` ×2 on
  SA-0MSMAZP6T007NM0O and SA-0MSN04X2S006ONH0, `kind:plan` ×7 in ~7 h
  pre-fix, SA-0MSJI53RX006E2PS.)

The remaining residual risk is the 100-entry log roll: a very long-unaudited
item can have its marker rolled out of the log, allowing one re-dispatch.

The worker runs inside the plugin's single consolidated scheduler loop (one
`setInterval`; no independent timers), uses unref'd timers, and is cleaned up
when the pane exits. While the pane is open the list header shows the worker
state, e.g. `[⏳ downtime idle 3:12]`, `[downtime busy]`,
`[⏳ downtime dispatching]`, `[downtime disabled]`, or `[downtime paused]`
(no-candidate cooldown).

### Pause-when-hidden (pane visibility gating)

When the worklist pane's tab is **hidden (not focused)**, the auto-refresh and
auto-sync timers pause so hidden panes stop spawning `wl` processes (~4–5 per
30s tick per pane). With many open panes this previously caused heavy `wl`
process churn and memory pressure (WL-0MSB1N0HB0007N6N).

- **Visibility signal** — Herdr sets `HERDR_TAB_ID` for panes it spawns; a
  hidden (non-focused) tab reports `result.tab.focused === false` from
  `herdr tab get <id>`. The plugin checks this via `visibility.ts`. Tab
  focus is the visibility signal: a pane is visible when its TAB is focused,
  regardless of which pane in the tab holds keyboard focus (so a visible
  worklist pane in a multi-pane split keeps refreshing while an adjacent
  pane holds focus).
- **Fail-open** — when visibility cannot be determined (no `HERDR_TAB_ID`
  env, herdr CLI missing/erroring, unparseable output) the pane is treated
  as visible and polling proceeds exactly as before. Standalone runs (outside
  Herdr) are unaffected.
- **Cadence unchanged when visible** — while the pane's tab is focused (or
  fail-open), auto-refresh/auto-sync keep their existing intervals (30s /
  60s defaults).
- **Header indicator** — while the pane's tab is hidden the list header
  shows `[paused — hidden]` so operators can tell gating is active; the
  indicator clears as soon as the list refreshes after the tab regains
  focus.
- **Immediate refresh on resume** — while the pane's tab is hidden a
  lightweight resume poll (2s interval, `herdr tab get` only — never `wl`)
  watches for the hidden → visible transition; the moment the tab regains
  focus the list re-fetches immediately (with a "Refreshed" notification)
  instead of waiting for the next 30s tick, then the normal cadence resumes.
- **Never gated** — manual actions (navigation, shortcut chords, the initial
  data load) work regardless of tab visibility.
- **Shared visibility check** — the `PollGate` TTL memoizer (~2s) makes the
  refresh and sync ticks in one cycle share a single `herdr tab get` call
  (≤1 visibility exec per cycle).
- **Zoom-over limitation** — a pane zoomed-over within a focused tab is
  treated as visible (tab focus is the sole signal; there is no pane-focus
  fallback) and keeps refreshing. Zoom-over detection is out of scope for
  the visibility gate (approved plan, WL-0MSJNJPRM009RM35).
- **No settings toggle** — pause-when-hidden is always on.

### Selection List Behaviour

The default (unfiltered) worklist always shows **all** critical-priority
items and **all** completed/in_review items (the producer-review queue),
regardless of the `browseItemCount` setting:

- Items with `priority=critical` are always included.
- Items with `status=completed` **and** `stage=in_review` are always included.
- The `browseItemCount` limit applies only to the remaining "other" items.
  The number of "other" slots is `browseItemCount − (critical count) −
  (completed/in_review count)`, floored at zero.
- When critical + completed/in_review items alone meet or exceed
  `browseItemCount`, all of them are shown anyway (no hard cap on the
  mandatory set) — the total may exceed the configured count.
- An item that is both critical and completed/in_review counts once
  (deduplicated) toward the total.

Example: with `browseItemCount=15`, 2 critical + 3 completed/in_review +
20 other items → the list shows 2 critical + 3 completed/in_review + the
first 10 others (15 total). If there were 20 completed/in_review items
instead of 3, all 22 mandatory items would be shown (22 > 15).

The **stage-filtered** views (press `f` + stage chord, or `/wl <stage>`) show
every root item in the selected stage matching the stage's status rule
(WL-0MSDT8X1V003206G, WL-0MSKCRX730052IIW):

- Most stages show **every open** item (`status=open`) in the stage — no
  `browseItemCount` cap and no `wl next` selection omission, so items the
  priority algorithm deprioritises are still visible. Items with status
  `blocked`, `in-progress`, or `completed` are excluded even when their
  stage matches.
- The **in_review** stage (press `f` + `r`, or `/wl review`) is the
  exception: it shows items with status `completed`, `in-progress`, or
  `open`. Per the project workflow, advancing an item to `in_review` sets
  its status to `completed` (or leaves it `in-progress` while being
  re-worked after review feedback) — restricting the filter to
  `status=open` would empty the review queue (WL-0MSKCRX730052IIW).
- Children stay hidden in the top-level list and remain reachable via
  expand (Tab), exactly as in the unfiltered view.
- Results follow the standard list order (sortIndex), matching the
  unfiltered view.

The default (unfiltered) worklist is unaffected — `/wl` with no stage
argument keeps the smart-selection behaviour described above.

The "top N of M" header reflects the **actual displayed count** (N), which
may exceed `browseItemCount` when the mandatory set is large.

## Metadata panel

The list view reserves the bottom rows of the pane for a metadata panel
showing the **selected** item's fields. The panel is always on: the list
area shrinks to `rows - 1 - panelHeight`, and `panelHeight` scales linearly
from 20% of the pane height (on short panes) up to 40% (on tall panes),
clamped to a minimum of 3 rows so it is always usable.

- The panel shows the item ID as a header separator, followed by its
  metadata (status, stage, priority, type, risk, effort, children/parent
  counts, tags, GitHub issue number, created/updated timestamps, and audit
  state).
- When the item's description has a `Key Files:` section containing one or
  more `.md` paths, the panel also shows a **`Related Docs`** row listing
  every markdown path (joined with `, `; long values are truncated to the
  pane width). Non-markdown Key Files (`.ts`, `.json`, …) are excluded, and
  the row is omitted entirely when there are no `.md` Key Files. The row is
  **display-only** — opening a document happens from the detail view's
  Related Docs table of contents (see [Markdown viewer](#markdown-viewer)).
- For items whose stage is `in_progress`, the panel additionally shows
  **`Last command:`** — the most recent command the plugin dispatched
  against that item (`none yet` until the first dispatch).
- When the item has a description, the panel shows a **`Description`**
  preview: the first up-to-3 non-empty lines of the description (markdown
  source as-is, each line truncated to the pane width), so you can see what
  an item is about without opening the detail view. Items without a
  description omit the section entirely. The preview sits between the
  metadata rows and the last-command line and scrolls with the rest of the
  panel content.
- The panel scrolls **independently** of the list: press `m` to scroll the
  panel down and `M` to scroll it up. A `[m/M scroll N%]` indicator appears
  on the last panel line whenever the content overflows. Navigating the
  list, filtering, or refreshing resets the panel scroll so the top of the
  panel is always visible again.

## Stage grouping

Work items are grouped by their Worklog **stage** using the standard
lifecycle stages only — `idea`, `intake_complete`, `plan_complete`,
`in_progress`, `in_review`, `done`. No custom stage values are required for
grouping, so podcast episode items group exactly as their frontmatter
`pipeline_stage` maps 1:1 onto the Worklog stages (PRD §7.2). Groups render
in the canonical order (Critical → Group N → Idea → Other → In Review) with
group separators in the list; stage changes re-group items on the next
refresh. Non-critical `in_progress` items join the file-path-partitioned
`Group N` lists alongside `plan_complete`/`intake_complete` items and sort
ahead of them (actively-worked items first); "Other" remains only as a
safety net for unknown/custom stages.

## Markdown viewer

When a work item's description carries a `Key Files:` path to a markdown
document (e.g. a podcast episode `.podcast.md`), the **detail view** renders
that file with a generic markdown viewer instead of showing only the raw
description. The viewer:

- skips the YAML frontmatter block;
- renders the full GFM construct set used in `.podcast.md` episode files and
  work-item descriptions: ATX heading hierarchy (`#`…`######` with distinct
  glyphs per level), ordered and nested bullet lists, blockquotes, GFM
  tables (aligned columns), fenced and inline code, bold/italic/
  strikethrough, links, horizontal rules, and paragraphs (word-wrapped to
  the terminal width);
- renders inline `[NOTE <id>: ...]` markers as `<id>↗` links (see
  [Inline note links](#inline-note-links));
- is preview-only (no notes editor);
- falls back to the raw description when the file is missing/unreadable.

The **description section** of the detail view is rendered with the same
markdown renderer, so GFM-heavy descriptions (tables, bold/italic, inline
code, links, lists) display properly instead of as raw text. Markdown is
parsed with the [`marked`](https://github.com/markedjs/marked) library (a
declared dependency of `packages/herdr`), which is also present in the pi
agent dependency tree (`@earendil-works/pi-tui`), so the compatibility is
proven.

Key Files paths are resolved against the **worklog root** (the directory
containing `.worklog/`, from `HERDR_RESOLVED_CWD` / `configureWorklogTarget`)
— never the plugin pane's process CWD, which is the plugin source dir — with
fallback candidates tried in order: the worklog root, then the legacy
podcast-relative base `<root>/.llm-wiki/wiki/podcast/` (older episode items
wrote Key Files paths relative to the podcast dir rather than the wiki root),
then `process.cwd()` as a last resort.

The rendered lines appear under an `Episode file (md viewer)` heading in the
detail view, scrollable with the usual `↑↓/j:k` keys.

### Related Docs table of contents

When the item has at least one `.md` Key File, the **top of the detail view**
shows a persistent **`Related Docs`** table of contents listing every markdown
Key File (numbered, with a focus indicator on the selected entry). This makes
all associated documents visible — not just the first one — and lets you open
any of them:

- `↑`/`↓` and `j`/`k` move the ToC selection (clamped to its bounds).
- **`Enter`** renders the selected document's content in the markdown viewer
  (replacing the auto-rendered first file for that selection; the first file
  remains the initial default).
- The ToC stays **visible on all renders**: while the viewed document scrolls,
  the ToC remains pinned at the top of the detail view.
- Navigating **past the last ToC entry** transfers focus to document
  scrolling (the usual `↑↓/j:k`, `g`/`G`, `pgup`/`pgdn` keys apply there);
  navigating **up past the top of the document** returns focus to the ToC.
- `esc`/`q` exit the detail view as usual. Items with no `.md` Key Files
  render exactly as before (no ToC).

## Inline note links

Inline `[NOTE <id>: ...]` review-note markers (PRD §7.1) — where `<id>` is
the Worklog note-child work item id — are rendered as **clickable links** to
the note work items: the marker is displayed as `<id>↗` and the note text is
never shown in the viewer (notes are internal review notes, not dialogue).
This applies to both the description section and the markdown viewer in the
detail view.

## Command log

Every command the plugin dispatches against a work item is recorded in a
local JSON log so the panel (and tools) can show what was last run against
an item. Recording is best-effort: it happens **before** the command is
executed (a downstream failure never skips the entry) and a log failure
never breaks dispatch.

- **What is recorded** — Any command routed through the plugin's dispatch
  paths (`dispatchChordCommand` / `resolveAndRouteCommand`, single-key
  shortcuts, and form submissions) that carries a work item ID, either via
  `<id>` substitution or as an explicit ID token in the command text.
- **What is not recorded** — Commands without an item ID (e.g. plain shell
  commands), commands dispatched directly through the external `wl` CLI
  outside the plugin, and failed `<id>` resolutions (no item selected).
- **Log file** — `~/.config/herdr/worklog-command-log.json`. Per item the
  log keeps the most recent `MAX_ENTRIES_PER_ITEM` (50) entries. The file
  is written atomically (temp file + rename); missing, empty, or corrupt
  JSON degrades gracefully to an empty log.

## Command input form

When a chord shortcut resolves to a command that contains **unknown identifiers** — angle-bracket placeholders other than the known `<id>` (e.g. `--status <status>`, `--stage <stage>`, `--reason <reason>`) — the plugin displays a modal form page instead of dispatching the command directly:

- One labeled input field per unknown identifier; `Tab`/`↑`/`↓` navigate between fields, `Enter` submits, `Esc` cancels.
- Identifiers may declare an inline default: `<priority default="medium">`. The field is pre-filled with the default (which is used verbatim if you submit without editing it), and you can clear it or type over it before submitting.
- The active field shows a block cursor at the end of its value; the typed value is substituted into the command on submit (`<id>` remains auto-substituted with the selected item's ID).
- The form renders as a **full-pane page layout** — no border box, no centering: content starts at the top-left corner of the pane and wraps at the full pane width.
- The description and field values **wrap at the full pane width**; as a value wraps to more lines the form **expands downward**, bounded by the terminal height so it never overflows the pane.

Rendering is ANSI-aware: visible width is measured by stripping SGR escape sequences (no external width/wrap dependencies).

## Ship It confirmation dialog

The Ship It shortcut (`S`, Shift+s) triggers a **dev→main release** via the ship skill (`/skill:ship release`), so it must never fire on a stray keypress. Pressing `S` opens a typed-confirmation dialog anchored to the **bottom** of the selection list — the list stays visible above it (no full-screen takeover, unlike the command input form and the centered Code Freeze notice):

- The dialog shows a prompt ("Ship it? Type 'ship' to confirm, Esc to cancel") and reflects your typed input with a block cursor.
- Type `ship` (case-insensitive: `ship`, `Ship`, `SHIP`, …) and press **Enter** to dispatch `/skill:ship release` via the standard command-routing path — a global release, so **no work item id** is substituted. A "Sent" toast confirms.
- Typing anything else and pressing **Enter** clears the input buffer and keeps the dialog open so you can retry — nothing is dispatched.
- **Esc** dismisses the dialog and returns to the selection list without dispatching anything.
- While the dialog is open all keys are consumed by it (modal input); navigation resumes after Esc.

Implementation: `ship-it-dialog.ts` holds the dialog state (`ShipItDialogState`), renders the box (`formatShipItDialog`), and composes it over the list output (`overlayShipItDialog` — bottom-anchored, within the pane height budget). The `S` entry in `src/shortcuts.json` is a single-key chord with `code_freeze` omitted, so it stays available during a Code Freeze (the ship skill gates itself).

> **Behavior change:** the former manual-sync `S` binding (immediate `wl sync` with a toast) was removed; background auto-sync on the timer is unchanged.

## Architecture

```
packages/herdr/
├── herdr-plugin.toml       # Herdr plugin manifest
├── README.md               # This file
├── src/
│   ├── index.ts            # Entry point — TUI main loop
│   ├── fetcher.ts          # Worklog data fetching via wl CLI
│   ├── auto-sync.ts       # Background `wl sync` with configurable timer
│   ├── shortcut-config.ts  # Chord shortcut registry and config loader
│   ├── shortcuts.json      # Shortcut/chord definitions
│   ├── icons.ts            # Icon and colour helpers
│   ├── code-freeze.ts      # Code Freeze marker detection (fail-open)
│   ├── form-dialog.ts      # Form state + rendering for parameter input (unknown <identifiers>)
│   ├── ship-it-dialog.ts   # Ship It typed-confirmation dialog (bottom-anchored, S shortcut)
│   ├── md-viewer.ts        # Generic markdown viewer + inline [NOTE <id>: ...] link rendering
│   ├── command-log.ts      # Command log: record/get last command per work item
│   ├── settings.ts         # User settings management
│   └── worklist.ts         # List state, rendering, keyboard handling, command output
├── scripts/
│   ├── open.sh             # Open the worklist pane
│   ├── open-podcast-editor-tab.sh  # Open the worklist pane in a tab renamed "Podcast Editing"
│   ├── toggle.sh           # Toggle the worklist pane
│   ├── send-to-pi.sh       # Split pane to right, launch pi with agent command
│   ├── run-in-pane.sh      # Run a shell command visibly in a new pane (stays open for inspection)
│   └── open-pi-agent.sh    # Open a fresh interactive pi agent pane
└── tests/herdr/            # Test files
```

### Design decisions

- **No direct database access** — The plugin uses the `wl` CLI as the backend data source, ensuring compatibility without duplicating data-access logic.
- **Terminal UI via raw mode** — The TUI uses raw stdin mode and ANSI escape codes for rendering, making it compatible with any Herdr pane without additional dependencies.
- **Fixed-height pane rendering** — The list renderer budgets its output to `rows - 1` lines (header + items + group separators + fill + footer), reserving the last row for the transient notification line (e.g. `[Synced]`, `[Refresh failed]`). The active stage filter is shown in the header only (` (filtered: <stage>)`) — there is no standalone filter bar or blank chrome row. Group separator lines count against the budget, so the pane never scrolls the header or top items off the top of the view regardless of item/group count (see WL-0MSAAON63003N6LO, WL-0MSGTSPXK007POB1).
- **Testable core** — All state management, formatting, and keyboard handling is pure logic in `worklist.ts`, fully testable without a terminal.
- **Toast notifications instead of bottom-line status** — Transient status feedback (refresh outcomes, sync outcomes, sent/skipped command feedback, errors) is surfaced via Herdr toast notifications (`herdr notification show`) instead of being appended to the bottom of the pane output. This keeps the rendered pane within the terminal height budget, so the list header and top lines are never pushed off the top of the pane. Toast delivery requires `ui.toast.delivery = "herdr"` in `~/.config/herdr/config.toml`; toasts appear in the bottom-right corner by default. The helper lives in `notify.ts` and is fire-and-forget (failures are tolerated silently).
- **Command routing via callback** — When a chord resolves to a non-`/wl` command, it is passed to an `onCommand` callback (set by the entry point) which routes it by prefix:
  - `!!`/`!` prefixed commands (shell-executed shortcuts such as audit approve/reject, priority updates, close/delete) are run **visibly in a new herdr pane** via `scripts/run-in-pane.sh` — the wrapper keeps the pane's process alive so the pane stays open (exit status reported; dismiss with Enter or close with `prefix+x`) so the user can inspect the command output.
  - Everything else is written to stdout with a `CMD:` prefix for the calling framework (Herdr) to execute.
- **Pi agent dispatch** — Agent commands (`/skill:*`, `/intake`, `/plan`) are intercepted by the entry point and routed to a new pi agent pane. The `send-to-pi.sh` script splits the current pane to the right, creates a new pane, runs `pi` with the command as the initial prompt, and renames the pane to "Pi Agent". Agent commands are routed before any prefix handling, so they are unaffected by `!!`/`!` processing.
- **Podcast Editing tab naming** — `herdr plugin pane open` creates tabs with generated numeric labels. The `open-podcast-editor-tab` action wraps the same pane-open command and renames the created tab to "Podcast Editing" via `herdr tab rename` (socket API, not session-state editing), so podcast production is instantly recognisable in the tab row. Each press still opens a new tab; only the label changes.
- **Model selection per shortcut** — Each LLM-bound shortcut entry in `shortcuts.json` may carry an optional `model` field (a pi model pattern such as `plan`, `code`, or `author`). When the command is dispatched to the agent channel, `--model <pattern>` is forwarded to the spawned `pi` CLI (e.g. `pi --model code '/skill:implement <id>'`), so every workflow runs on an appropriately specialised model without manual model switching. Agent-bound entries without a `model` field default to `plan`; shell (`!!`) and `/wl` filter entries never carry a model and never receive a `--model` flag. The default mapping in `src/shortcuts.json`: `/plan`, `/intake`, `/skill:audit`, `/prompt:` → `plan`; `/skill:implement` → `code`.
- **Free-form prompts via `/prompt:`** — Commands starting with `/prompt:` are also routed to the agent pane, but the `/prompt:` routing prefix is stripped before `send-to-pi.sh` runs, so pi receives only the bare prompt text (e.g. `pi "What are the audit gaps reported in the most recent audit for WL-123"`). This lets a chord shortcut open a new pi instance with an arbitrary injected prompt, not just a skill/workflow invocation. The `P-p` chord opens the command input form so you can type any free-form prompt, `P-a` opens pi with `What are the audit gaps reported in the most recent audit for <id>` (the selected item's ID is substituted automatically), and `P-n` opens a brand-new blank session (`/prompt:` with an empty prompt — no form dialog, no injected text, and no work-item association). Edit `src/shortcuts.json` to bind your own prompt text to any free chord.
- **Correct project directory for new panes** — Panes created by `send-to-pi.sh`, `open-pi-agent.sh`, and `run-in-pane.sh` are started in the correct project root. Herdr's `follow` CWD policy would otherwise inherit the source pane's CWD (the plugin directory), so each script resolves a target CWD (`--cwd` arg > `HERDR_RESOLVED_CWD` > `$PWD`) and applies it in both launch modes: `--no-resize` passes it to `herdr pane split --cwd`, and the default resize mode forwards it to `grid.py --cwd` which includes it in the `pane.split` RPC params. The entry point passes the resolved worklog root (`wlRoot`) so skills, `wl` commands, and relative paths operate on the user's project rather than the plugin's installation directory.
- **`<id>` placeholder resolution** — Before output, any `<id>` placeholders in the resolved command are replaced with the currently selected work item's ID. If no item is selected and the command requires `<id>`, the command is silently dropped (graceful no-op).
- **Parameter input form** — Chord commands containing unknown `<identifier>` placeholders open a modal input form (`form-dialog.ts`) before dispatch. The form renders as a **simple full-pane page**: no border or centering decorations, content starts at the top-left of the pane, and the description and field values wrap at the full pane width — bounded by the terminal height (see WL-0MSFZUS4Z006IRI3).
- **Chord shortcut system** — Multi-key chord sequences are defined in `shortcuts.json` and resolved via `ShortcutRegistry`. Chords can be filtered by view (list/detail), stage, and work-item issue type. Entries may carry an optional `model` field (see **Model selection per shortcut** above).
- **Project-local shortcut overrides** — A consumer project can add chords or override bundled defaults **without editing the plugin bundle** by placing a `shortcuts.json` at its **worklog root** (the project root resolved via `configureWorklogTarget`; the plugin reads `<worklog-root>/shortcuts.json` when it exists). Semantics:
  - The bundled `src/shortcuts.json` is loaded first and remains the base config; a local entry with the **same `chord` + `view`** replaces the bundled entry, while local entries with new chords are appended.
  - The merge is **deterministic and deduplicated** (dedup key = `view` + `chord`); within the local file, later entries win for the same `view`+`chord`.
  - Local entries are validated with the same rules as bundled entries: an invalid entry is **logged and skipped**, and a missing/malformed local file (bad JSON, non-array) falls back to bundled-only with an error logged — a broken local file never crashes the plugin.
  - When no worklog root is resolved (uninitialized project) or no local file exists, the registry is exactly the bundled defaults and all dispatch behaviour is unchanged.
- **Metadata panel** — The bottom of the list view is reserved for the selected item's metadata (`formatMetadataPanel` in `worklist.ts`). The panel height ramps linearly with pane height (20% → 40%, min 3 rows) via `computeMetadataPanelHeight`, and the panel scrolls independently (`m`/`M`) with a scroll indicator. Row building is shared with the detail view via `buildMetaRows`, so the two views never drift apart (see WL-0MSAYNVBY006LM9X).
- **Command log** — Dispatched commands targeting a work item are recorded in `command-log.ts` before execution; the panel surfaces the last command for `in_progress` items. Recording is fire-and-forget (never breaks dispatch) and the log file is written atomically (see WL-0MSAYNVBY006LM9X).

## Code Freeze

While a ship-it (dev → main release) process is running, the project is put into **Code Freeze**: new implementation work must not land on `dev` until the release completes. This plugin detects the freeze and enforces it client-side in the worklist.

### Marker contract (cross-repo)

The freeze state is communicated via a marker file written by the ship release process (owned by the SorraAgents ship skill — see `SA-0MSBU4OBU005WJNB`) and read by this plugin:

```
<worklog-dir>/code-freeze.json
```

Where `<worklog-dir>` is the project's `.worklog/` directory (the same directory the plugin passes to `wl --worklog-dir`). The file is JSON:

```json
{
  "active": true,
  "reason": "ship release in progress",
  "startedAt": "2026-08-02T00:00:00Z",
  "pid": 12345
}
```

Semantics:

| Marker state | Freeze status |
|---|---|
| File present with `active: true` | **ON** — implementation blocked |
| File absent | OFF |
| `active: false` | OFF |
| Corrupt / unreadable file / wrong shape (non-object, missing or non-boolean `active`) | **Ambiguous** — banner shown; the downtime dispatcher treats it as ON (fail-closed) |

Fail-open is deliberate: a broken or missing marker must never block browsing the worklist. The module exposes two reads: `isCodeFreezeActive()` / `readCodeFreezeState()` keep the fail-open semantics for browsing and shortcut blocking, while `readCodeFreezeStatus()` adds a third **ambiguous** state for fail-closed consumers (the downtime dispatcher, the ambiguous-marker banner — WL-0MSQ0RPQP00636JY).

### Plugin behaviour while frozen

- **Banner** — The selection list renders a prominent red `⛔ CODE FREEZE` banner above the header, warning that implementation is blocked. The banner respects the `rows - 1` pane-height budget (see WL-0MSAAON63003N6LO).
- **Ambiguous marker banner** — When the marker is present but cannot be trusted (unreadable file, corrupt JSON, wrong shape), the selection list renders a distinct amber `⚠ Ambiguous Codefreeze marker` banner. Browsing and all non-implement commands keep working (fail-open unchanged), but the downtime dispatcher treats the project as frozen until the marker is fixed, so the operator sees why implement/audit dispatch is disabled.
- **Implement shortcut hidden** — The `i` / `/skill:implement` shortcut in `shortcuts.json` carries `"code_freeze": "block"`, so while a freeze is active it is filtered out of the shortcut registry: it does not appear in the footer/chord help hints and pressing it does nothing (no dialog, no dispatch). See [Shortcut filtering during a freeze](#shortcut-filtering-during-a-freeze).
- **Implement commands blocked** — Any implement command (`/skill:implement`, `/skill:implement-single`, `/skill:implementall`, via single-key `i`, chord, or typed dispatch) is **not** routed: no pi agent pane is spawned, no work item is claimed, and no `<id>` substitution happens. The marker is re-read at dispatch time, so a freeze that starts between refreshes is still enforced.
- **Notice dialog** — When an implement command is attempted during a freeze, a modal dialog explains that implementation is blocked until the release finishes. Dismiss with `Esc`, `Enter`, or `q` to return to the list.
- **Downtime dispatcher freeze gate** — While the marker is frozen **or ambiguous**, the downtime worker skips its audit and implement dispatch tiers (no new audits/implementations during a release); the plan/intake tiers continue. See [Downtime worker](#downtime-worker-local-llm-idle-dispatch).
- **Other commands unaffected** — Audit, intake, plan, review, priority,
  search, and navigation continue to work normally during a freeze. The Ship
  It shortcut (`S`) also stays available during a freeze: the release
  command is NOT `code_freeze: "block"` — the ship skill gates itself, so
  the confirmation dialog still opens and the user can consciously dispatch
  the release even while a freeze is active.

### Shortcut filtering by work-item type

Each entry in `shortcuts.json` may carry an optional `work_item_types` array
limiting the shortcut to work items whose issue type is listed
(WL-0MSKH1J0R003BM2M):

| `work_item_types` value | Behaviour |
|---|---|
| `["podcast"]` | Shortcut visible only on `podcast`-typed work items |
| `["bug","docs","feature","task","chore","epic"]` | Shortcut visible only on code and docs work item types |
| omitted | Always shown (backward compatible) |

Semantics:

- The JSON key is snake_case (`work_item_types`); the parsed TS field is
  camelCase (`workItemTypes`) — matching the `code_freeze`→`codeFreeze`
  convention.
- Any non-array / empty / non-string value is logged as invalid and treated
  as omitted (always shown) — a bad value never hides or breaks a shortcut.
- When the selected item's `issueType` is not available (or the entry has no
  allowlist), behavior is exactly as before: all entries are candidates.
- The registry methods `lookupChord()`, `lookupChordEntry()`,
  `getEntriesForStage()`, `getChordByPrefix()`, `getChordByLeader()`, and
  `getChordEntries()` accept an `issueType` parameter and exclude entries
  whose allowlist misses it, so footer hints, chord hints, and dispatch
  lookups all respect the gating automatically.
- **Bundled restriction:** the code-workflow chords `n` (intake), `p` (plan),
  and `i` (implement) carry `work_item_types: ["bug","docs","feature",
  "task","chore","epic"]`, so they are hidden on non-code and non-docs types
  (e.g. `podcast`). All other bundled shortcuts (audit `a-*`, producer review
  `r`, housekeeping `u-*`/`x-*`/`c`/`s`/`P-*`/`f-*`) remain untyped and are
  available on all types. Consumer projects can add their own type-gated
  chords (e.g. a `w` chord leader → `wiki-podcast-script` for `podcast`
  items) via the project-local `shortcuts.json` mechanism above.

### Podcast-progression dispatch markers (OSL-0MSKFXM380098LFL,
OSL-0MSKVB5K6008XFOQ)

Consumer projects that produce podcasts via Worklog episode items (issue
`podcast`) can define progression chords in their project-local
`shortcuts.json` that dispatch the podcast pipeline skills. Four markers are
resolved by the worklist **at dispatch time** from the selected item's
`Key Files:` section and lifecycle context — they never fall through to the
modal input form:

| Marker | Resolution | Typical command |
|---|---|---|
| `<podcast-target>` | `w s` write-script sub-chord: stage `intake_complete` (sourced) → `--doc <first .md> --force-single`; otherwise with open editor-note children → `--rewrite <first .podcast.md>`; otherwise a belt-and-braces error is shown and nothing dispatches (never authors a duplicate) | `/skill:wiki-podcast-script <podcast-target>` |
| `<podcast-review>` | `w r` write-review sub-chord: first `.podcast.md` Key File in raw form (runs the 6 reviews with `--review`; belt-and-braces error when no script exists yet) | `/skill:wiki-podcast-script --review <podcast-review>` |
| `<podcast-both>` | `w b` write-both sub-chord: first `.podcast.md` Key File in raw form (runs reviews + rewrite in one pass with `--review-rewrite`, 7 LLM calls; belt-and-braces error when no script exists yet) | `/skill:wiki-podcast-script --review-rewrite <podcast-both>` |
| `<podcast-script>` | `t` TTS chord: first `.podcast.md` Key File, normalized to the wiki-dir-relative `podcast/...` path the TTS skill expects (errors when no script exists yet) | `/skill:wiki-tts-generate --podcast-file <podcast-script>` |

All markers require the chord entry to carry `work_item_types: ["podcast"]`
so they are only visible on podcast-typed items (see [Shortcut filtering by
work-item type](#shortcut-filtering-by-work-item-type)); the `w` sub-chords
should additionally be stage-limited to the podcast lifecycle
(`w s`: `intake_complete`, `plan_complete`, `in_review`, `done`; `w r` /
`w b`: `plan_complete`, `in_review`, `done` — the stages where a script
exists).

### Shortcut filtering during a freeze

Each entry in `shortcuts.json` may carry an optional `code_freeze` field controlling its visibility while the project is frozen (WL-0MSD81VEL009XHWA):

| `code_freeze` value | Behaviour during a freeze |
|---|---|
| `"block"` | Shortcut hidden: excluded from registry lookups and help hints; pressing its key does nothing |
| `"allow"` | Shortcut always shown, even during a freeze |
| omitted | Always shown (backward compatible) |

Any other value is logged as invalid and treated as omitted (always shown) — a bad value never hides or breaks a shortcut. The registry methods `lookupChord()`, `lookupChordEntry()`, `getEntriesForStage()`, `getChordByPrefix()`, `getChordByLeader()`, and `getChordEntries()` accept a `codeFreezeActive` parameter and exclude `"block"` entries while a freeze is active, so footer hints, chord hints, and dispatch lookups all respect the freeze automatically.

This plugin only **reads** the marker; writing/clearing it is the ship release process's job (tracked in `SA-0MSBU4OBU005WJNB`).

## Development

```bash
# Run tests
npx vitest run tests/herdr/

# Run the plugin directly (outside Herdr)
npx tsx packages/herdr/src/index.ts

# Build TypeScript
cd packages/herdr && npx tsc
```

## License

MIT — see [LICENSE](../../LICENSE) for details.
