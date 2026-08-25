/**
 * packages/herdr/src/test-utils/mock-herdr-socket.ts — Mock herdr Unix-socket
 * server for testing the event subscriber (F1 test harness).
 *
 * Provides a reusable in-memory herdr socket server (newline-delimited
 * JSON-RPC) that accepts `events.subscribe` with the documented subscription
 * shape and replies `{ "result": { "type": "subscription_started" } }`.
 * Tests can then push scripted `{ "data": { ... }, "event": "..." }` frames
 * to the connected client to simulate real herdr event streams.
 *
 * The mock uses a real Unix socket when HERDR_SOCKET_PORT is not set
 * (matching production behaviour), or a TCP socket on 127.0.0.1 when
 * HERDR_SOCKET_PORT is set (for environments where Unix sockets are not
 * available — rare in tests but useful on some CI hosts).
 */

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ── Types ────────────────────────────────────────────────────────────

/** A single pushed event frame from herdr (matches the live protocol). */
export interface HerdrEventFrame {
  /** Event type: "pane_focused", "pane_agent_status_changed", etc. */
  event: string;
  /** Event payload — shape varies by event type. */
  data: Record<string, unknown>;
}

/**
 * Request params for `events.subscribe` as the live herdr server expects them.
 * Each subscription is either global (no pane_id) or per-pane.
 */
export interface SubscriptionRequest {
  subscriptions: Array<{ type: string; pane_id?: string }>;
}

/**
 * A connected client socket, with helpers for pushing events.
 */
export interface MockClient {
  /** Write a raw JSON-RPC frame (newline-delimited) to the client. */
  sendFrame(frame: string): void;
  /** Push a single event frame in the herdr push format. */
  pushEvent(event: HerdrEventFrame): void;
  /** Push a batch of event frames. */
  pushEvents(events: HerdrEventFrame[]): void;
  /** Close the client connection. */
  close(): void;
}

/**
 * Mock herdr socket server. Creates a real socket, handles JSON-RPC framing,
 * and exposes a method for tests to push events to connected clients.
 */
export class MockHerdrSocket {
  private server: net.Server | null = null;
  private clients = new Set<MockClient>();
  private port: number | null = null;
  private socketPath: string | null = null;

  /**
   * Create and start the mock server.
   *
   * When HERDR_SOCKET_PORT is set, uses a TCP socket on 127.0.0.1;
   * otherwise creates a temp Unix socket in /tmp.
   *
   * @returns The resolved address (TCP host:port or Unix socket path).
   */
  async start(): Promise<string> {
    const portEnv = process.env.HERDR_SOCKET_PORT;

    if (portEnv) {
      // TCP mode: port specified by environment
      this.port = parseInt(portEnv, 10);
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });
      await new Promise<void>((resolve, reject) => {
        this.server!.listen({ port: this.port, host: '127.0.0.1' }, () => resolve());
        this.server!.on('error', reject);
      });
      return `127.0.0.1:${this.port}`;
    }

    // Unix socket mode: temp path in the system temp directory
    this.socketPath = path.join(os.tmpdir(), `herdr-mock-${process.pid}-${Date.now()}.sock`);

    // Clean up stale socket files
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // File doesn't exist — fine
    }

    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.socketPath, () => resolve());
      this.server!.on('error', reject);
    });

    return this.socketPath;
  }

  /**
   * Handle a new client connection: parse JSON-RPC frames and respond.
   */
  private handleConnection(socket: net.Socket): void {
    let buffer = '';

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      // Process complete newline-delimited frames
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const frame = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!frame) continue;

        let request: unknown;
        try {
          request = JSON.parse(frame);
        } catch {
          // Malformed frame — ignore
          continue;
        }

        if (!this.isSubscribeRequest(request)) {
          // Not an events.subscribe request — send an error
          this.sendToClient(socket, {
            jsonrpc: '2.0',
            id: this.extractId(request),
            error: { code: -32601, message: 'Method not found' },
          });
          continue;
        }

        // Accept the subscription and send back subscription_started
        this.sendToClient(socket, {
          jsonrpc: '2.0',
          id: this.extractId(request),
          result: { type: 'subscription_started' },
        });

        // Register this socket as a connected client
        const client: MockClient = {
          sendFrame: (f: string) => {
            socket.write(f + '\n');
          },
          pushEvent: (e: HerdrEventFrame) => {
            this.sendToClient(socket, {
              jsonrpc: '2.0',
              id: null,
              notification: true,
              data: e.data,
              event: e.event,
            });
          },
          pushEvents: (events: HerdrEventFrame[]) => {
            for (const e of events) {
              socket.write(JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                notification: true,
                data: e.data,
                event: e.event,
              }) + '\n');
            }
          },
          close: () => {
            socket.end();
          },
        };
        this.clients.add(client);

        socket.on('close', () => {
          this.clients.delete(client);
        });
      }
    });

    socket.on('error', () => {
      // Socket error — will be cleaned up by close
    });
  }

  /**
   * Send a JSON-RPC frame (newline-delimited) to a specific socket.
   */
  private sendToClient(socket: net.Socket, obj: Record<string, unknown>): void {
    const frame = JSON.stringify(obj);
    socket.write(frame + '\n');
  }

  /**
   * Check if a request is an events.subscribe call.
   */
  private isSubscribeRequest(request: unknown): boolean {
    if (!request || typeof request !== 'object') return false;
    const r = request as Record<string, unknown>;
    return r.method === 'events.subscribe';
  }

  /**
   * Extract the request id for response correlation.
   */
  private extractId(request: unknown): string | null {
    if (!request || typeof request !== 'object') return null;
    const r = request as Record<string, unknown>;
    return typeof r.id === 'string' ? r.id : null;
  }

  /**
   * Get all currently connected clients.
   */
  getConnectedClients(): MockClient[] {
    return [...this.clients];
  }

  /**
   * Get the first connected client (convenience for single-client tests).
   */
  getFirstClient(): MockClient | undefined {
    return this.clients.values().next().value;
  }

  /**
   * Stop the mock server and clean up.
   */
  async stop(): Promise<void> {
    // Close all client connections
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();

    // Close the server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    // Clean up the Unix socket file
    if (this.socketPath) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        // Socket file may already be removed
      }
      this.socketPath = null;
    }
  }

  /**
   * Get the socket path or host:port for this mock server.
   */
  getAddress(): string {
    if (this.socketPath) return this.socketPath;
    if (this.port) return `127.0.0.1:${this.port}`;
    throw new Error('Mock server not started');
  }
}

/**
 * Create a mock herdr socket server with convenience helpers.
 *
 * Usage:
 *   const mock = await createMockSocket();
 *   const client = mock.getFirstClient();
 *   client.pushEvent({ event: "pane_focused", data: { pane_id: "w1:p1" } });
 *   await mock.stop();
 */
export async function createMockSocket(): Promise<MockHerdrSocket> {
  const mock = new MockHerdrSocket();
  await mock.start();
  return mock;
}
