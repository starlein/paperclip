import { describe, it, expect } from "vitest";
import {
  isClosedIsolatedExecutionWorkspace,
  getClosedIsolatedExecutionWorkspaceMessage,
} from "./execution-workspace-guards.js";

// ============================================================================
// isClosedIsolatedExecutionWorkspace
// ============================================================================

describe("isClosedIsolatedExecutionWorkspace", () => {
  const base = {
    mode: "isolated_workspace" as const,
    status: "active" as const,
    closedAt: null,
  };

  it("returns false for null", () => {
    expect(isClosedIsolatedExecutionWorkspace(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isClosedIsolatedExecutionWorkspace(undefined)).toBe(false);
  });

  it("returns false when mode is not isolated_workspace", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({ ...base, mode: "shared_workspace" })
    ).toBe(false);
  });

  it("returns false when mode is operator_branch", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({ ...base, mode: "operator_branch" })
    ).toBe(false);
  });

  it("returns false when isolated and status is active with no closedAt", () => {
    expect(isClosedIsolatedExecutionWorkspace(base)).toBe(false);
  });

  it("returns false when isolated and status is idle with no closedAt", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({ ...base, status: "idle" })
    ).toBe(false);
  });

  it("returns false when isolated and status is in_review with no closedAt", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({ ...base, status: "in_review" })
    ).toBe(false);
  });

  it("returns true when isolated and status is archived", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({ ...base, status: "archived" })
    ).toBe(true);
  });

  it("returns true when isolated and status is cleanup_failed", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({ ...base, status: "cleanup_failed" })
    ).toBe(true);
  });

  it("returns true when isolated and closedAt is a Date object", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({ ...base, closedAt: new Date("2024-01-01T00:00:00Z") })
    ).toBe(true);
  });

  it("returns true when isolated and closedAt is today's date", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({ ...base, closedAt: new Date() })
    ).toBe(true);
  });

  it("returns true when both closedAt is set and status is archived", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({
        ...base,
        closedAt: new Date("2024-01-01T00:00:00Z"),
        status: "archived",
      })
    ).toBe(true);
  });

  it("returns false when non-isolated with closed status (mode takes priority)", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({
        ...base,
        mode: "shared_workspace",
        status: "archived",
      })
    ).toBe(false);
  });

  it("returns false when non-isolated with closedAt set", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({
        ...base,
        mode: "shared_workspace",
        closedAt: new Date("2024-01-01T00:00:00Z"),
      })
    ).toBe(false);
  });
});

// ============================================================================
// getClosedIsolatedExecutionWorkspaceMessage
// ============================================================================

describe("getClosedIsolatedExecutionWorkspaceMessage", () => {
  it("returns a message containing the workspace name", () => {
    const msg = getClosedIsolatedExecutionWorkspaceMessage({ name: "my-workspace" });
    expect(msg).toContain("my-workspace");
  });

  it("wraps workspace name in quotes", () => {
    const msg = getClosedIsolatedExecutionWorkspaceMessage({ name: "feature-branch" });
    expect(msg).toContain('"feature-branch"');
  });

  it("mentions 'closed workspace'", () => {
    const msg = getClosedIsolatedExecutionWorkspaceMessage({ name: "ws" });
    expect(msg).toMatch(/closed workspace/i);
  });

  it("mentions moving to an open workspace", () => {
    const msg = getClosedIsolatedExecutionWorkspaceMessage({ name: "ws" });
    expect(msg).toMatch(/open workspace/i);
  });

  it("works with an empty name string", () => {
    const msg = getClosedIsolatedExecutionWorkspaceMessage({ name: "" });
    expect(msg).toContain('""');
  });

  it("works with a name containing special characters", () => {
    const msg = getClosedIsolatedExecutionWorkspaceMessage({ name: "ws/feature-123" });
    expect(msg).toContain('"ws/feature-123"');
  });
});
