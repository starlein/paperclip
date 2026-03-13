import { describe, expect, it } from "vitest";
import { applyCreateDefaultsByAdapterType } from "../routes/agents.js";

describe("applyCreateDefaultsByAdapterType", () => {
  it("defaults claude_local agents to skipping permission prompts", () => {
    const config = applyCreateDefaultsByAdapterType("claude_local", {});

    expect(config.dangerouslySkipPermissions).toBe(true);
  });
});
