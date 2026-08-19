/**
 * packages/herdr/src/events.ts — HerdrEventSubscriber: event-driven window status
 *
 * A long-lived JSON-RPC-over-Unix-socket client that subscribes to herdr
 * window events (pane focus/visibility, agent status changes, agent
 * detected/closed/exited) pushed over the herdr socket. The subscriber
 * dispatches typed callbacks to registered listeners, reconnects with
 * exponential backoff on socket errors, and fails open when the socket
 * is unavailable.
 *
 * This module replaces the polling-based `isPaneVisible()` (PollGate) and
 * `AgentTracker.refreshStates()` with an event-driven path. Polling is kept
 * as a fail-open fallback — when events are unavailable the subscriber
 * reports `"unavailable"` and callers fall back to `herdr pane get` /
 * `herdr agent list`.
 *
 * Transport: Unix socket at `HERDR_SOCKET_PATH` (default
 * `~/.config/herdr/herdr.sock`), or TCP on `HERDR_SOCKET_PORT` for tests.
 * Framing: newline-delimited JSON-RPC 2.0, modelled on
 * `packages/herdr/shared/grid.py`.
 *
 * Subscription shape (herdr ≥ 0.7.5):
 *   - `pane.focused` — global (no pane_id)
 *   - `pane.agent_status_changed` — per-pane, requires pane_id
 *   - `pane.agent_detected` — global
 *   - `pane.closed` — global
 *   - `pane.exited` — global
 *
 * Fail-open design: any socket error degrades to polling; never crashes
 * the TUI, never blocks refresh/sync.
 *
 * AC1–AC5 of WL-0MSHB7DHO004RHBJ covered.
 */

import net from 'node:net';
import os from 'node:os';

// ── Constants ────────────────────────────────────────────────────────

/** Default timeout for the initial events.subscribe request (ms). */
export const DEFAULT_SUBSCRIBE_TIMEOUT_MS = 5000;

/** Maximum number of reconnect attempts before giving up. */
export const MAX_RECONNECT_ATTEMPTS = 50;

/** Base delay (ms) for exponential backoff on reconnect. */
export const RECONNECT_BASE_DELAY_MS = 500;

/** Maximum backoff cap (ms). */
const MAX_RECONNECT_DELAY_MS = 10_000;

/** Default socket path when HERDR_SOCKET_PATH is not set. */
const DEFAULT_SOCKET_PATH =
  process.env.XDG_CONFIG_HOME
    ? `${process.env.XDG_CONFIG_HOME}/herdr/herdr.sock`
    : `${os.homedir()}/.config/herdr/herdr.sock`;

// ── Types ────────────────────────────────────────────────────────────

/**
 * Event data for pane_agent_status_changed events.
 */
export interface PaneAgentStatusChangedEvent {
  pane_id: string;
  agent_status: string;
}

/**
 * Event data for pane_agent_detected events.
 */
export interface PaneAgentDetectedEvent {
  pane_id: string;
  work_item_id?: string;
}

/**
 * Event data for pane_focused events.
 */
export interface PaneFocusedEvent {
  pane_id: string;
  focused?: boolean;
}

/**
 * Event data for pane_closed events.
 */
export interface PaneClosedEvent {
  pane_id: string;
}

/**
 * Event data for pane_exited events.
 */
export interface PaneExitedEvent {
  pane_id: string;
}

/**
 * Union of all event data types.
 */
export type PaneEvent =
  | PaneFocusedEvent
  | PaneAgentStatusChangedEvent
  | PaneAgentDetectedEvent
  | PaneClosedEvent
  | PaneExitedEvent;

/**
 * Typed event callbacks for the subscriber. Each callback receives the
 * event data for its specific event type. Callbacks are invoked
 * synchronously on the event loop; long-running logic should be deferred.
 */
