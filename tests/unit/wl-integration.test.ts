// tests/unit/wl-integration.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import * as cp from "child_process";
import { runWlCommand, wlEvents, WlError } from "../../src/wl-integration/spawn";

// Mock child_process.spawn
vi.mock("child_process", async () => {
  const actual = await vi.importActual("child_process");
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const mockedSpawn = cp.spawn as unknown as vi.Mock;

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
});
