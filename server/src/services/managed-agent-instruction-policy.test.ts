import { describe, expect, it } from "vitest";
import {
  authoritativeImplementationPrLimit,
  reconcileManagedAgentInstructionPolicy,
} from "./managed-agent-instruction-policy.js";

describe("managed agent instruction policy", () => {
  it("keeps the company PR cap authoritative over a stale Release DevOps default", () => {
    const result = reconcileManagedAgentInstructionPolicy({
      agentInstructions: [
        "# Release DevOps",
        "",
        "- WIP limit: drive each repository to at most two open implementation PRs.",
        "- Preserve repository-scoped PR identity.",
      ].join("\n"),
      companyInstructions: [
        "# Company delivery policy",
        "",
        "- Enforce a WIP limit of at most 5 open implementation PRs per repository.",
      ].join("\n"),
    });

    expect(result).toMatchObject({
      changed: true,
      authoritativeLimit: 5,
      replacedLimits: [2],
    });
    expect(result.content).toContain("at most 5 open implementation PRs");
    expect(result.content).not.toContain("at most two open implementation PRs");
    expect(result.content).toContain("Preserve repository-scoped PR identity.");
  });

  it("is idempotent after the company policy has been applied", () => {
    const companyInstructions = "Enforce at most five open implementation PRs.";
    const first = reconcileManagedAgentInstructionPolicy({
      agentInstructions: "Drive each repository to at most 2 open implementation PRs.",
      companyInstructions,
    });
    const second = reconcileManagedAgentInstructionPolicy({
      agentInstructions: first.content,
      companyInstructions,
    });

    expect(second).toMatchObject({ changed: false, authoritativeLimit: 5 });
    expect(second.content).toBe(first.content);
  });

  it("fails closed when the governing instructions contradict themselves", () => {
    expect(() => authoritativeImplementationPrLimit([
      "Enforce at most 5 open implementation PRs.",
      "Elsewhere enforce at most two open implementation PRs.",
    ].join("\n"))).toThrow("contradictory implementation PR limits: 5, 2");
  });
});