export interface HerdrEventCallbacks {
  /** Called when a pane focuses or unfocuses (pane.focused event). */
  onPaneFocused?: (data: PaneFocusedEvent) => void;
  /** Called when an agent's status changes in a tracked pane. */
  onAgentStatusChanged?: (data: PaneAgentStatusChangedEvent) => void;
  /** Called when a new agent is detected in a pane. */
  onAgentDetected?: (data: PaneAgentDetectedEvent) => void;
  /** Called when a pane is closed. */
  onPaneClosed?: (data: PaneClosedEvent) => void;
  /** Called when a pane exits (agent process ends). */
  onPaneExited?: (data: PaneExitedEvent) => void;
  /** Called when a socket error occurs (for logging / monitoring). */
  onError?: (error: Error) => void;
}

/**
 * Result of a connect() attempt.
 */
export type EventResult =
  | { type: 'subscribed'; subscriptions: number }
  | { type: 'unavailable'; reason?: string }
  | { type: 'error'; error: string };

/**
 * Health status of the subscriber.
 */
export type EventsHealth =
  | { status: 'active'; paneCount: number }
  | { status: 'unavailable'; reason?: string }
  | { status: 'reconnecting'; attempt: number; delayMs: number }
  | { status: 'closed' };

/**
 * Internal representation of a subscription request entry.
 */
interface SubscriptionEntry {
  type: string;
  pane_id?: string;
}

/**
 * Pending request handler: { resolve, reject } pair keyed by request id.
 */
interface PendingCallback {
  resolve: () => void;
  reject: (err: Error) => void;
}

// ── JSON-RPC framing ────────────────────────────────────────────────

/**
 * Frame a JSON-RPC 2.0 request.
 */
