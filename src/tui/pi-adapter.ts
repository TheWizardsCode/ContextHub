/**
 * PiAdapter — Pi framework adapter for TUI agent interaction.
 *
 * Replaces the OpencodeClient with a Pi-based adapter that spawns the `pi`
 * CLI and communicates via its JSON streaming output. Provides the same
 * public interface (startServer, stopServer, sendPrompt, getStatus) so
 * the controller can be updated with minimal changes.
 *
 * Key differences from OpencodeClient:
 *  - No HTTP server to manage (pi CLI handles everything)
 *  - Uses `pi --mode json --print --continue` for streaming
 *  - Parses JSON-line events to drive the UI pane
 */

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Server status mirrors the old OpencodeServerStatus enum */
export type PiAdapterStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface ModalDialogsApi {
  selectList(options: {
    title: string;
    message: string;
    items: string[];
    defaultIndex?: number;
    cancelIndex?: number;
  }): Promise<number | null>;
  editTextarea(options: {
    title: string;
    initial: string;
    confirmLabel?: string;
    cancelLabel?: string;
  }): Promise<string | null>;
  confirmTextbox(options: {
    title: string;
    message: string;
    confirmText: string;
    cancelLabel?: string;
  }): Promise<boolean>;
}

export interface PersistedStateStore {
  load(prefix?: string): Promise<any>;
  save(prefix: string | undefined, state: any): Promise<void>;
  getPrefix?: () => string | undefined;
}

export interface PiPaneApi {
  setLabel?: (label: string) => void;
  setContent?: (content: string) => void;
  getContent?: () => string;
  setScrollPerc?: (value: number) => void;
  pushLine?: (line: string) => void;
  focus?: () => void;
}

export interface PiIndicatorApi {
  setContent?: (content: string) => void;
  show?: () => void;
  hide?: () => void;
}

export interface PiInputFieldApi {
  setLabel?: (label: string) => void;
  show?: () => void;
  hide?: () => void;
  focus?: () => void;
  clearValue?: () => void;
  once?: (event: string, handler: (value: string) => void) => void;
}

export interface SendPromptOptions {
  prompt: string;
  pane: PiPaneApi;
  indicator?: PiIndicatorApi | null;
  inputField?: PiInputFieldApi | null;
  getSelectedItemId?: () => string | null;
  onComplete?: () => void;
}

export interface PiAdapterOptions {
  port?: number; // kept for interface compatibility, not used
  cwd?: string;
  log: (message: string) => void;
  showToast: (message: string) => void;
  modalDialogs: ModalDialogsApi;
  render: () => void;
  persistedState: PersistedStateStore;
  onStatusChange?: (status: PiAdapterStatus, port: number) => void;
  spawnImpl?: typeof spawn;
}

export interface PiAdapterStatusResult {
  status: PiAdapterStatus;
  port: number;
}

// ─── JSON event parser ───────────────────────────────────────────────────────

interface PiJsonEvent {
  type: string;
  [key: string]: any;
}

/**
 * Parse the JSON lines output from `pi --mode json --print`.
 * Collects text deltas from message_update events and text content from
 * message events.
 */
class PiJsonParser {
  private accumulatedText = '';
  private chunks: string[] = [];
  private isStreaming = false;
  private eventEmitter: EventEmitter;

  constructor(eventEmitter: EventEmitter) {
    this.eventEmitter = eventEmitter;
  }

  /** Feed a line of JSON output to the parser */
  processLine(line: string): void {
    line = line.trim();
    if (!line) return;

    let evt: PiJsonEvent | null = null;
    try {
      evt = JSON.parse(line);
    } catch {
      // Ignore unparseable lines
      return;
    }

    if (!evt || typeof evt !== 'object') return;

    const eventType = evt.type;

    switch (eventType) {
      case 'message_start':
        this.isStreaming = true;
        this.chunks = [];
        break;

      case 'message_update': {
        if (!evt.assistantMessageEvent) break;
        const subEvent = evt.assistantMessageEvent;
        const partial = subEvent?.partial;
        const content = partial?.content;

        if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === 'text' && typeof part.text === 'string') {
              this.chunks.push(part.text);
            } else if (part.type === 'text' && typeof part === 'string') {
              this.chunks.push(part);
            }
          }
        }
        // Also check for direct text in partial
        if (partial && typeof partial === 'object' && typeof partial === 'object') {
          // Already handled above
        }
        break;
      }

      case 'message_end':
        this.isStreaming = false;
        break;

      case 'tool_use':
      case 'tool_result':
      case 'permission_request':
      case 'question_asked':
      case 'input_request':
        // Notify the event emitter about these events
        this.eventEmitter.emit(eventType, evt);
        break;
    }
  }

  /** Flush accumulated chunks as text */
  flush(): string {
    const text = this.chunks.join('');
    this.chunks = [];
    return text;
  }
}

