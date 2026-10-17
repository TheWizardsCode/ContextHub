# Herdr `events.subscribe` stream reliability (WL-0MVAS988R008PNH6)

Root cause and fix for the repeated `events.subscribe … outcome="stream_closed"`
completions (and the resulting ~10 s reconnect loop) seen in
`~/.config/herdr/herdr-server.log`, and the pane-level "refresh on focus"
behaviour it underpinned (`Refresh selection list on focus`,
`WL-0MVAS988R008PNH6`).

## Symptom

`herdr-server.log` showed `events.subscribe` requests completing with
`outcome="stream_closed"` every ~10 s (`sub-100` … `sub-115` at
2026-10-16T07:15–07:17, matching `MAX_RECONNECT_DELAY_MS = 10_000` in
`packages/herdr/src/events.ts`). Each close triggered a reconnect, so the
client's `pane_focused` events arrived only in the shrinking windows between
reconnects — pane-level focus refresh was unreliable and the list could stay
stale until the next 30 s tick.

## Diagnosis (log + live-probe evidence)

Probes against the live herdr 0.9.5 Unix socket (`~/.config/herdr/herdr.sock`,
read-only subscribe) established the server's actual contract:

1. **An idle subscription stays open indefinitely.** A single
   `events.subscribe` for `pane.focused` was held open for 40 s+ and delivered
   real `pane_focused` events with no close. There is therefore **no server
   idle-timeout** and **no keepalive requirement** — a client keepalive would
   not fix anything.
2. **The server handles exactly ONE request per connection.** Sending a second
   request frame on an established subscription socket — a second
   `events.subscribe`, a `ping`, or even `pane.list` — causes the server to
   **reset** the connection (`ConnectionResetError`, `stream_closed` in the
   log) within ~100 ms. A fresh connection is required for every request.
3. **`ping` is a fresh-connection method.** `{"method":"ping","params":{}}`
   returns `{"result":{"type":"pong","version":"0.9.5","protocol":22,
   …}}`; a second ping on the same connection is rejected/closed. It is not a
   stream-keepalive primitive.

The previous subscriber design resent `events.subscribe` **on the live
subscription socket** whenever the tracked pane set changed
(`resendSubscribeRequest`, called by `addPaneSubscription` /
`removePaneSubscription`). This directly triggered (2). Worse, the worklist's
startup `syncPaneSubscriptions` re-added panes after each reconnect (and pane
seen/closed events re-triggered resubscribes), so each reconnect was killed
again — the ratcheting ~10 s loop.

A local reproduction (`HerdrEventSubscriber` against the live socket) confirmed
the loop: after `addPaneSubscription('w1:p1')` the server reset the
connection; the client reconnected (`isConnecting=false` by then), and each
reconnect's `syncPaneSubscriptions` re-added the pane, ratcheting
`reconnectAttempts` to the 10 s cap — exactly the logged cadence.

## Fix (client-side only — no herdr app/framework changes)

`packages/herdr/src/events.ts` now keeps every subscription connection
**write-once**:

- **One request per connection.** The socket is dedicated to the stream. The
  only frame written is the single initial `events.subscribe` carrying the
  full (global + per-pane) subscription set.
- **Pane-set changes re-establish the connection.** `addPaneSubscription(s)` /
  `removePaneSubscription(s)` update `trackedPaneIds` and then run
  `restartSubscription()`, which tears down the current socket (without the
  error/reconnect path) and connects afresh with the complete set in one
  request. `subscriptionVersion` + a single-flight `restartPromise` coalesce
  batched pane changes and changes that land during an in-flight reconnect
  into one rebuild — never one connection per pane.
- **Backoff reset on success.** `markSubscribed()` resets `reconnectAttempts`
  on every successful subscribe, so a genuine stream close reconnects promptly
  at the base delay rather than ratcheting to the cap.
- **Liveness signal.** A new `onReconnected` callback fires when a stream is
  re-established after a prior loss (never for the first subscribe).
  `worklist.ts` uses `onError` to flip `eventsActive` off and re-enable the
  tab-level `resume-poll` fallback while the stream is down, and `onReconnected`
  to flip it back on and top up per-pane subscriptions.

`worklist.ts` also batches `syncPaneSubscriptions` (`addPaneSubscriptions`,
one restart) instead of one `addPaneSubscription` per pane.

## Verification

- `packages/herdr/src/events.test.ts` — `keepalive & reconnect resilience`
  suite (mock records per-client `requests`):
  - a pane-set change never sends a second request on the live socket (the
    original socket keeps exactly one frame) and is applied on a new
    connection carrying the full set;
  - a closed stream reconnects, re-subscribes with the full pane set, and
    fires `onReconnected`;
  - batched pane adds coalesce into a single reconnect;
  - a steady-state idle subscription sends no further frames (no keepalive on
    the stream).
- `packages/herdr/src/worklist-visibility.test.ts` — after a server-side
  stream close + reconnect, a `pane_focused` event for the current pane
  refreshes the list again.
- Live reproduction against the real herdr socket: with the fix,
  `addPaneSubscription` returns `subscribed` and health stays `active`
  (`paneCount` 1 → 2) with no reconnect.

## Residual limitations / notes

- Subscriptions are still scoped to the herdr **session** the client attaches
  to (unchanged).
- A subscription request naming a **nonexistent pane** is rejected by the
  server with `pane … not found` and the connection is closed; the client
  reconnects with backoff. In normal operation the tracked set comes from the
  shared `.worklog/agent-panes.json` pane set, so this is confined to a stale
  pane entry between its close and the next sync. Not a regression (the previous
  in-place resubscribe had the same behaviour); a follow-up could pre-validate
  panes before subscribing.
- If a future herdr release changes the one-request-per-connection contract,
  the probe methodology above is the way to re-verify before adjusting the
  client.
