import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runChildProcess } = vi.hoisted(() => ({ runChildProcess: vi.fn() }));
vi.mock("@paperclipai/adapter-utils/server-utils", async () => ({
  ...await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>("@paperclipai/adapter-utils/server-utils"),
  runChildProcess,
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
}));
import { execute } from "./execute.js";

const exhausted = "Codex ran out of room in the model's context window. Start a new thread or clear earlier history.";
const unknown = "state db missing rollout path for thread old-thread";
const started = JSON.stringify({ type: "thread.started", thread_id: "resumed-thread" });
const roots: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runResume(input: { message: string; started?: boolean; timedOut?: boolean; signal?: string | null }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-retry-"));
  roots.push(root);
  const home = path.join(root, "codex-home");
  await mkdir(home);
  await writeFile(path.join(home, "auth.json"), '{"OPENAI_API_KEY":"sk-test"}');
  const base = { signal: null, timedOut: false, pid: 321, startedAt: new Date().toISOString() };
  runChildProcess.mockResolvedValueOnce({
    ...base, exitCode: 1, signal: input.signal ?? null, timedOut: input.timedOut ?? false,
    stdout: [input.started === false ? "" : started, JSON.stringify({ type: "error", message: input.message })].filter(Boolean).join("\n"),
    stderr: input.message,
  }).mockResolvedValueOnce({
    ...base, exitCode: 0, stderr: "",
    stdout: JSON.stringify({ type: "thread.started", thread_id: "fresh-thread" }) + "\n" + JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  return execute({
    runId: "run-retry", agent: { id: "agent-1", companyId: "company-1", name: "Codex", adapterType: "codex_local", adapterConfig: {} },
    runtime: { sessionId: "resumed-thread", sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: "codex", engine: "cli", env: { CODEX_HOME: home } },
    context: { paperclipWorkspace: { cwd: root, source: "project_primary" } },
    onLog: async () => {},
  });
}

describe("Codex resumed-session retry process boundary", () => {
  it("retries context exhaustion after thread.started with a fresh invocation", async () => {
    const result = await runResume({ message: exhausted });
    expect(runChildProcess).toHaveBeenCalledTimes(2);
    expect(runChildProcess.mock.calls[0][2]).toContain("resume");
    expect(runChildProcess.mock.calls[0][2]).toContain("resumed-thread");
    expect(runChildProcess.mock.calls[1][2]).not.toContain("resume");
    expect(runChildProcess.mock.calls[1][2]).not.toContain("resumed-thread");
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("fresh-thread");
  });

  it("does not retry unknown-session warnings after thread.started", async () => {
    await runResume({ message: unknown });
    expect(runChildProcess).toHaveBeenCalledTimes(1);
  });

  it("still retries an unknown session before thread.started", async () => {
    await runResume({ message: unknown, started: false });
    expect(runChildProcess).toHaveBeenCalledTimes(2);
  });

  it.each([{ timedOut: true }, { signal: "SIGINT" }, { signal: "SIGTERM" }])(
    "does not retry context exhaustion when terminated: %j", async (termination) => {
      await runResume({ message: exhausted, ...termination });
      expect(runChildProcess).toHaveBeenCalledTimes(1);
    },
  );
});
