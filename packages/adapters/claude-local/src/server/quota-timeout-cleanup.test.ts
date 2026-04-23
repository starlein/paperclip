import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  return {
    ...cp,
    spawn: (...args: Parameters<typeof cp.spawn>) => mockSpawn(...args) as ReturnType<typeof cp.spawn>,
  };
});

import { captureClaudeCliUsageText } from "./quota.js";

function createHangingChild(pid: number): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdin = {
    destroyed: false,
    writableEnded: false,
    write: vi.fn(),
    end: vi.fn(() => {
      stdin.writableEnded = true;
    }),
  };

  Object.assign(child, {
    pid,
    stdin,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });

  return child;
}

describe("captureClaudeCliUsageText timeout cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSpawn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("kills the spawned script process group when the probe times out", async () => {
    const child = createHangingChild(4321);
    mockSpawn.mockReturnValue(child);

    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: "SIGTERM" | "SIGKILL") => {
      if (Math.abs(pid) === 4321 && signal === "SIGTERM") {
        queueMicrotask(() => {
          (child as unknown as EventEmitter).emit("close", 0, signal ?? null);
        });
      }
      return true;
    }) as typeof process.kill);

    const promise = captureClaudeCliUsageText(25);
    await vi.advanceTimersByTimeAsync(30);

    await expect(promise).rejects.toThrow("Claude CLI usage probe ended before rendering usage.");

    const expectedPid = process.platform === "win32" ? 4321 : -4321;
    expect(killSpy).toHaveBeenCalledWith(expectedPid, "SIGTERM");
    expect(mockSpawn).toHaveBeenCalledWith(
      "script",
      expect.any(Array),
      expect.objectContaining({
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  });
});
