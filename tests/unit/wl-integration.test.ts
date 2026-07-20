// tests/unit/wl-integration.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// Shared child_process mock (stored on globalThis by setup-tests.ts).
// The factory reads from the global store directly — no vi.hoisted needed.
// Only test files that need the mock register it here.
vi.mock("child_process", () => {
  const store = (globalThis as any).__sharedChildProcessMocks;
  return {
    spawn: store?.mockSpawn ?? vi.fn(),
    spawnSync: store?.mockSpawnSync ?? vi.fn(),
    execSync: store?.mockExecSync ?? vi.fn(),
  };
});

// Import shared mock instances for use in test bodies.
import { initChildProcessMocks } from "../child-process-mocks.js";
const { mockSpawn: mockedSpawn } = initChildProcessMocks();

import { runWlCommand, wlEvents, WlError } from "../../src/wl-integration/spawn";

function mockProcess({ exitCode = 0, stdout = "", stderr = "", delay = 0 } = {}) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  // Emit data
  setTimeout(() => {
    if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
    if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", exitCode);
  }, delay);
  return proc;
}

describe("runWlCommand", () => {
  beforeEach(() => {
    mockedSpawn.mockReset();
  });

  it("resolves success with json parsed", async () => {
    mockedSpawn.mockImplementation(() =>
      mockProcess({ stdout: "{\"ok\":true}\n", exitCode: 0 })
    );
    const result = await runWlCommand(["list", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({ ok: true });
    expect(result.error).toBeUndefined();
  });

  it("handles non‑zero exit", async () => {
    mockedSpawn.mockImplementation(() => mockProcess({ stderr: "error", exitCode: 1 }));
    const result = await runWlCommand(["show"]);
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeInstanceOf(WlError);
    expect((result.error as WlError).code).toBe("NON_ZERO_EXIT");
  });

  it("handles timeout", async () => {
    // Process never closes; we simulate by not emitting close within timeout
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    mockedSpawn.mockImplementation(() => proc);
    const result = await runWlCommand(["list"], { timeoutMs: 10 });
    expect(result.error).toBeInstanceOf(WlError);
    expect((result.error as WlError).code).toBe("TIMEOUT");
  });

  it("emits events", async () => {
    const events: string[] = [];
    wlEvents.on("command:start", () => events.push("start"));
    wlEvents.on("command:success", () => events.push("success"));
    mockedSpawn.mockImplementation(() =>
      mockProcess({ stdout: "{}", exitCode: 0 })
    );
    await runWlCommand(["list"]);
    expect(events).toEqual(["start", "success"]);
  });

  it("retries on timeout and succeeds", async () => {
    let callCount = 0;
    mockedSpawn.mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        // First two calls: process never emits close (simulates timeout)
        const proc = new EventEmitter() as any;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = vi.fn();
        return proc;
      }
      // Third call: succeeds
      return mockProcess({ stdout: '{"ok":true}', exitCode: 0 });
    });
    const result = await runWlCommand(["list", "--json"], {
      timeoutMs: 10,
      retries: 3,
      retryDelayMs: 5,
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({ ok: true });
    expect(result.error).toBeUndefined();
    expect(callCount).toBe(3);
    expect(result.attempts).toBe(3);
  });

  it("exhausts retries on timeout", async () => {
    mockedSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      return proc;
    });
    const result = await runWlCommand(["list"], {
      timeoutMs: 10,
      retries: 2,
      retryDelayMs: 5,
    });
    expect(result.error).toBeInstanceOf(WlError);
    expect((result.error as WlError).code).toBe("TIMEOUT");
    expect(result.attempts).toBe(3); // initial + 2 retries
  });

  it("retries on JSON parse error and succeeds", async () => {
    let callCount = 0;
    mockedSpawn.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call: malformed JSON
        return mockProcess({ stdout: '{bad json', exitCode: 0 });
      }
      // Second call: valid JSON
      return mockProcess({ stdout: '{"recovered":true}', exitCode: 0 });
    });
    const result = await runWlCommand(["list", "--json"], {
      retries: 2,
      retryDelayMs: 5,
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({ recovered: true });
    expect(result.error).toBeUndefined();
    expect(callCount).toBe(2);
  });

  it("does not retry on NON_ZERO_EXIT", async () => {
    mockedSpawn.mockImplementation(() =>
      mockProcess({ stderr: "error", exitCode: 1 })
    );
    const result = await runWlCommand(["list", "--json"], {
      retries: 3,
      retryDelayMs: 5,
    });
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeInstanceOf(WlError);
    expect((result.error as WlError).code).toBe("NON_ZERO_EXIT");
    expect(result.attempts).toBe(1); // no retries
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
  });

  it("parses last complete JSON object from malformed output", async () => {
    mockedSpawn.mockImplementation(() =>
      mockProcess({
        stdout: 'some garbage\n{"valid":true}\nmore garbage',
        exitCode: 0,
      })
    );
    const result = await runWlCommand(["list", "--json"]);
    expect(result.json).toEqual({ valid: true });
    expect(result.error).toBeUndefined();
  });

  it("parses last JSON line from multi-line output", async () => {
    mockedSpawn.mockImplementation(() =>
      mockProcess({
        stdout: 'log line 1\nlog line 2\n{"final":"result"}',
        exitCode: 0,
      })
    );
    const result = await runWlCommand(["list", "--json"]);
    expect(result.json).toEqual({ final: "result" });
    expect(result.error).toBeUndefined();
  });

  it("returns JSON_PARSE error when no valid JSON found", async () => {
    mockedSpawn.mockImplementation(() =>
      mockProcess({
        stdout: 'this is not json at all',
        exitCode: 0,
      })
    );
    const result = await runWlCommand(["list", "--json"]);
    expect(result.error).toBeInstanceOf(WlError);
    expect((result.error as WlError).code).toBe("JSON_PARSE");
    expect(result.json).toBeUndefined();
  });

  it("reports attempts count on non-retryable error", async () => {
    mockedSpawn.mockImplementation(() =>
      mockProcess({ stderr: "fail", exitCode: 2 })
    );
    const result = await runWlCommand(["list", "--json"], { retries: 3 });
    expect(result.attempts).toBe(1);
  });
});
