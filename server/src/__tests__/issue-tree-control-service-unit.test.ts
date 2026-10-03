import { describe, expect, it, vi } from "vitest";
import {
  isPendingInteractionAddresseeWake,
  isVerifiedIssueTreeControlInteractionWake,
  issueTreeControlService,
} from "../services/issue-tree-control.js";

function emptySelectDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([])),
        })),
      })),
    })),
  };
}

describe("issueTreeControlService unit guards", () => {
  it("locks both the interaction and issue rows when revalidating a claim", async () => {
    const interaction = {
      id: "interaction-claim",
      companyId: "company-1",
      issueId: "issue-1",
      addresseeAgentId: "security-agent",
      status: "pending",
      kind: "request_item_verdicts",
      payload: { version: 1, prompt: "Review?", items: [] },
      effectiveResolverPolicy: "anyone",
      requestedResolverPolicy: "anyone",
      createdByAgentId: "implementation-agent",
      createdByUserId: null,
      sourceRunId: null,
    };
    const issue = {
      id: "issue-1",
      companyId: "company-1",
      status: "in_review",
      reviewPolicy: "anyone",
      createdByAgentId: "implementation-agent",
      createdByUserId: null,
    };
    const rowBatches = [[issue], [interaction]];
    let forUpdateCalls = 0;
    const select = vi.fn(() => {
      const rows = rowBatches.shift() ?? [];
      const chain: any = {
        from: () => chain,
        where: () => chain,
        limit: () => chain,
        for: () => {
          forUpdateCalls += 1;
          return Promise.resolve(rows);
        },
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
      };
      return chain;
    });

    await expect(isPendingInteractionAddresseeWake({ select } as any, {
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "security-agent",
      contextSnapshot: {
        wakeReason: "interaction_pending",
        interactionId: "interaction-claim",
      },
    }, true)).resolves.toBe(true);
    expect(forUpdateCalls).toBe(2);
  });

  it("accepts a pending interaction wake only for its authorized addressee", async () => {
    const interaction: any = {
      id: "interaction-1",
      companyId: "company-1",
      issueId: "issue-1",
      kind: "request_item_verdicts",
      status: "pending",
      addresseeAgentId: "security-agent",
      effectiveResolverPolicy: "anyone",
      payload: {
        version: 1,
        prompt: "Review the exact PR head.",
        items: [{ id: "security", label: "Security boundary" }],
        verdicts: ["approve", "reject", "defer"],
      },
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([interaction])),
          })),
        })),
      })),
    };

    await expect(isVerifiedIssueTreeControlInteractionWake(db as any, {
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "security-agent",
      contextSnapshot: {
        wakeReason: "interaction_pending",
        interactionId: "interaction-1",
      },
    })).resolves.toBe(true);

    interaction.effectiveResolverPolicy = "human_only";
    await expect(isVerifiedIssueTreeControlInteractionWake(db as any, {
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "security-agent",
      contextSnapshot: {
        wakeReason: "interaction_pending",
        interactionId: "interaction-1",
      },
    })).resolves.toBe(false);

    interaction.effectiveResolverPolicy = "anyone";
    interaction.kind = "request_confirmation";
    interaction.payload = {
      version: 1,
      prompt: "Materialize this secret?",
      secretProposal: { secretRef: "secret-1" },
    };
    await expect(isVerifiedIssueTreeControlInteractionWake(db as any, {
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "security-agent",
      contextSnapshot: {
        wakeReason: "interaction_pending",
        interactionId: "interaction-1",
      },
    })).resolves.toBe(false);
  });

  it("keeps issue review policy restrictions on interaction addressee wakes", async () => {
    const interaction = {
      id: "interaction-review",
      companyId: "company-1",
      issueId: "issue-1",
      addresseeAgentId: "security-agent",
      status: "pending",
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Approve review?" },
      effectiveResolverPolicy: "anyone",
      requestedResolverPolicy: "anyone",
      createdByAgentId: "implementation-agent",
      createdByUserId: null,
      sourceRunId: null,
    };
    const issue = {
      id: "issue-1",
      companyId: "company-1",
      status: "in_review",
      reviewPolicy: "human_only",
      createdByAgentId: "implementation-agent",
      createdByUserId: null,
    };
    const rowBatches = [[issue], [interaction], []];
    const select = vi.fn(() => {
      const rows = rowBatches.shift() ?? [];
      const chain: any = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(rows),
      };
      return chain;
    });

    await expect(isVerifiedIssueTreeControlInteractionWake({ select } as any, {
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "security-agent",
      contextSnapshot: {
        wakeReason: "interaction_pending",
        interactionId: "interaction-review",
      },
    })).resolves.toBe(false);
    expect(select).toHaveBeenCalledTimes(3);
  });

  it("rejects cross-company roots before traversing descendants", async () => {
    const db = emptySelectDb();
    const svc = issueTreeControlService(db as any);

    await expect(svc.preview("company-2", "issue-from-company-1", { mode: "pause" })).rejects.toMatchObject({
      status: 404,
    });
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
