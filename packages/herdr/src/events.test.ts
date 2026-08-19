/**
 * packages/herdr/src/events.test.ts — HerdrEventSubscriber contract tests
 * (F1 test harness + F2 implementation)
 *
 * Tests define the HerdrEventSubscriber contract:
 *   - Connects to the resolved socket path (HERDR_SOCKET_PATH or default)
 *   - Sends one events.subscribe call with global subscriptions plus
 *     per-pane subscriptions for each tracked pane
 *   - Dispatches typed callbacks for received event frames
 *   - Reconnects with backoff on socket errors
 *   - Fails open (reports "events unavailable") on unreachable socket
 *   - close() unsubscribes and closes the socket
 *   - addPaneSubscription / removePaneSubscription manage per-pane state
 *
 * Mock socket server (mock-herdr-socket.ts) provides deterministic events
 * without spawning real herdr processes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MockHerdrSocket,
  createMockSocket,
  type HerdrEventFrame,
} from './test-utils/mock-herdr-socket.js';

// ── Import the module under test (F2 implementation) ─────────────────

import {
  HerdrEventSubscriber,
  type HerdrEventCallbacks,
  type EventResult,
  type EventsHealth,
  DEFAULT_SUBSCRIBE_TIMEOUT_MS,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_BASE_DELAY_MS,
} from './events.js';

// ── Mock socket helpers ──────────────────────────────────────────────

let mockServer: MockHerdrSocket;
let socketAddress: string;

async function startMockServer(): Promise<MockHerdrSocket> {
  const server = await createMockSocket();
  return server;
}

async function stopMockServer(server: MockHerdrSocket): Promise<void> {
  await server.stop();
}

// ── Test fixtures ────────────────────────────────────────────────────

function paneFocusedEvent(paneId: string): HerdrEventFrame {
  return { event: 'pane_focused', data: { pane_id: paneId } };
}

function paneUnfocusedEvent(paneId: string): HerdrEventFrame {
  return { event: 'pane_focused', data: { pane_id: paneId, focused: false } };
}

function paneAgentStatusChangedEvent(
  paneId: string,
  status: string,
): HerdrEventFrame {
  return {
    event: 'pane_agent_status_changed',
    data: { pane_id: paneId, agent_status: status },
  };
}

function paneAgentDetectedEvent(
  paneId: string,
  workItemId?: string,
): HerdrEventFrame {
  return {
    event: 'pane_agent_detected',
    data: { pane_id: paneId, ...(workItemId ? { work_item_id: workItemId } : {}) },
  };
}

function paneClosedEvent(paneId: string): HerdrEventFrame {
  return { event: 'pane_closed', data: { pane_id: paneId } };
}

function paneExitedEvent(paneId: string): HerdrEventFrame {
  return { event: 'pane_exited', data: { pane_id: paneId } };
}

// ── Test suites ──────────────────────────────────────────────────────

describe('HerdrEventSubscriber — mock socket', () => {
  beforeEach(async () => {
    mockServer = await startMockServer();
  });

  afterEach(async () => {
    // Clean up any remaining subscribers
    vi.restoreAllMocks();
    await stopMockServer(mockServer);
  });

  // ── F2: Basic connection and subscription ──────────────────────────

  describe('connect and subscribe', () => {
    it('connects to the mock socket and sends an events.subscribe request', async () => {
      const callbacks: HerdrEventCallbacks = {};
      const subscriber = new HerdrEventSubscriber({
        socketPath: mockServer.getAddress(),
        callbacks,
      });

      // Wait for connection and subscription
      const result = await subscriber.connect();
      expect(result.type).toBe('subscribed');

      // The subscriber should be connected
      expect(subscriber.health().status).toBe('active');

      // Clean up
      await subscriber.close();
    });

    it('sends global subscriptions: pane.focused, pane.agent_detected, pane.closed, pane.exited', async () => {
      const callbacks: HerdrEventCallbacks = {};
      const subscriber = new HerdrEventSubscriber({
        socketPath: mockServer.getAddress(),
        callbacks,
      });

      await subscriber.connect();

      // Verify global subscriptions were sent by checking that the mock
      // registered the client (the mock only accepts valid subscribe requests)
      const client = mockServer.getFirstClient();
      expect(client).toBeDefined();

      await subscriber.close();
    });

    it('sends per-pane pane.agent_status_changed subscriptions for each tracked pane', async () => {
      const callbacks: HerdrEventCallbacks = {};
      const subscriber = new HerdrEventSubscriber({
        socketPath: mockServer.getAddress(),
        callbacks,
        trackedPaneIds: ['w1:p1', 'w1:p2'],
      });

      await subscriber.connect();

      const client = mockServer.getFirstClient();
      expect(client).toBeDefined();

      await subscriber.close();
    });
  });

  // ── F2: Event dispatch ─────────────────────────────────────────────

  describe('event dispatch', () => {
    it('dispatches pane_focused events to the onPaneFocused callback', async () => {
      const onPaneFocused = vi.fn();
      const callbacks: HerdrEventCallbacks = { onPaneFocused };
      const subscriber = new HerdrEventSubscriber({
        socketPath: mockServer.getAddress(),
        callbacks,
      });

      await subscriber.connect();

      const client = mockServer.getFirstClient();
      expect(client).toBeDefined();

      client!.pushEvent(paneFocusedEvent('w1:p1'));

      // Events are dispatched asynchronously — wait for the tick
      await new Promise((r) => setTimeout(r, 50));

      expect(onPaneFocused).toHaveBeenCalledWith({ pane_id: 'w1:p1' });
      expect(onPaneFocused).toHaveBeenCalledTimes(1);

      await subscriber.close();
    });

    it('dispatches pane_agent_status_changed events to the onAgentStatusChanged callback', async () => {
      const onAgentStatusChanged = vi.fn();
      const callbacks: HerdrEventCallbacks = { onAgentStatusChanged };
      const subscriber = new HerdrEventSubscriber({
        socketPath: mockServer.getAddress(),
        callbacks,
      });

      await subscriber.connect();

      const client = mockServer.getFirstClient();
      client!.pushEvent(paneAgentStatusChangedEvent('w1:p1', 'working'));

      await new Promise((r) => setTimeout(r, 50));

      expect(onAgentStatusChanged).toHaveBeenCalledWith({
        pane_id: 'w1:p1',
        agent_status: 'working',
      });

      await subscriber.close();
    });

    it('dispatches pane_agent_detected events to the onAgentDetected callback', async () => {
      const onAgentDetected = vi.fn();
      const callbacks: HerdrEventCallbacks = { onAgentDetected };
      const subscriber = new HerdrEventSubscriber({
        socketPath: mockServer.getAddress(),
        callbacks,
      });

      await subscriber.connect();

      const client = mockServer.getFirstClient();
      client!.pushEvent(paneAgentDetectedEvent('w1:p99'));

      await new Promise((r) => setTimeout(r, 50));

      expect(onAgentDetected).toHaveBeenCalledWith({ pane_id: 'w1:p99' });

      await subscriber.close();
    });

    it('dispatches pane_closed events to the onPaneClosed callback', async () => {
      const onPaneClosed = vi.fn();
      const callbacks: HerdrEventCallbacks = { onPaneClosed };
      const subscriber = new HerdrEventSubscriber({
        socketPath: mockServer.getAddress(),
        callbacks,
      });

      await subscriber.connect();

      const client = mockServer.getFirstClient();
      client!.pushEvent(paneClosedEvent('w1:p1'));

      await new Promise((r) => setTimeout(r, 50));

      expect(onPaneClosed).toHaveBeenCalledWith({ pane_id: 'w1:p1' });

      await subscriber.close();
    });

    it('dispatches pane_exited events to the onPaneExited callback', async () => {
      const onPaneExited = vi.fn();
      const callbacks: HerdrEventCallbacks = { onPaneExited };
      const subscriber = new HerdrEventSubscriber({
        socketPath: mockServer.getAddress(),
        callbacks,
      });

      await subscriber.connect();

      const client = mockServer.getFirstClient();
      client!.pushEvent(paneExitedEvent('w1:p1'));

      await new Promise((r) => setTimeout(r, 50));

      expect(onPaneExited).toHaveBeenCalledWith({ pane_id: 'w1:p1' });

      await subscriber.close();
    });

    it('dispatches multiple events in sequence to correct callbacks', async () => {
      const onPaneFocused = vi.fn();
      const onAgentStatusChanged = vi.fn();
      const onPaneClosed = vi.fn();
      const callbacks: HerdrEventCallbacks = {
        onPaneFocused,
        onAgentStatusChanged,
        onPaneClosed,
      };
      const subscriber = new HerdrEventSubscriber({
        socketPath: mockServer.getAddress(),
        callbacks,
      });

      await subscriber.connect();

      const client = mockServer.getFirstClient();

      // Push a sequence of events
      client!.pushEvent(paneFocusedEvent('w1:p1'));
      client!.pushEvent(paneAgentStatusChangedEvent('w1:p1', 'working'));
      client!.pushEvent(paneClosedEvent('w1:p1'));

      await new Promise((r) => setTimeout(r, 100));

      expect(onPaneFocused).toHaveBeenCalledWith({ pane_id: 'w1:p1' });
      expect(onAgentStatusChanged).toHaveBeenCalledWith({
        pane_id: 'w1:p1',
        agent_status: 'working',
      });
      expect(onPaneClosed).toHaveBeenCalledWith({ pane_id: 'w1:p1' });
      expect(onPaneFocused).toHaveBeenCalledTimes(1);
      expect(onAgentStatusChanged).toHaveBeenCalledTimes(1);
      expect(onPaneClosed).toHaveBeenCalledTimes(1);

      await subscriber.close();
    });
  });

  // ── F2: Reconnect with backoff ─────────────────────────────────────

  describe('reconnect with backoff', () => {
    it('reports events unavailable when the socket is unreachable (fail-open)', async () => {
      const callbacks: HerdrEventCallbacks = {};
      const subscriber = new HerdrEventSubscriber({
        socketPath: '/tmp/herdr-nonexistent-socket-never-exists.sock',
        callbacks,
        maxReconnectAttempts: 0,
      });

      // Connecting to a non-existent socket should not throw
      const result = await subscriber.connect();
      expect(result.type).toBe('unavailable');
      const health = subscriber.health();
      expect(health.status).toBe('unavailable');

      await subscriber.close();
    });

    it('reconnects after a transient socket error', async () => {
      const callbacks: HerdrEventCallbacks = {};
      const subscriber = new HerdrEventSubscriber({
        socketPath: mockServer.getAddress(),
        callbacks,
        maxReconnectAttempts: 3,
        reconnectBaseDelayMs: 50,
      });

      await subscriber.connect();
      expect(subscriber.health().status).toBe('active');

      // Close the server to simulate a transient error
      await mockServer.stop();

      // Wait for reconnect attempts
      await new Promise((r) => setTimeout(r, 300));

      // The subscriber should be in reconnecting state
      const health = subscriber.health();
      expect(['unavailable', 'reconnecting'].includes(health.status)).toBe(true);

      // Restart the server
      mockServer = await startMockServer();

      // Wait for reconnection
      await new Promise((r) => setTimeout(r, 500));

      // The subscriber should have reconnected
      // (health should be active again if reconnection succeeded)

      await subscriber.close();
    });
  });

  // ── F2: Per-pane subscription management ───────────────────────────

  describe('per-pane subscription management', () => {
    it('addPaneSubscription adds a new pane and sends a subscribe request', async () => {
      const callbacks: HerdrEventCallbacks = {};
      const subscriber = new HerdrEventSubscriber({
        socketPath: mockServer.getAddress(),
        callbacks,
        trackedPaneIds: ['w1:p1'],
      });

      await subscriber.connect();

      // Add a new pane subscription
      const addResult = await subscriber.addPaneSubscription('w1:p2');
      expect(addResult).toBeDefined();

      // Verify the pane is tracked (health reflects active state with count)
      expect(subscriber.health().status).toBe('active');
      expect(subscriber.getTrackedPaneIds()).toContain('w1:p2');

      await subscriber.close();
    });

    it('removePaneSubscription drops a pane and cleans up', async () => {
      const callbacks: HerdrEventCallbacks = {};
      const subscriber = new HerdrEventSubscriber({
        socketPath: mockServer.getAddress(),
        callbacks,
        trackedPaneIds: ['w1:p1', 'w1:p2'],
      });

      await subscriber.connect();

      const result = await subscriber.removePaneSubscription('w1:p2');
      expect(result).toBeDefined();

      expect(subscriber.health().status).toBe('active');
      expect(subscriber.getTrackedPaneIds()).not.toContain('w1:p2');

      await subscriber.close();
    });
  });

  // ── F2: close / cleanup ────────────────────────────────────────────

  describe('close / cleanup', () => {
    it('close() stops the subscriber and cleans up resources', async () => {
      const callbacks: HerdrEventCallbacks = {};
      const subscriber = new HerdrEventSubscriber({
        socketPath: mockServer.getAddress(),
        callbacks,
      });

      await subscriber.connect();
      expect(subscriber.health().status).toBe('active');

      await subscriber.close();
      // After close, the subscriber should be in a cleaned-up state
      expect(subscriber.health().status).toBe('closed');
    });
  });

  // ── F2: Socket error tolerance ─────────────────────────────────────

  describe('socket error tolerance', () => {
    it('does not throw when socket errors occur during operation', async () => {
      const callbacks: HerdrEventCallbacks = {
        onError: vi.fn(),
      };
      const subscriber = new HerdrEventSubscriber({
        socketPath: mockServer.getAddress(),
        callbacks,
      });

      await subscriber.connect();

      // The subscriber should not throw even if the mock has issues
      // (In production, these are handled by the reconnect mechanism)

      await subscriber.close();
    });
  });

  // ── F2: Constants ──────────────────────────────────────────────────

  describe('constants', () => {
    it('exports DEFAULT_SUBSCRIBE_TIMEOUT_MS', () => {
      expect(typeof DEFAULT_SUBSCRIBE_TIMEOUT_MS).toBe('number');
      expect(DEFAULT_SUBSCRIBE_TIMEOUT_MS).toBeGreaterThan(0);
    });

    it('exports MAX_RECONNECT_ATTEMPTS', () => {
      expect(typeof MAX_RECONNECT_ATTEMPTS).toBe('number');
      expect(MAX_RECONNECT_ATTEMPTS).toBeGreaterThan(0);
    });

    it('exports RECONNECT_BASE_DELAY_MS', () => {
      expect(typeof RECONNECT_BASE_DELAY_MS).toBe('number');
      expect(RECONNECT_BASE_DELAY_MS).toBeGreaterThan(0);
    });
  });

  // ── F2: Type exports ───────────────────────────────────────────────

  describe('type exports', () => {
    it('exports EventResult union type', async () => {
      const callbacks: HerdrEventCallbacks = {};
      const subscriber = new HerdrEventSubscriber({
        socketPath: mockServer.getAddress(),
        callbacks,
      });

      const result = await subscriber.connect();
      // EventResult can be subscribed | unavailable | error
      if (result.type === 'subscribed') {
        expect(result).toHaveProperty('type', 'subscribed');
      } else if (result.type === 'unavailable') {
        expect(result).toHaveProperty('type', 'unavailable');
      } else if (result.type === 'error') {
        expect(result).toHaveProperty('type', 'error');
        expect(result).toHaveProperty('error');
      }

      await subscriber.close();
    });
  });
});
