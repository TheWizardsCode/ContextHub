export type ProgressPhase = 'push' | 'import' | 'close-check' | 'hierarchy' | 'comments' | 'saving';

export interface ProgressEvent {
  phase: ProgressPhase;
  current: number;
  total: number;
  note?: string;
}

export type ProgressMode = 'auto' | 'json' | 'human' | 'quiet';

export interface ProgressOptions {
  mode?: ProgressMode;
  rateMs?: number; // minimum ms between emitted events per phase
  outStream?: NodeJS.WriteStream; // human output (default: process.stdout)
  jsonStream?: NodeJS.WriteStream; // json output (default: process.stderr)
}

export interface ProgressHeartbeatOptions {
  intervalMs?: number;
  notePrefix?: string;
}

export class ProgressReporter {
  private mode: ProgressMode;
  private rateMs: number;
  private outStream: NodeJS.WriteStream;
  private jsonStream: NodeJS.WriteStream;
  private lastEmitByPhase: Map<string, number>;
  private heartbeatTimer: NodeJS.Timeout | null;
  private heartbeatIntervalMs: number;
  private heartbeatNotePrefix: string;
  private lastProgressEvent: ProgressEvent | null;
  private lastProgressAtMs: number;
  private lastHumanRenderLength: number;

  constructor(opts?: ProgressOptions) {
    this.mode = opts?.mode ?? 'auto';
    this.rateMs = typeof opts?.rateMs === 'number' ? opts.rateMs : 1000;
    this.outStream = opts?.outStream ?? process.stdout;
    this.jsonStream = opts?.jsonStream ?? process.stderr;
    this.lastEmitByPhase = new Map();
    this.heartbeatTimer = null;
    this.heartbeatIntervalMs = 15000;
    this.heartbeatNotePrefix = 'heartbeat';
    this.lastProgressEvent = null;
    this.lastProgressAtMs = 0;
    this.lastHumanRenderLength = 0;
  }

  // Format a short human-friendly label for a phase
  private labelFor(phase: ProgressPhase): string {
    switch (phase) {
      case 'push': return 'Push';
      case 'import': return 'Import';
      case 'hierarchy': return 'Hierarchy';
      case 'comments': return 'Comments';
      case 'saving': return 'Saving';
      case 'close-check': return 'Close check';
      default: return phase;
    }
  }

  private formatHuman(ev: ProgressEvent): string {
    const label = this.labelFor(ev.phase);
    const pct = ev.total > 0 ? Math.round((ev.current / ev.total) * 100) : 0;
    const base = `${label}: ${ev.current}/${ev.total}`;
    if (ev.note) return `${base} (${ev.note})`;
    return `${base} ${pct}%`;
  }

  private formatJson(ev: ProgressEvent) {
    return JSON.stringify({ type: 'progress', phase: ev.phase, current: ev.current, total: ev.total, note: ev.note, timestamp: Date.now() });
  }

  private supportsHumanHeartbeat(): boolean {
    if (this.mode === 'quiet' || this.mode === 'json') {
      return false;
    }
    if (this.mode === 'human') {
      return true;
    }
    return this.outStream && (this.outStream as any).isTTY === true;
  }

  private writeHumanMessage(msg: string, isComplete: boolean): void {
    try {
      const padded = `${msg} `.padEnd(this.lastHumanRenderLength, ' ');
      this.lastHumanRenderLength = padded.length;
      this.outStream.write(`\r${padded}`);
      if (isComplete) {
        this.outStream.write('\n');
        this.lastHumanRenderLength = 0;
      }
    } catch (_) {}
  }

  private emit(ev: ProgressEvent, force = false, completeOverride?: boolean): void {
    if (this.mode === 'quiet') return;

    const now = Date.now();
    const phaseKey = `${ev.phase}`;
    const last = this.lastEmitByPhase.get(phaseKey) || 0;
    const shouldEmit = force || (now - last) >= this.rateMs || ev.current === ev.total;
    if (!shouldEmit) return;
    this.lastEmitByPhase.set(phaseKey, now);

    // Decide whether to emit json or human
    if (this.mode === 'json') {
      try { this.jsonStream.write(this.formatJson(ev) + '\n'); } catch (_) {}
      return;
    }

    const isComplete = completeOverride ?? (ev.current === ev.total);

    if (this.mode === 'human') {
      const msg = this.formatHuman(ev);
      this.writeHumanMessage(msg, isComplete);
      return;
    }

    // auto mode: prefer human when TTY, otherwise json to stderr
    if (this.mode === 'auto') {
      const isTty = (this.outStream && (this.outStream as any).isTTY === true);
      if (isTty) {
        const msg = this.formatHuman(ev);
        this.writeHumanMessage(msg, isComplete);
        return;
      }
      try { this.jsonStream.write(this.formatJson(ev) + '\n'); } catch (_) {}
    }
  }

  // Render a single progress event respecting mode and rate-limiting
  render(ev: ProgressEvent): void {
    this.lastProgressEvent = ev;
    this.lastProgressAtMs = Date.now();
    this.emit(ev);
  }

  startHeartbeat(opts?: ProgressHeartbeatOptions): void {
    this.stopHeartbeat();
    if (!this.supportsHumanHeartbeat()) {
      return;
    }
    const intervalMsRaw = Number(opts?.intervalMs ?? this.heartbeatIntervalMs);
    const intervalMs = Number.isFinite(intervalMsRaw) ? Math.max(1000, intervalMsRaw) : this.heartbeatIntervalMs;
    const notePrefix = (opts?.notePrefix || this.heartbeatNotePrefix || 'heartbeat').trim() || 'heartbeat';
    this.heartbeatIntervalMs = intervalMs;
    this.heartbeatNotePrefix = notePrefix;

    this.heartbeatTimer = setInterval(() => {
      if (!this.lastProgressEvent || this.lastProgressAtMs <= 0) {
        return;
      }
      const idleMs = Date.now() - this.lastProgressAtMs;
      if (idleMs < this.heartbeatIntervalMs) {
        return;
      }
      const idleSeconds = Math.floor(idleMs / 1000);
      const heartbeatNote = `${this.heartbeatNotePrefix}: no updates for ${idleSeconds}s`;
      const note = this.lastProgressEvent.note
        ? `${this.lastProgressEvent.note}; ${heartbeatNote}`
        : heartbeatNote;
      this.emit({ ...this.lastProgressEvent, note }, true, false);
    }, this.heartbeatIntervalMs);

    const timer = this.heartbeatTimer as any;
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
