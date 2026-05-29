import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
  vi.resetModules();
});

describe("loadConfig heartbeat scheduler interval", () => {
  it("interprets HEARTBEAT_SCHEDULER_INTERVAL_MS as seconds", async () => {
    process.env.PAPERCLIP_CONFIG = "/tmp/non-existent-paperclip-config.json";
    process.env.HEARTBEAT_SCHEDULER_INTERVAL_MS = "30";

    const { loadConfig } = await import("../config.js");
    const config = loadConfig();

    expect(config.heartbeatSchedulerIntervalMs).toBe(30_000);
  });

  it("keeps legacy millisecond values >= 1000 for backward compatibility", async () => {
    process.env.PAPERCLIP_CONFIG = "/tmp/non-existent-paperclip-config.json";
    process.env.HEARTBEAT_SCHEDULER_INTERVAL_MS = "30000";

    const { loadConfig } = await import("../config.js");
    const config = loadConfig();

    expect(config.heartbeatSchedulerIntervalMs).toBe(30_000);
  });
});
