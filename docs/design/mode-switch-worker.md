# Mode-Switch Worker Design — Activity-Gated Proxy Mode Switching

**Work item:** WL-0MSN3FWV5008KQE9 — Herdr plugin: activity-gated proxy mode switching

**Status:** Implemented (children merged to `dev`; docs)

---

## 1. Goal

Automatically switch the llama-proxy between **fast** (cloud-backed, 3-slot
pool) and **cheap** (2-slot local-first pool) operating modes based on operator
presence and proxy idle state, without operator intervention:

- **Fast on command** — dispatching an agent-route command (`/skill:*`,
  `/intake`, `/plan`, `/prompt:`) means the operator is actively working:
  switch to fast mode immediately so cloud models are available.
- **Cheap on idle** — when the operator has been idle for a full inactivity
  window *and* the proxy itself is idle, switch to cheap mode to save cost.

## 2. Behavior

### Fast switch (fire-and-forget, fail-open)

- Trigger: any agent-route command routed through the plugin
  (`packages/herdr/src/index.ts`, inside the `route === 'agent'` branch).
- Shell shortcuts (`!!`/`!`), stdout/plain commands, and the internal
  `/downtime toggle` chord do **not** count as operator activity.
- The worker records the operator timestamp and POSTs
  `/admin/set-mode {"mode":"fast"}` — unless the last-known mode is already
  fast (dedup). Idle ticks (the only other mode refresh) do not run while the
  operator is active, so when the cached mode says fast the command path
  re-reads the actual mode via `GET /admin/mode` first: a schedule-driven flip
  to cheap can never suppress the operator's explicit fast request
  (WL-0MUWIHUL2000JEFR). A failed re-read keeps the cached mode
  (fail-closed: never switch off an unknown state).
- **Fail-open:** the POST is fire-and-forget and can never block or delay
  command dispatch — a slow or unresponsive proxy never delays the operator.

### Cheap switch (idle window + proxy idle, fail-closed)

- Trigger: on each poll tick, operator idle ≥ `modeSwitchIdleThresholdMs`
  **AND** proxy idle (reusing `evaluateIdle` from `downtime-worker.ts` with
  `requiredFreeSlots = 0`: llama-server running, no active local query, no
  model switch, no local lease).
- A busy proxy **delays** the switch — it never kills in-flight work.
- **Fail-closed:** endpoint failures, timeouts, network errors, and ambiguous
  responses yield no switch and never crash or block the plugin. A `409`
  (mode-switch restart in progress) is a no-op, retried on a later tick.

### Restart semantics

On plugin/pane restart the idle clock resets to "active now" (construction
time), so the proxy stays fast until a fresh full idle window passes
(fail-safe).

### Leader-only cheap switching + shared activity (WL-0MU6MXCZZ007ZXT9)

The mode-switch worker reuses the machine-wide downtime leader
(`DowntimeWorker.isLeader`) — there is no separate election:

- Only the leader runs the `tick()` cheap-switch logic. Non-leaders skip the
  tick entirely, so an idle pane can no longer flip the shared proxy to cheap
  while another pane is active (the flip-flop this fixed).
- Every instance (leader and non-leader alike) broadcasts its latest
  operator-command timestamp to `mode-activity.json` in the coordination
  directory (`getMachineCoordinationDir()`, the same dir as the leader lease).
- The leader's idle evaluation uses `max(localClock, sharedTimestamp)`, so the
  proxy stays fast while *any* pane has recent activity.
- The fast switch still fires on the pane that received the command
  (fail-open, idempotent) — the active pane may not be the leader.
- The leader probe is read live each tick, so a leadership handover is honoured
  on the next tick: the new leader reads the shared activity and continues
  from the correct state (no spurious switch during the election).
- **Fail-closed:** if the shared file cannot be read or written, the worker
  falls back to its local clock (never a premature cheap switch).

### Model-cooldown gate (WL-0MV5638ZS005I5XQ)

A pane blocked on provider exhaustion (the in-pane recovery loop classifies
"all providers exhausted" / "all providers unavailable" / "no provider is
available during the current scheduled time window" 503s as `SERVER_ERROR`)
sits in proxy backoff holding **no** slot, so the proxy looks idle. Without a
gate the leader would switch the shared proxy to cheap — which *adds*
concurrency (cheap has more slots than fast) during a known
provider-exhaustion window.

- Before the cheap decision, the leader reads the machine-wide cooldown
  signal (`readModelCooldowns` from `@worklog/shared/model-cooldown`, the same
  coordination dir as `mode-activity.json`). While **any** entry has
  `cooldownUntil` in the future the leader holds **fast**: no cheap POST.
- **Bounded, no latch:** the reader returns only *active* entries, so the hold
  ends exactly at `cooldownUntil` and the first tick at/after expiry resumes
  the normal decision. The worker persists no cooldown state of its own.
- **Machine-wide (AC4):** the signal lives in the coordination directory, not
  in per-root state, so a cooldown recorded for any worklog root suppresses
  the shared cheap switch.
- **Fail-closed:** an unreadable/corrupt signal (`null`) holds fast rather
  than switching on an unreadable signal, and logs the hold so it is not
  silent. A *missing* signal (nothing was ever recorded) is `[]` and does not
  suppress the switch.
- **Fast path unaffected:** `onOperatorCommand` never reads the cooldown
  signal, so a cooldown can never suppress the fast-on-command switch.

## 3. Settings (re-read every tick — apply without plugin restart)

| Setting | Default | Clamp |
|---|---|---|
| `modeSwitchEnabled` | `true` | — (disabled ⇒ no scheduler task, no-op hook) |
| `modeSwitchIdleThresholdMs` | `900000` (15 min) | floor `60000` |
| `modeSwitchPollIntervalMs` | `10000` | `[5000, 60000]` |

The proxy URL is **not** a new setting — it reuses `downtimeProxyUrl`.

## 4. Coexistence with the proxy's built-in time schedule

The plugin's switches are **manual overrides** (the admin API's native
semantics, LP-0MSMF25V9002AY1J). The proxy's time-based schedule (cheap
01:00–10:00, fast 10:00–01:00) **reclaims control at its next boundary**.
This is documented behavior, not a conflict: the plugin switches the mode
immediately when needed; the next schedule boundary reasserts the
time-based plan.

## 5. Key files

- `packages/herdr/src/mode-switch-worker.ts` — worker core (idle clock,
  leader-gated tick, shared `mode-activity.json` read/write, machine-wide
  model-cooldown gate, admin API client, clamps)
- `packages/shared/src/model-cooldown.ts` — versioned machine-wide cooldown
  contract (`readModelCooldowns` tolerant/fail-closed reader) shared with the
  TUI recovery loop
- `packages/herdr/src/mode-switch-worker.test.ts` — worker core tests
  (including the model-cooldown gate matrix)
- `packages/herdr/src/mode-switch-integration.test.ts` — wiring tests
  (settings → worker, route classification, scheduler interval constants,
  cross-root cooldown gate)
- `packages/herdr/src/settings.ts` — settings schema + validation/clamps
- `packages/herdr/src/index.ts` — agent-route hook wiring
- `packages/herdr/src/worklist.ts` — scheduler task registration