// ─── PiAdapter class ─────────────────────────────────────────────────────────

/**
 * PiAdapter wraps the `pi` CLI to provide agent interaction from the TUI.
 *
 * It maintains a single persistent `pi` process (similar to opencode's server)
 * and sends prompts via stdin. Responses are streamed via the JSON mode output.
 */
export class PiAdapter {
  private process: ChildProcess | null = null;
  private status: PiAdapterStatus = 'stopped';
  private pid = 0;
  private promptBusy = false;
  private eventEmitter: EventEmitter;
  private currentPromptResolve: (() => void) | null = null;
  private currentPromptReject: ((err: Error) => void) | null = null;
  private spawnImpl: typeof spawn;
  private cwd: string;

  constructor(private readonly options: PiAdapterOptions) {
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.cwd = options.cwd ?? process.cwd();
    this.eventEmitter = new EventEmitter();
  }

  /** Get current status */
  getStatus(): PiAdapterStatusResult {
    return { status: this.status, port: this.pid };
  }

  /**
   * Start the Pi process. Unlike OpencodeClient which starts an HTTP server,
   * the PiAdapter starts a `pi` process in JSON mode.
   *
   * For the TUI, we start a persistent process that stays alive for the session.
   */
  async startServer(): Promise<boolean> {
    if (this.status === 'running') return true;
    if (this.status === 'starting') return false;

    this.status = 'starting';
    this.options.log('Starting PiAdapter...');
    this.options.onStatusChange?.('starting', 0);

    try {
      // Use --mode json and --continue (persistent session)
      // We use --no-session initially to get a clean start, then --continue for persistence
      const args = [
        '--mode', 'json',
        '--print',
        '--no-session',
      ];

      this.process = this.spawnImpl('pi', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.cwd,
        env: { ...process.env, NODE_ENV: 'production' },
      });

      this.pid = this.process.pid ?? 0;
      this.status = 'running';
      this.options.log(`PiAdapter running (pid=${this.pid})`);
      this.options.onStatusChange?.('running', this.pid);

      // Set up stdin/stdout handlers
      this.setupProcessHandlers();

      // Send a minimal heartbeat to confirm the process is alive
      await this.sendHeartbeat();

      return true;
    } catch (err) {
      this.status = 'error';
      this.options.log(`PiAdapter start failed: ${err instanceof Error ? err.message : String(err)}`);
      this.options.showToast('Failed to start Pi agent');
      this.options.onStatusChange?.('error', 0);
      return false;
    }
  }

  /**
   * Stop the Pi process. This cleans up resources.
   */
  stopServer(): void {
    if (!this.process) return;

    // Abort any in-flight prompt
    if (this.currentPromptReject) {
      this.currentPromptReject(new Error('Stopped'));
      this.currentPromptReject = null;
    }

    try {
      this.process.stdin?.end();
      this.process.kill('SIGTERM');
    } catch {
      // Process may already be dead
    }

    this.process = null;
    this.status = 'stopped';
    this.pid = 0;
    this.promptBusy = false;
    this.options.log('PiAdapter stopped');
    this.options.onStatusChange?.('stopped', 0);
  }

  /**
   * Send a prompt to the Pi agent and stream the response to the pane.
   * This is the main entry point for agent interaction.
   */
  async sendPrompt(options: SendPromptOptions): Promise<void> {
    if (this.promptBusy) {
      throw new Error('Agent is already processing a request');
    }

    if (this.status !== 'running' || !this.process) {
      throw new Error('PiAdapter is not running');
    }

    this.promptBusy = true;
    const { prompt, pane, indicator, inputField, getSelectedItemId, onComplete } = options;

    // Clear pane and show prompt
    if (indicator?.setContent) {
      indicator.setContent('⏳ Processing...');
    }
    pane.pushLine?.(`> ${prompt}`);
    this.options.render();

    // Build the prompt context
    let contextPrompt = prompt;
    const selectedItemId = getSelectedItemId?.();
    if (selectedItemId) {
      contextPrompt = `[Selected work item: ${selectedItemId}]\n\n${prompt}`;
    }

    return new Promise((resolve, reject) => {
      this.currentPromptResolve = resolve;
      this.currentPromptReject = reject;

      // Create a one-shot parser for this prompt
      const parser = new PiJsonParser(this.eventEmitter);

      // Capture process reference for safe access
      const proc = this.process;
      if (!proc) {
        throw new Error('PiAdapter process is not available');
      }

      // Set up stdout listener
      const onDataHandler = (chunk: Buffer) => {
        const text = chunk.toString();
        const lines = text.split('\n');

        for (const line of lines) {
          parser.processLine(line);
        }

        // Flush accumulated text to pane
        const flushedText = parser.flush();
        if (flushedText) {
          pane.pushLine?.(flushedText);
          this.options.render();
        }
      };

      proc.stdout?.on('data', onDataHandler);

      // Handle process events
      const onExitHandler = (code: number | null) => {
        this.promptBusy = false;
        const p = this.process;
        p?.stdout?.removeListener('data', onDataHandler);
        p?.removeListener('exit', onExitHandler);
        p?.removeListener('error', onErrorHandler);

        if (onComplete) onComplete();
        if (code === 0) {
          this.currentPromptResolve?.();
        } else {
          this.currentPromptReject?.(
            new Error(`Pi process exited with code ${code}`)
          );
        }
        this.currentPromptResolve = null;
        this.currentPromptReject = null;
      };

      const onErrorHandler = (err: Error) => {
        this.promptBusy = false;
        const p = this.process;
        p?.stdout?.removeListener('data', onDataHandler);
        p?.removeListener('exit', onExitHandler);
        p?.removeListener('error', onErrorHandler);

        pane.pushLine?.(`{red-fg}Error: ${err.message}{/red-fg}`);
        this.options.render();

        if (onComplete) onComplete();
        this.currentPromptReject?.(err);
        this.currentPromptResolve = null;
        this.currentPromptReject = null;
      };

      proc.on('exit', onExitHandler);
      proc.on('error', onErrorHandler);

      // Send the prompt via stdin
      proc.stdin?.write(`${contextPrompt}\n`);

      // Handle modal dialog responses from the agent
      this.eventEmitter.once('question_asked', (data: any) => {
        this.handleQuestionAsked(data, pane, onComplete);
      });

      this.eventEmitter.once('permission_request', (data: any) => {
        this.handlePermissionRequest(data, pane, onComplete);
      });
    });
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  private setupProcessHandlers(): void {
    // Log stderr for debugging
    this.process?.stderr?.on('data', (chunk: Buffer) => {
      this.options.log(`[pi stderr] ${chunk.toString().trim()}`);
    });
  }

  private async sendHeartbeat(): Promise<void> {
    // Send a minimal prompt to verify the process responds
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.process?.stdout?.removeListener('data', handler);
        this.process?.removeListener('exit', exitHandler);
        reject(new Error('PiAdapter heartbeat timed out'));
      }, 10000);

      const handler = (chunk: Buffer) => {
        const text = chunk.toString();
        if (text.includes('message_end') || text.includes('type":"')) {
          clearTimeout(timeout);
          this.process?.stdout?.removeListener('data', handler);
          this.process?.removeListener('exit', exitHandler);
          resolve();
        }
      };

      const exitHandler = (code: number | null) => {
        clearTimeout(timeout);
        this.process?.stdout?.removeListener('data', handler);
        reject(new Error(`Pi process exited unexpectedly with code ${code}`));
      };

      this.process?.on('exit', exitHandler);
      this.process?.stdout?.on('data', handler);
      this.process?.stdin?.write('heartbeat\n');
    });
  }

  private async handleQuestionAsked(
    data: any,
    pane: PiPaneApi,
    onComplete?: () => void
  ): Promise<void> {
    const question = data?.question?.question || 'Unknown question';
    const options = data?.question?.options || [];

    // Show modal dialog for user to respond
    try {
      const choice = await this.options.modalDialogs.selectList({
        title: 'Agent Question',
        message: question,
        items: options.map((o: any) => o.label || o.value || 'Unknown'),
      });

      if (choice !== null) {
        const selected = options[choice]?.value || options[choice]?.label;
        pane.pushLine?.(`[Response: ${selected}]`);
        this.options.render();
      } else {
        pane.pushLine?.('[User cancelled]');
        this.options.render();
      }
    } catch {
      pane.pushLine?.('[Error showing dialog]');
      this.options.render();
    }

    if (onComplete) onComplete();
  }

  private async handlePermissionRequest(
    data: any,
    pane: PiPaneApi,
    onComplete?: () => void
  ): Promise<void> {
    try {
      const granted = await this.options.modalDialogs.confirmTextbox({
        title: 'Agent Permission Request',
        message: data?.description || 'Allow this operation?',
        confirmText: 'Allow',
      });

      pane.pushLine?.(`[Permission: ${granted ? 'granted' : 'denied'}]`);
      this.options.render();
    } catch {
      pane.pushLine?.('[Error showing permission dialog]');
      this.options.render();
    }

    if (onComplete) onComplete();
  }
}

// ─── Export compatible type alias for controller compatibility ───────────────

/** For backward compatibility with code that imports OpencodeServerStatus */
export type OpencodeServerStatus = PiAdapterStatus;
