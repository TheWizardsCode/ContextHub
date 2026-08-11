export class ProgressReporter {
    mode;
    rateMs;
    outStream;
    jsonStream;
    lastEmitByPhase;
    heartbeatTimer;
    heartbeatIntervalMs;
    heartbeatNotePrefix;
    lastProgressEvent;
    lastProgressAtMs;
    lastHumanRenderLength;
    constructor(opts) {
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
    labelFor(phase) {
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
    formatHuman(ev) {
        const label = this.labelFor(ev.phase);
        const pct = ev.total > 0 ? Math.round((ev.current / ev.total) * 100) : 0;
        const base = `${label}: ${ev.current}/${ev.total}`;
        if (ev.note) {
            const trimmed = ev.note.trimStart();
            if (trimmed.startsWith(`${label}:`)) {
                return trimmed;
            }
            return `${base} (${ev.note})`;
        }
        return `${base} ${pct}%`;
    }
    formatJson(ev) {
        return JSON.stringify({ type: 'progress', phase: ev.phase, current: ev.current, total: ev.total, note: ev.note, timestamp: Date.now() });
    }
    supportsHumanHeartbeat() {
        if (this.mode === 'quiet' || this.mode === 'json') {
            return false;
        }
        if (this.mode === 'human') {
            return true;
        }
        return this.outStream && this.outStream.isTTY === true;
    }
    writeHumanMessage(msg, isComplete) {
        try {
            const padded = `${msg} `.padEnd(this.lastHumanRenderLength, ' ');
            this.lastHumanRenderLength = padded.length;
            this.outStream.write(`\r${padded}`);
            if (isComplete) {
                this.outStream.write('\n');
                this.lastHumanRenderLength = 0;
            }
        }
        catch (_) { }
    }
    emit(ev, force = false, completeOverride) {
        if (this.mode === 'quiet')
            return;
        const now = Date.now();
        const phaseKey = `${ev.phase}`;
        const last = this.lastEmitByPhase.get(phaseKey) || 0;
        const shouldEmit = force || (now - last) >= this.rateMs || ev.current === ev.total;
        if (!shouldEmit)
            return;
        this.lastEmitByPhase.set(phaseKey, now);
        // Decide whether to emit json or human
        if (this.mode === 'json') {
            try {
                this.jsonStream.write(this.formatJson(ev) + '\n');
            }
            catch (_) { }
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
            const isTty = (this.outStream && this.outStream.isTTY === true);
            if (isTty) {
                const msg = this.formatHuman(ev);
                this.writeHumanMessage(msg, isComplete);
                return;
            }
            try {
                this.jsonStream.write(this.formatJson(ev) + '\n');
            }
            catch (_) { }
        }
    }
    // Render a single progress event respecting mode and rate-limiting
    render(ev) {
        this.lastProgressEvent = ev;
        this.lastProgressAtMs = Date.now();
        this.emit(ev);
    }
    startHeartbeat(opts) {
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
        const timer = this.heartbeatTimer;
        if (timer && typeof timer.unref === 'function') {
            timer.unref();
        }
    }
    stopHeartbeat() {
        if (!this.heartbeatTimer) {
            return;
        }
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }
}
//# sourceMappingURL=progress.js.map