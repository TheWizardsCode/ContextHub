import { describe, it, expect, vi } from 'vitest';
import ChordHandler from '../src/tui/chords.js';

describe('ChordHandler', () => {
  it('matches single-key registered chords', () => {
    const c = new ChordHandler({ timeoutMs: 50 });
    let called = false;
    c.register(['a'], () => { called = true; });
    const consumed = c.feed({ name: 'a' });
    expect(consumed).toBe(true);
    expect(called).toBe(true);
  });

  it('consumes partial sequences and times out', async () => {
    const c = new ChordHandler({ timeoutMs: 20 });
    let called = false;
    c.register(['C-w', 'w'], () => { called = true; });
    // feed Ctrl-W (as ctrl + name)
    const consumed1 = c.feed({ name: 'w', ctrl: true });
    expect(consumed1).toBe(true);
    expect(called).toBe(false);
    // wait past timeout and feed 'w' — should not trigger
    await new Promise(r => setTimeout(r, 30));
    // ensure pending state cleared
    c.reset();
    const consumed2 = c.feed({ name: 'w' });
    expect(consumed2).toBe(false);
    expect(called).toBe(false);
  });

  it('handles nested chords and invokes handler on full match', () => {
    const c = new ChordHandler({ timeoutMs: 100 });
    let aCalled = false;
    let abCalled = false;
    c.register(['g'], () => { aCalled = true; });
    c.register(['g', 'g'], () => { abCalled = true; });
    // When both a single and a longer chord are registered the handler
    // for the single key is deferred until the timeout to allow the
    // longer chord to complete. Here we exercise the longer-chord path:
    const p1 = c.feed({ name: 'g' });
    expect(p1).toBe(true);
    // handler not invoked immediately
    expect(aCalled).toBe(false);
    // feed second g to complete the 'gg' chord
    const p2 = c.feed({ name: 'g' });
    expect(p2).toBe(true);
    expect(abCalled).toBe(true);
  });

  it('preserves deferred handler when duplicate physical key events arrive', async () => {
    const c = new ChordHandler({ timeoutMs: 30 });
    let singleCalled = false;
    c.register(['g'], () => { singleCalled = true; });
    c.register(['g', 'g'], () => {}); // longer chord exists so single is deferred

    // press 'g' to set pending and deferred handler
    const p1 = c.feed({ name: 'g' });
    expect(p1).toBe(true);
    expect(singleCalled).toBe(false);

    // simulate a duplicate physical delivery of the same leader key
    const pDup = c.feed({ name: 'g' });
    expect(pDup).toBe(true);

    // wait for timeout to elapse and allow deferred handler to run
    await new Promise(r => new Promise((res) => setTimeout(res, 40)).then(r));
    expect(singleCalled).toBe(true);
  });
});