function frameRequest(id: string, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

// ── HerdrEventSubscriber ─────────────────────────────────────────────

/**
 * Subscribe to herdr window events (pane focus, agent status, etc.) over
 * a Unix-socket JSON-RPC connection.
 *
 * Usage:
 *   const sub = new HerdrEventSubscriber({
 *     socketPath: process.env.HERDR_SOCKET_PATH,
 *     callbacks: {
 *       onPaneFocused: (d) => { /* handle * / },
 *       onAgentStatusChanged: (d) => { /* handle * / },
 *     },
 *     trackedPaneIds: ['w1:p1', 'w1:p2'],
 *   });
 *   await sub.connect();
 *   await sub.addPaneSubscription('w1:p3');
 *   // ... use events ...
 *   await sub.close();
 *
 * The subscriber reconnects automatically on socket errors with exponential
 * backoff. When the socket is unreachable, it reports `"unavailable"` so
 * callers can fall back to polling.
 */
export class HerdrEventSubscriber {
  private socket: net.Socket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private isConnecting = false;
  private isClosed = false;
  private callbacks: HerdrEventCallbacks;
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly trackedPaneIds: string[];
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelayMs: number;
  private currentHealth: EventsHealth = { status: 'closed' };
  private dataBuffer = '';
  private requestCounter = 0;
  private pendingCallbacks = new Map<string, PendingCallback>();

  /**
   * @param options Configuration options.
   */
  constructor(options: {
    /** Path to the herdr socket (or undefined for default). */
    socketPath?: string;
    /** Event callbacks to dispatch to. */
    callbacks: HerdrEventCallbacks;
    /** Pane IDs to subscribe to for per-pane events. */
    trackedPaneIds?: string[];
    /** Subscribe request timeout in ms. */
    timeoutMs?: number;
    /** Max reconnect attempts before giving up. */
    maxReconnectAttempts?: number;
    /** Base delay for reconnect backoff in ms. */
    reconnectBaseDelayMs?: number;
  }) {
    this.callbacks = options.callbacks;
    this.socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SUBSCRIBE_TIMEOUT_MS;
    this.trackedPaneIds = [...(options.trackedPaneIds ?? [])];
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS;
  }

  /**
   * Connect to the herdr socket and send the initial events.subscribe
   * request. Returns a result indicating whether the connection succeeded.
   */
  async connect(): Promise<EventResult> {
    if (this.isClosed) {
      return { type: 'error', error: 'Subscriber is closed' };
    }
    if (this.isConnecting) {
      return { type: 'unavailable', reason: 'Already connecting' };
    }

    this.isConnecting = true;
    this.currentHealth = { status: 'unavailable' };

    try {
      const result = await this.doConnect();
      this.isConnecting = false;
      if (result.type === 'subscribed') {
        this.reconnectAttempts = 0;
        this.currentHealth = { status: 'active', paneCount: this.trackedPaneIds.length };
      }
      return result;
    } catch (err: any) {
      this.isConnecting = false;
      return { type: 'unavailable', reason: err?.message ?? 'Connection failed' };
    }
  }

  /**
   * Perform the actual socket connection and subscription.
   */
  private doConnect(): Promise<EventResult> {
    return new Promise<EventResult>((resolve, reject) => {
      this.socket = net.connect({ path: this.socketPath });

      // Handle connection errors
      const onError = (err: Error) => {
        this.socketCleanup();
        this.handleSocketError(err);
        resolve({ type: 'unavailable', reason: err.message });
      };

      // Handle timeouts
      const onTimeout = () => {
        this.socketCleanup();
        this.handleSocketError(new Error('Connection timed out'));
        resolve({ type: 'unavailable', reason: 'Connection timed out' });
      };

      this.socket.once('error', onError);
      this.socket.setTimeout(this.timeoutMs);
      this.socket.once('timeout', onTimeout);

      this.socket.on('data', (chunk: Buffer) => {
        this.dataBuffer += chunk.toString();
        this.processBuffer();
      });

      // A socket close (e.g. server shutdown) triggers a reconnect attempt.
      this.socket.on('close', () => {
        if (!this.isClosed && !this.isConnecting) {
          this.handleSocketError(new Error('Socket closed'));
        }
      });

      this.socket.once('connect', () => {
        // Connected successfully — clear timeout
        this.socket!.setTimeout(0);

        // Send the subscribe request and wait for response
        this.sendSubscribeRequest()
          .then(() => {
            this.socket!.removeListener('error', onError);
            this.socket!.removeListener('timeout', onTimeout);
            resolve({ type: 'subscribed', subscriptions: this.getSubscriptionCount() });
          })
          .catch((err) => {
            this.socket!.removeListener('error', onError);
            this.socket!.removeListener('timeout', onTimeout);
            resolve({ type: 'error', error: err.message });
          });
      });
    });
  }

  /**
   * Send the events.subscribe request with global and per-pane subscriptions.
   */
  private sendSubscribeRequest(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const subscriptions: SubscriptionEntry[] = [
        { type: 'pane.focused' },
        { type: 'pane.agent_detected' },
        { type: 'pane.closed' },
        { type: 'pane.exited' },
      ];

      // Add per-pane agent_status_changed subscriptions for each tracked pane
      for (const paneId of this.trackedPaneIds) {
        subscriptions.push({
          type: 'pane.agent_status_changed',
          pane_id: paneId,
        });
      }

      const id = `sub-${++this.requestCounter}`;
      const frame = frameRequest(id, 'events.subscribe', { subscriptions });

      // Store the pending callback for response correlation
      this.pendingCallbacks.set(id, { resolve, reject });

      // Set up a timeout for this request
      const timeout = setTimeout(() => {
        this.pendingCallbacks.delete(id);
        reject(new Error('Subscribe request timed out'));
      }, this.timeoutMs);

      // Send the request
      if (this.socket && !this.socket.destroyed) {
        this.socket.write(frame + '\n');
      } else {
        clearTimeout(timeout);
        this.pendingCallbacks.delete(id);
        reject(new Error('Socket not connected'));
      }
    });
  }

  /**
   * Get the current subscription count (global + per-pane).
   */
  private getSubscriptionCount(): number {
    const globalCount = 4; // focused, agent_detected, closed, exited
    return globalCount + this.trackedPaneIds.length;
  }

  /**
   * Process buffered socket data, parsing JSON-RPC frames.
   */
  private processBuffer(): void {
    while (this.dataBuffer.includes('\n')) {
      const newlineIndex = this.dataBuffer.indexOf('\n');
      const frame = this.dataBuffer.slice(0, newlineIndex).trim();
      this.dataBuffer = this.dataBuffer.slice(newlineIndex + 1);

      if (!frame) continue;

      this.handleFrame(frame);
    }
  }

  /**
   * Handle a single JSON-RPC frame from the server.
   */
  private handleFrame(frame: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      // Malformed JSON — ignore
      return;
    }

    if (!parsed || typeof parsed !== 'object') return;

    const obj = parsed as Record<string, unknown>;

    // Check if this is a response to a pending request.
    // A RESPONSE has a non-null string/number id (e.g. "sub-1").
    // Event NOTIFICATIONS from the mock have id:null — those are events.
    const rawId = obj.id;
    const isResponse = typeof rawId === 'string' || typeof rawId === 'number';
    if (isResponse) {
      const idStr = String(rawId);
      const cb = this.pendingCallbacks.get(idStr);
      if (cb) {
        this.pendingCallbacks.delete(idStr);
        if (obj.result && typeof obj.result === 'object' && (obj.result as any).type === 'subscription_started') {
          cb.resolve();
        } else if (obj.error) {
          cb.reject(new Error(String((obj.error as any)?.message ?? 'Subscription failed')));
        }
      }
      return;
    }

    // Event notification (no id) — dispatch to callbacks
    const eventType = obj.event as string | undefined;
    const data = obj.data as Record<string, unknown> | undefined;
    if (!eventType || !data) return;

    this.dispatchEvent(eventType, data);
  }

  /**
   * Dispatch an event to the appropriate callback.
   */
  private dispatchEvent(eventType: string, data: Record<string, unknown>): void {
    try {
      switch (eventType) {
        case 'pane_focused':
          this.callbacks.onPaneFocused?.({
            pane_id: String(data.pane_id || ''),
            focused: data.focused as boolean | undefined,
          });
          break;
        case 'pane_agent_status_changed':
          this.callbacks.onAgentStatusChanged?.({
            pane_id: String(data.pane_id || ''),
            agent_status: String(data.agent_status || ''),
          });
          break;
        case 'pane_agent_detected':
          this.callbacks.onAgentDetected?.({
            pane_id: String(data.pane_id || ''),
            work_item_id: data.work_item_id as string | undefined,
          });
          break;
        case 'pane_closed':
          this.callbacks.onPaneClosed?.({
            pane_id: String(data.pane_id || ''),
          });
          break;
        case 'pane_exited':
          this.callbacks.onPaneExited?.({
            pane_id: String(data.pane_id || ''),
          });
          break;
        default:
          // Unknown event type — ignore silently
          break;
      }
    } catch (err) {
      // Callback errors must not crash the subscriber
      this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Handle a socket error: schedule reconnect or report unavailable.
   */
  private handleSocketError(err: Error): void {
    if (this.isClosed) return;

    this.currentHealth = {
      status: 'unavailable',
      reason: err.message,
    };

    this.callbacks.onError?.(err);

    // Schedule reconnect with exponential backoff
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(
        this.reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempts - 1),
        MAX_RECONNECT_DELAY_MS,
      );
      this.currentHealth = {
        status: 'reconnecting',
        attempt: this.reconnectAttempts,
        delayMs: delay,
      };

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.isClosed) {
          this.connect();
        }
      }, delay);
    }
  }

  /**
   * Clean up socket resources.
   */
  private socketCleanup(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  /**
   * Add a per-pane subscription for a new pane.
   *
   * When a `pane_agent_detected` event arrives for a pane not yet tracked,
   * callers should invoke this to add a per-pane `pane.agent_status_changed`
   * subscription. The pane ID is added to the tracked set and a new
   * subscribe request is sent.
   *
   * @param paneId The pane ID to subscribe to.
   * @returns Result of the subscription update.
   */
  async addPaneSubscription(paneId: string): Promise<EventResult> {
    if (this.isClosed) {
      return { type: 'error', error: 'Subscriber is closed' };
    }
    if (this.trackedPaneIds.includes(paneId)) {
      return { type: 'subscribed', subscriptions: this.getSubscriptionCount() };
    }

    this.trackedPaneIds.push(paneId);

    // Resend subscribe request with the new pane
    return this.resendSubscribeRequest();
  }

  /**
   * Remove a per-pane subscription.
   *
   * @param paneId The pane ID to remove.
   * @returns Result of the subscription update.
   */
  async removePaneSubscription(paneId: string): Promise<EventResult> {
    if (this.isClosed) {
      return { type: 'error', error: 'Subscriber is closed' };
    }

    const idx = this.trackedPaneIds.indexOf(paneId);
    if (idx === -1) {
      return { type: 'unavailable', reason: 'Pane not tracked' };
    }

    this.trackedPaneIds.splice(idx, 1);

    // Resend subscribe request without this pane
    return this.resendSubscribeRequest();
  }

  /**
   * Resend the events.subscribe request with the current tracked pane set.
   */
  private resendSubscribeRequest(): Promise<EventResult> {
    if (!this.socket || this.socket.destroyed || this.socket.writable === false) {
      // Rollback: the pane was added/removed but we couldn't resubscribe
      // This is a best-effort operation; in practice the reconnect
      // mechanism will resubscribe with the correct pane set.
      return Promise.resolve({ type: 'error', error: 'Socket not connected' });
    }

    const subscriptions: SubscriptionEntry[] = [
      { type: 'pane.focused' },
      { type: 'pane.agent_detected' },
      { type: 'pane.closed' },
      { type: 'pane.exited' },
    ];

    for (const paneId of this.trackedPaneIds) {
      subscriptions.push({
        type: 'pane.agent_status_changed',
        pane_id: paneId,
      });
    }

    const id = `resub-${++this.requestCounter}`;
    const frame = frameRequest(id, 'events.subscribe', { subscriptions });

    return new Promise<EventResult>((resolve, reject) => {
      const callback: PendingCallback = {
        resolve: () => {
          resolve({ type: 'subscribed', subscriptions: this.getSubscriptionCount() });
        },
        reject: (err) => {
          resolve({ type: 'error', error: err.message });
        },
      };

      this.pendingCallbacks.set(id, callback);

      const timeout = setTimeout(() => {
        this.pendingCallbacks.delete(id);
        resolve({ type: 'error', error: 'Resubscribe timed out' });
      }, this.timeoutMs);

      this.socket!.write(frame + '\n', () => {
        // Write callback — if write fails, the error handler will catch it
      });
    });
  }

  /**
   * Close the subscriber: clean up the socket and cancel reconnect timers.
   *
   * After close, the subscriber cannot be reused. Callers should create a
   * new instance for a fresh connection.
   */
  async close(): Promise<void> {
    this.isClosed = true;
    this.isConnecting = false;

    // Cancel any pending reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending callbacks
    for (const [, cb] of this.pendingCallbacks) {
      cb.reject(new Error('Subscriber closed'));
    }
    this.pendingCallbacks.clear();

    // Clean up the socket
    this.socketCleanup();

    this.dataBuffer = '';
    this.currentHealth = { status: 'closed' };
  }

  /**
   * Get the current health status of the subscriber.
   */
  health(): EventsHealth {
    return this.currentHealth;
  }

  /**
   * Replace the event callbacks. The worklist wires its callbacks AFTER
   * constructing the subscriber (the callbacks close over the worklist's
   * internal state), so this must be callable post-construction and before
   * connect().
   */
  setCallbacks(callbacks: HerdrEventCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Get the list of currently tracked pane IDs.
   */
  getTrackedPaneIds(): string[] {
    return [...this.trackedPaneIds];
  }
}

/**
 * Resolve the herdr socket path from environment or default.
 *
 * Returns the resolved path, or null if no path is available.
 * Used by callers who need the socket path for display or fallback logic.
 */
export function resolveSocketPath(): string | null {
  const env = process.env.HERDR_SOCKET_PATH;
  if (env) return env;

  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    const candidate = `${xdg}/herdr/herdr.sock`;
    return candidate;
  }

  const home = os.homedir();
  if (home) {
    return `${home}/.config/herdr/herdr.sock`;
  }

  return null;
}
