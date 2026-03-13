/**
 * Lightweight keyboard chord handler for TUI.
 *
 * API:
 * - new ChordHandler({ timeoutMs })
 * - register(sequence: string[], handler: () => void)
 * - feed(key: KeyInfo): boolean  // returns true if the event was consumed by the chord system
 * - reset(): void
 */

export type KeyInfo = { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean };

type Handler = () => void;

function normalizeKey(k: KeyInfo | string): string {
  if (typeof k === 'string') return k;
  const name = k.name || '';
  const parts: string[] = [];
  if (k.ctrl) parts.push('C');
  if (k.meta) parts.push('M');
  if (k.shift) parts.push('S');
  parts.push(name);
  return parts.join('-');
}

export class ChordHandler {
  private readonly timeoutMs: number;
  private readonly trie: Map<string, any> = new Map();
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingHandler: Handler | null = null;

  constructor(opts?: { timeoutMs?: number }) {
    this.timeoutMs = opts?.timeoutMs ?? 1000;
  }

  // Register a sequence of normalized keys (array of KeyInfo or strings)
  register(seq: Array<KeyInfo | string>, handler: Handler): void {
    const keys = seq.map(normalizeKey);
    let node: Map<string, any> = this.trie;
    for (const k of keys) {
      if (!node.has(k)) node.set(k, new Map());
      node = node.get(k) as Map<string, any>;
    }
    // store handler under a special key
    (node as any).__handler = handler;
  }

  reset(): void {
    this.pending = [];
    if (this.timer) {
      clearTimeout(this.timer as any);
      this.timer = null;
    }
  }

  // Return whether a chord prefix is currently pending (leader pressed,
  // waiting for follow-up). Tests and controller use this to guard widget
  // behaviour while a chord is in-flight.
  isPending(): boolean {
    return this.pending.length > 0 || this.timer !== null || this.pendingHandler !== null;
  }

  private scheduleClear(): void {
    if (this.timer) clearTimeout(this.timer as any);
    this.timer = setTimeout(() => {
      if (this.pendingHandler) {
        try { this.pendingHandler(); } catch (_) {}
        this.pendingHandler = null;
      }
      this.pending = [];
      this.timer = null;
    }, this.timeoutMs) as any;
  }

  // Feed a key event. Returns true if the chord-system consumed the event
  feed(key: KeyInfo | string): boolean {
    const k = normalizeKey(key);
    const dbg = !!process.env.TUI_CHORD_DEBUG;
    if (dbg) {
      try { console.error(`[chords] feed key=${JSON.stringify(key)} -> normalized='${k}', pending=${JSON.stringify(this.pending)}, timer=${this.timer ? 'set' : 'null'}`); } catch (_) {}
    }
    // if there is an in-flight pending short-handler timer, cancel it
    if (this.timer) {
      clearTimeout(this.timer as any);
      this.timer = null;
      this.pendingHandler = null;
    }

    const nextPending = [...this.pending, k];

    // Walk trie to see if any sequence starts with nextPending
    let node: Map<string, any> = this.trie;
    let matched = true;
    for (const p of nextPending) {
      if (!node.has(p)) { matched = false; break; }
      node = node.get(p) as Map<string, any>;
    }

  if (!matched) {
      // No prefix matches — this can happen when the same physical key
      // event is delivered twice (we observe both a raw keypress and a
      // wrapper-delivered key). If the repeated key is identical to the
      // previous pending key (e.g. duplicate leader events like C-w), we
      // should consume the duplicate instead of resetting the pending
      // state. This avoids cycles where a duplicate leader clears the
      // pending state and prevents the intended follow-up key from
      // matching.
      const lp = this.pending[this.pending.length - 1];
      const lastIsSameAsNew = nextPending.length > 1 && nextPending[nextPending.length - 1] === nextPending[nextPending.length - 2];
      if (lastIsSameAsNew) {
        // Keep the pending timeout alive when deduplicating repeated physical
        // key events (e.g. raw keypress + screen.key wrapper for Ctrl-W).
        // Without re-scheduling here the pending prefix can remain set
        // indefinitely and suppress normal key handling.
        this.scheduleClear();
        if (dbg) try { console.error(`[chords] duplicate key '${k}' ignored (pending=${JSON.stringify(this.pending)})`); } catch (_) {}
        // Consume the duplicate event but keep pending as-is.
        return true;
      }

      // No prefix matches — reset pending and return false (not consumed)
      if (dbg) try { console.error(`[chords] no match for '${k}' with pending=${JSON.stringify(this.pending)}`); } catch (_) {}
      this.reset();
      return false;
    }

    // At least a prefix matches. If a handler is present on this node, it's a full match.
    this.pending = nextPending;
    // If this node has a handler and also has children, defer invocation to allow longer matches
    const hasHandler = typeof (node as any).__handler === 'function';
    const childCount = Array.from(node.keys()).filter(k => k !== '__handler').length;
    if (hasHandler) {
      if (childCount > 0) {
        this.pendingHandler = (node as any).__handler as Handler;
        this.scheduleClear();
        if (dbg) try { console.error(`[chords] matched handler at '${this.pending.join(',')}' deferred (has children)`); } catch (_) {}
        return true;
      }
      // no children: invoke immediately
      try { (node as any).__handler(); } catch (_) {}
      if (dbg) try { console.error(`[chords] matched handler at '${this.pending.join(',')}' invoked immediately`); } catch (_) {}
      this.reset();
      return true;
    }

    // Partial match — there are children below this node but no handler at
    // this exact node. We should defer/remember the pending prefix and also
    // schedule a timeout to clear it (leader timeout). Without this the
    // pending state would persist indefinitely which prevents normal
    // behaviour and suppresses follow-up keys.
    if (childCount > 0) {
      this.pendingHandler = null;
      this.scheduleClear();
      if (dbg) try { console.error(`[chords] partial match for '${this.pending.join(',')}', scheduled clear`); } catch (_) {}
      return true;
    }

    // Fallback: consume the event so caller can avoid treating it as ordinary keypress
    if (dbg) try { console.error(`[chords] fallback consume for '${k}'`); } catch (_) {}
    return true;
  }
}

export default ChordHandler;
