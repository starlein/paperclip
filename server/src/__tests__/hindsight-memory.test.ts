import { describe, expect, it, vi } from "vitest";
import {
  HINDSIGHT_MEMORY_CONTEXT_KEY,
  buildHindsightMemoryPromptSection,
  injectHindsightMemoryContext,
  waitForHindsightRecalledMemory,
} from "../services/hindsight-memory.js";

describe("Hindsight memory context injection", () => {
  it("formats recalled memories with a clear prompt header", () => {
    const promptSection = buildHindsightMemoryPromptSection("- User prefers German\n- Use PR template");

    expect(promptSection).toContain("Relevant long-term memory from Hindsight");
    expect(promptSection).toContain("- User prefers German");
    expect(promptSection).toContain("- Use PR template");
  });

  it("injects formatted memories into the adapter context", () => {
    const context: Record<string, unknown> = { issueId: "issue-1" };

    const injected = injectHindsightMemoryContext(context, "- Remember the previous decision");

    expect(injected).toBe(true);
    expect(context[HINDSIGHT_MEMORY_CONTEXT_KEY]).toContain("Remember the previous decision");
  });

  it("ignores empty or non-string recalled state", () => {
    const context: Record<string, unknown> = { issueId: "issue-1" };

    expect(injectHindsightMemoryContext(context, "   ")).toBe(false);
    expect(injectHindsightMemoryContext(context, { content: "not the worker state shape" })).toBe(false);
    expect(context[HINDSIGHT_MEMORY_CONTEXT_KEY]).toBeUndefined();
  });

  it("polls recalled plugin state before giving up", async () => {
    const lookup = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("- prior context");
    const sleep = vi.fn(async () => undefined);
    let now = 0;

    const recalled = await waitForHindsightRecalledMemory({
      lookup,
      timeoutMs: 250,
      intervalMs: 50,
      sleep,
      now: () => {
        now += 50;
        return now;
      },
    });

    expect(recalled).toBe("- prior context");
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
