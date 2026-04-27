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

export class ProgressReporter {
  private mode: ProgressMode;
  private rateMs: number;
  private outStream: NodeJS.WriteStream;
  private jsonStream: NodeJS.WriteStream;
  private lastEmitByPhase: Map<string, number>;

  constructor(opts?: ProgressOptions) {
    this.mode = opts?.mode ?? 'auto';
    this.rateMs = typeof opts?.rateMs === 'number' ? opts.rateMs : 1000;
    this.outStream = opts?.outStream ?? process.stdout;
    this.jsonStream = opts?.jsonStream ?? process.stderr;
    this.lastEmitByPhase = new Map();
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

  // Render a single progress event respecting mode and rate-limiting
  render(ev: ProgressEvent): void {
    if (this.mode === 'quiet') return;

    const now = Date.now();
    const phaseKey = `${ev.phase}`;
    const last = this.lastEmitByPhase.get(phaseKey) || 0;
    const shouldEmit = (now - last) >= this.rateMs || ev.current === ev.total;
    if (!shouldEmit) return;
    this.lastEmitByPhase.set(phaseKey, now);

    // Decide whether to emit json or human
    if (this.mode === 'json') {
      try { this.jsonStream.write(this.formatJson(ev) + '\n'); } catch (_) {}
      return;
    }

    if (this.mode === 'human') {
      const msg = this.formatHuman(ev);
      try {
        const padded = `${msg} `;
        // carriage return to overwrite
        this.outStream.write(`\r${padded}`);
        if (ev.current === ev.total) this.outStream.write('\n');
      } catch (_) {}
      return;
    }

    // auto mode: prefer human when TTY, otherwise json to stderr
    if (this.mode === 'auto') {
      const isTty = (this.outStream && (this.outStream as any).isTTY === true);
      if (isTty) {
        const msg = this.formatHuman(ev);
        try {
          const padded = `${msg} `;
          this.outStream.write(`\r${padded}`);
          if (ev.current === ev.total) this.outStream.write('\n');
        } catch (_) {}
        return;
      }
      try { this.jsonStream.write(this.formatJson(ev) + '\n'); } catch (_) {}
    }
  }
}
