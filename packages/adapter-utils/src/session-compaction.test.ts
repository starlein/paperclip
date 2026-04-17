import { describe, it, expect } from "vitest";
import {
  getAdapterSessionManagement,
  readSessionCompactionOverride,
  resolveSessionCompactionPolicy,
  hasSessionCompactionThresholds,
  LEGACY_SESSIONED_ADAPTER_TYPES,
} from "./session-compaction.js";

// ============================================================================
// getAdapterSessionManagement
// ============================================================================

describe("getAdapterSessionManagement", () => {
  it("returns null for null input", () => {
    expect(getAdapterSessionManagement(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(getAdapterSessionManagement(undefined)).toBeNull();
  });

  it("returns null for unknown adapter types", () => {
    expect(getAdapterSessionManagement("unknown_adapter")).toBeNull();
  });

  it("returns session management for 'claude_local'", () => {
    const result = getAdapterSessionManagement("claude_local");
    expect(result).not.toBeNull();
    expect(result?.supportsSessionResume).toBe(true);
    expect(result?.nativeContextManagement).toBe("confirmed");
  });

  it("returns session management for 'codex_local'", () => {
    const result = getAdapterSessionManagement("codex_local");
    expect(result).not.toBeNull();
    expect(result?.supportsSessionResume).toBe(true);
  });
});

// ============================================================================
// LEGACY_SESSIONED_ADAPTER_TYPES
// ============================================================================

describe("LEGACY_SESSIONED_ADAPTER_TYPES", () => {
  it("includes claude_local", () => {
    expect(LEGACY_SESSIONED_ADAPTER_TYPES.has("claude_local")).toBe(true);
  });

  it("includes codex_local", () => {
    expect(LEGACY_SESSIONED_ADAPTER_TYPES.has("codex_local")).toBe(true);
  });

  it("does not include unknown types", () => {
    expect(LEGACY_SESSIONED_ADAPTER_TYPES.has("unknown")).toBe(false);
  });
});

// ============================================================================
// readSessionCompactionOverride
// ============================================================================

describe("readSessionCompactionOverride", () => {
  it("returns empty object for null runtimeConfig", () => {
    expect(readSessionCompactionOverride(null)).toEqual({});
  });

  it("returns empty object for missing compaction config", () => {
    expect(readSessionCompactionOverride({ other: "value" })).toEqual({});
  });

  it("reads enabled from heartbeat.sessionCompaction", () => {
    const result = readSessionCompactionOverride({
      heartbeat: { sessionCompaction: { enabled: "true" } },
    });
    expect(result.enabled).toBe(true);
  });

  it("reads enabled=false from string 'false'", () => {
    const result = readSessionCompactionOverride({
      heartbeat: { sessionCompaction: { enabled: "false" } },
    });
    expect(result.enabled).toBe(false);
  });

  it("reads enabled=false from string '0'", () => {
    const result = readSessionCompactionOverride({
      heartbeat: { sessionCompaction: { enabled: "0" } },
    });
    expect(result.enabled).toBe(false);
  });

  it("reads maxSessionRuns from numeric value", () => {
    const result = readSessionCompactionOverride({
      heartbeat: { sessionCompaction: { maxSessionRuns: 50 } },
    });
    expect(result.maxSessionRuns).toBe(50);
  });

  it("reads maxSessionRuns from string '50'", () => {
    const result = readSessionCompactionOverride({
      heartbeat: { sessionCompaction: { maxSessionRuns: "50" } },
    });
    expect(result.maxSessionRuns).toBe(50);
  });

  it("clamps negative maxSessionRuns to 0", () => {
    const result = readSessionCompactionOverride({
      heartbeat: { sessionCompaction: { maxSessionRuns: -5 } },
    });
    expect(result.maxSessionRuns).toBe(0);
  });

  it("reads from legacy heartbeat.sessionRotation key", () => {
    const result = readSessionCompactionOverride({
      heartbeat: { sessionRotation: { enabled: true } },
    });
    expect(result.enabled).toBe(true);
  });

  it("reads from top-level sessionCompaction key as fallback", () => {
    const result = readSessionCompactionOverride({
      sessionCompaction: { maxRawInputTokens: 1000000 },
    });
    expect(result.maxRawInputTokens).toBe(1000000);
  });

  it("floors fractional maxSessionRuns", () => {
    const result = readSessionCompactionOverride({
      heartbeat: { sessionCompaction: { maxSessionRuns: 7.9 } },
    });
    expect(result.maxSessionRuns).toBe(7);
  });

  it("ignores non-numeric non-string maxSessionRuns values", () => {
    const result = readSessionCompactionOverride({
      heartbeat: { sessionCompaction: { maxSessionRuns: {} } },
    });
    expect(result.maxSessionRuns).toBeUndefined();
  });
});

// ============================================================================
// resolveSessionCompactionPolicy
// ============================================================================

describe("resolveSessionCompactionPolicy", () => {
  it("uses adapter_default source for known adapters without override", () => {
    const result = resolveSessionCompactionPolicy("claude_local", null);
    expect(result.source).toBe("adapter_default");
    expect(result.adapterSessionManagement).not.toBeNull();
    expect(result.explicitOverride).toEqual({});
  });

  it("uses agent_override source when explicit overrides are present", () => {
    const result = resolveSessionCompactionPolicy("claude_local", {
      heartbeat: { sessionCompaction: { maxSessionRuns: 10 } },
    });
    expect(result.source).toBe("agent_override");
    expect(result.policy.maxSessionRuns).toBe(10);
  });

  it("uses legacy_fallback for unknown adapters with no override", () => {
    const result = resolveSessionCompactionPolicy("custom_adapter", null);
    expect(result.source).toBe("legacy_fallback");
    expect(result.adapterSessionManagement).toBeNull();
  });

  it("enables compaction for legacy sessioned adapter types", () => {
    const result = resolveSessionCompactionPolicy("claude_local", null);
    expect(result.policy.enabled).toBe(true);
  });

  it("disables compaction for unknown adapters (not in legacy set)", () => {
    const result = resolveSessionCompactionPolicy("non_legacy_adapter", null);
    expect(result.policy.enabled).toBe(false);
  });

  it("explicit override takes precedence over adapter default", () => {
    const result = resolveSessionCompactionPolicy("claude_local", {
      heartbeat: { sessionCompaction: { enabled: false } },
    });
    expect(result.policy.enabled).toBe(false);
  });

  it("returns null adapterSessionManagement for null adapter type", () => {
    const result = resolveSessionCompactionPolicy(null, null);
    expect(result.adapterSessionManagement).toBeNull();
  });
});

// ============================================================================
// hasSessionCompactionThresholds
// ============================================================================

describe("hasSessionCompactionThresholds", () => {
  it("returns false when all thresholds are 0", () => {
    expect(
      hasSessionCompactionThresholds({ maxSessionRuns: 0, maxRawInputTokens: 0, maxSessionAgeHours: 0 }),
    ).toBe(false);
  });

  it("returns true when maxSessionRuns is positive", () => {
    expect(
      hasSessionCompactionThresholds({ maxSessionRuns: 10, maxRawInputTokens: 0, maxSessionAgeHours: 0 }),
    ).toBe(true);
  });

  it("returns true when maxRawInputTokens is positive", () => {
    expect(
      hasSessionCompactionThresholds({ maxSessionRuns: 0, maxRawInputTokens: 1000000, maxSessionAgeHours: 0 }),
    ).toBe(true);
  });

  it("returns true when maxSessionAgeHours is positive", () => {
    expect(
      hasSessionCompactionThresholds({ maxSessionRuns: 0, maxRawInputTokens: 0, maxSessionAgeHours: 24 }),
    ).toBe(true);
  });
});
