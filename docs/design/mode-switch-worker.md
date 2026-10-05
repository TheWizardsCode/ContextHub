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
  fast (dedup; refreshed via `GET /admin/mode` per poll).
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

### Drain before switching (WL-0MUL0KO7Q003O7YJ)

When the idle window is met **and** the proxy is idle, the worker enters a
**draining** state instead of switching immediately: it waits until the active
session count has fallen to the cheap pool's budget (`freeSlots >=
DOWNTIME_AUDIT_MIN_FREE_SLOTS = 2`), then switches. In-flight work is never
killed — draining only delays the switch and blocks *new* dispatches.

While draining:

- The downtime dispatcher pauses **new** dispatches. The mode-switch worker
  exposes `getIsDraining()`; `index.ts` forwards it to the dispatcher as
  `config().drainPaused`, and `DowntimeWorker.tick()` refuses to dispatch while
  it is `true`. The poll and `onProxyIdle` hook still run every tick, so the
  mode-switch worker keeps observing the live free-slot count.
- Once the budget frees, the drain completes, the proxy switches to cheap,
  `getIsDraining()` clears, and dispatch resumes on the next idle tick.
- An operator agent-route command (`onOperatorCommand`) cancels the drain
  immediately, resets the idle clock, and keeps the proxy fast.

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
  leader-gated tick, shared `mode-activity.json` read/write, admin API
  client, clamps)
- `packages/herdr/src/mode-switch-worker.test.ts` — worker core tests
- `packages/herdr/src/mode-switch-integration.test.ts` — wiring tests
  (settings → worker, route classification, scheduler interval constants)
- `packages/herdr/src/drain-dispatch-integration.test.ts` — drain → dispatch
  integration tests (the live `getIsDraining()` → `config().drainPaused`
  wiring pauses, resumes and cancels dispatch)
- `packages/herdr/src/settings.ts` — settings schema + validation/clamps
- `packages/herdr/src/index.ts` — agent-route hook wiring
- `packages/herdr/src/worklist.ts` — scheduler task registration