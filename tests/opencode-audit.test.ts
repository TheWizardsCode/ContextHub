import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { isWaitingForInputEvent, runOpencodeAudit } from '../src/opencode-audit.js';

function makeFakeChild(exitCode = 0) {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((signal?: string) => {
    if (signal === 'SIGTERM') {
      setImmediate(() => child.emit('close', 0, null));
    }
    return true;
  });
  child.emitClose = (code = exitCode, signal: NodeJS.Signals | null = null) => {
    setImmediate(() => child.emit('close', code, signal));
  };
  child.emitStdoutLine = (line: string) => {
    setImmediate(() => child.stdout.emit('data', Buffer.from(`${line}\n`)));
  };
  child.emitStderrLine = (line: string) => {
    setImmediate(() => child.stderr.emit('data', Buffer.from(`${line}\n`)));
  };
  return child;
}

describe('opencode audit runner', () => {
  it('detects waiting-for-input style events', () => {
    expect(isWaitingForInputEvent({ type: 'session.status', event: 'waiting-for-input' })).toBe(true);
    expect(isWaitingForInputEvent({ type: 'question.asked' })).toBe(true);
    expect(isWaitingForInputEvent({ type: 'input.request' })).toBe(true);
    expect(isWaitingForInputEvent({ type: 'message.part', part: { type: 'text', text: 'hello' } })).toBe(false);
  });

  it('collects assistant text and terminates on wait event', async () => {
    const child = makeFakeChild(0);
    const spawnImpl = vi.fn(() => child as any);

    const promise = runOpencodeAudit({ workItemId: 'WL-123', spawnImpl: spawnImpl as any, timeoutMs: 2000 });

    child.emitStdoutLine(JSON.stringify({
      type: 'text',
      part: { type: 'text', messageID: 'm1', text: 'Audit line 1' },
    }));
    child.emitStdoutLine(JSON.stringify({
      type: 'text',
      part: { type: 'text', messageID: 'm1', text: 'Audit line 2' },
    }));
    child.emitStdoutLine(JSON.stringify({ type: 'input.request', input: { type: 'text' } }));

    const result = await promise;
    expect(spawnImpl).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result.auditText).toBe('Audit line 1\nAudit line 2');
    expect(result.terminatedOnWait).toBe(true);
  });

  it('fails on invalid JSON output lines', async () => {
    const child = makeFakeChild(0);
    const spawnImpl = vi.fn(() => child as any);

    const promise = runOpencodeAudit({ workItemId: 'WL-999', spawnImpl: spawnImpl as any, timeoutMs: 2000 });

    child.emitStdoutLine('not-json');
    child.emitClose(0, null);

    await expect(promise).rejects.toThrow('Failed to parse opencode JSON output');
  });

  it('fails when assistant text is missing', async () => {
    const child = makeFakeChild(0);
    const spawnImpl = vi.fn(() => child as any);

    const promise = runOpencodeAudit({ workItemId: 'WL-1000', spawnImpl: spawnImpl as any, timeoutMs: 2000 });
    child.emitStdoutLine(JSON.stringify({ type: 'session.status', status: 'idle' }));
    child.emitClose(0, null);

    await expect(promise).rejects.toThrow('Audit output did not include assistant text');
  });
});
