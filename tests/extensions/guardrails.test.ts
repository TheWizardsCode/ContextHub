/**
 * Tests for the guardrails module.
 *
 * Tests the protected path detection, dangerous command detection, and
 * the installGuardrails integration point.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @earendil-works/pi-coding-agent since it's globally installed,
// not a project dependency. Provide isToolCallEventType implementation
// so the guardrails module loads correctly.
vi.mock('@earendil-works/pi-coding-agent', () => ({
  isToolCallEventType: (toolName: string, event: any) => event.toolName === toolName,
}));

import {
  isWorklogProtectedPath,
  isDangerousWorklogCommand,
  INSTALL_GUARDRAILS,
} from '../../packages/tui/extensions/lib/guardrails.ts';

// ── isWorklogProtectedPath Tests ──────────────────────────────────────

describe('isWorklogProtectedPath', () => {
  it('returns true for the main worklog database path', () => {
    expect(isWorklogProtectedPath('.worklog/worklog.db')).toBe(true);
  });

  it('returns true for the WAL file', () => {
    expect(isWorklogProtectedPath('.worklog/worklog.db-wal')).toBe(true);
  });

  it('returns true for the shared memory file', () => {
    expect(isWorklogProtectedPath('.worklog/worklog.db-shm')).toBe(true);
  });

  it('returns true for the JSONL data file', () => {
    expect(isWorklogProtectedPath('.worklog/worklog-data.jsonl')).toBe(true);
  });

  it('returns true for absolute paths containing worklog files', () => {
    expect(isWorklogProtectedPath('/home/user/project/.worklog/worklog.db')).toBe(true);
    expect(isWorklogProtectedPath('/repo/.worklog/worklog-data.jsonl')).toBe(true);
  });

  it('returns false for non-protected files', () => {
    expect(isWorklogProtectedPath('.worklog/config.yaml')).toBe(false);
    expect(isWorklogProtectedPath('src/index.ts')).toBe(false);
    expect(isWorklogProtectedPath('README.md')).toBe(false);
  });

  it('returns false for empty paths', () => {
    expect(isWorklogProtectedPath('')).toBe(false);
  });

  it('returns false for null or undefined paths', () => {
    expect(isWorklogProtectedPath(null as unknown as string)).toBe(false);
    expect(isWorklogProtectedPath(undefined as unknown as string)).toBe(false);
  });

  it('protects worklog.db in nested worklog directories', () => {
    expect(isWorklogProtectedPath('/deep/path/.worklog/worklog.db')).toBe(true);
    expect(isWorklogProtectedPath('./.worklog/worklog.db')).toBe(true);
  });

  it('does not protect files with similar names to database files', () => {
    expect(isWorklogProtectedPath('.worklog/worklog.db.backup')).toBe(false);
    expect(isWorklogProtectedPath('.worklog/worklog-data.jsonl.old')).toBe(false);
    expect(isWorklogProtectedPath('my-worklog.db')).toBe(false);
  });
});

// ── isDangerousWorklogCommand Tests ───────────────────────────────────

describe('isDangerousWorklogCommand', () => {
  it('detects rm -rf .worklog command', () => {
    expect(isDangerousWorklogCommand('rm -rf .worklog')).toBe(true);
    expect(isDangerousWorklogCommand('rm -rf .worklog/')).toBe(true);
    expect(isDangerousWorklogCommand('rm -rfv .worklog')).toBe(true); // different flags
  });

  it('detects rm commands targeting worklog files', () => {
    expect(isDangerousWorklogCommand('rm .worklog/worklog.db')).toBe(true);
    expect(isDangerousWorklogCommand('rm -f .worklog/worklog-data.jsonl')).toBe(true);
  });

  it('detects sqlite3 direct database access', () => {
    expect(isDangerousWorklogCommand('sqlite3 .worklog/worklog.db')).toBe(true);
    expect(isDangerousWorklogCommand('sqlite3 .worklog/worklog.db "SELECT * FROM items"')).toBe(true);
  });

  it('detects mv commands targeting worklog', () => {
    expect(isDangerousWorklogCommand('mv .worklog /tmp/')).toBe(true);
    expect(isDangerousWorklogCommand('mv .worklog/worklog.db /tmp/')).toBe(true);
  });

  it('detects cp commands targeting worklog', () => {
    expect(isDangerousWorklogCommand('cp -r .worklog /tmp/')).toBe(true);
    expect(isDangerousWorklogCommand('cp .worklog/worklog.db /tmp/backup.db')).toBe(true);
  });

  it('allows safe shell commands', () => {
    expect(isDangerousWorklogCommand('wl list --json')).toBe(false);
    expect(isDangerousWorklogCommand('wl update WL-123 --status open --json')).toBe(false);
    expect(isDangerousWorklogCommand('ls -la')).toBe(false);
    expect(isDangerousWorklogCommand('echo "hello"')).toBe(false);
    expect(isDangerousWorklogCommand('cd .worklog && ls')).toBe(false);
  });

  it('allows commands that mention .worklog in safe contexts', () => {
    // Commands that reference .worklog but don't damage it
    expect(isDangerousWorklogCommand('ls .worklog')).toBe(false);
    expect(isDangerousWorklogCommand('cat .worklog/config.yaml')).toBe(false);
    expect(isDangerousWorklogCommand('wc -l .worklog/config.yaml')).toBe(false);
  });

  it('returns false for empty commands', () => {
    expect(isDangerousWorklogCommand('')).toBe(false);
  });

  it('returns false for null or undefined commands', () => {
    expect(isDangerousWorklogCommand(null as unknown as string)).toBe(false);
    expect(isDangerousWorklogCommand(undefined as unknown as string)).toBe(false);
  });
});

// ── installGuardrails Integration Tests ───────────────────────────────

describe('installGuardrails', () => {
  let mockPi: any;

  beforeEach(() => {
    mockPi = {
      on: vi.fn(),
    };
  });

  it('calls pi.on at least twice (for tool_call events)', () => {
    INSTALL_GUARDRAILS(mockPi);

    // Should register at least two tool_call handlers
    const toolCallCalls = mockPi.on.mock.calls.filter(
      (call: any[]) => call[0] === 'tool_call',
    );
    expect(toolCallCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('registers tool_call handlers when enabled (default)', () => {
    INSTALL_GUARDRAILS(mockPi);

    expect(mockPi.on).toHaveBeenCalledWith('tool_call', expect.any(Function));
  });

  it('registers handlers even when explicitly disabled (handlers check flag at runtime)', () => {
    INSTALL_GUARDRAILS(mockPi, { enabled: false });

    // Should still register handlers that check the enabled flag at runtime
    const toolCallCalls = mockPi.on.mock.calls.filter(
      (call: any[]) => call[0] === 'tool_call',
    );
    expect(toolCallCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('blocks write calls to protected paths', async () => {
    const handlers: Record<string, Function[]> = {};
    mockPi.on = vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    });

    INSTALL_GUARDRAILS(mockPi);

    // Simulate a tool_call event for a write to a protected path.
    // Run through all registered tool_call handlers.
    let result: any = undefined;
    for (const handler of (handlers['tool_call'] || [])) {
      result = await handler({
        toolName: 'write',
        input: { path: '.worklog/worklog.db' },
      });
      if (result) break;
    }

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining('worklog database'),
    });
  });

  it('blocks edit calls to protected paths', async () => {
    const handlers: Record<string, Function[]> = {};
    mockPi.on = vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    });

    INSTALL_GUARDRAILS(mockPi);

    let result: any = undefined;
    for (const handler of (handlers['tool_call'] || [])) {
      result = await handler({
        toolName: 'edit',
        input: { path: '.worklog/worklog-data.jsonl' },
      });
      if (result) break;
    }

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining('worklog database'),
    });
  });

  it('blocks dangerous bash commands', async () => {
    const handlers: Record<string, Function[]> = {};
    mockPi.on = vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    });

    INSTALL_GUARDRAILS(mockPi);

    let result: any = undefined;
    for (const handler of (handlers['tool_call'] || [])) {
      result = await handler({
        toolName: 'bash',
        input: { command: 'rm -rf .worklog' },
      });
      if (result) break;
    }

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining('damage worklog data'),
    });
  });

  it('allows write calls to non-protected paths', async () => {
    const handlers: Record<string, Function[]> = {};
    mockPi.on = vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    });

    INSTALL_GUARDRAILS(mockPi);

    let result: any = undefined;
    for (const handler of (handlers['tool_call'] || [])) {
      result = await handler({
        toolName: 'write',
        input: { path: 'src/index.ts' },
      });
      if (result) break;
    }

    // Should not block
    expect(result).toBeUndefined();
  });

  it('allows safe bash commands', async () => {
    const handlers: Record<string, Function[]> = {};
    mockPi.on = vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    });

    INSTALL_GUARDRAILS(mockPi);

    let result: any = undefined;
    for (const handler of (handlers['tool_call'] || [])) {
      result = await handler({
        toolName: 'bash',
        input: { command: 'wl list --json' },
      });
      if (result) break;
    }

    // Should not block
    expect(result).toBeUndefined();
  });

  it('allows write to worklog database when guardrails are disabled', async () => {
    const handlers: Record<string, Function[]> = {};
    mockPi.on = vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    });

    INSTALL_GUARDRAILS(mockPi, { enabled: false });

    let result: any = undefined;
    for (const handler of (handlers['tool_call'] || [])) {
      result = await handler({
        toolName: 'write',
        input: { path: '.worklog/worklog.db' },
      });
      if (result) break;
    }

    // Should not block when disabled
    expect(result).toBeUndefined();
  });

  it('allows dangerous commands when guardrails are disabled', async () => {
    const handlers: Record<string, Function[]> = {};
    mockPi.on = vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    });

    INSTALL_GUARDRAILS(mockPi, { enabled: false });

    let result: any = undefined;
    for (const handler of (handlers['tool_call'] || [])) {
      result = await handler({
        toolName: 'bash',
        input: { command: 'rm -rf .worklog' },
      });
      if (result) break;
    }

    // Should not block when disabled
    expect(result).toBeUndefined();
  });
});
