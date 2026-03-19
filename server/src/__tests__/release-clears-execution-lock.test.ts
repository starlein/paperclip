import { describe, expect, it } from "vitest";
import { issueService } from "../services/issues.js";

/**
 * Regression test: release() must clear executionRunId, executionLockedAt,
 * and executionAgentNameKey alongside checkoutRunId.
 *
 * Before the fix (DLD-149), release() only cleared checkoutRunId, leaving
 * stale execution lock fields that prevented subsequent heartbeat runs from
 * checking out the issue.
 */

function makeFakeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    status: "in_progress",
    assigneeAgentId: "agent-1",
    checkoutRunId: "run-1",
    executionRunId: "run-1",
    executionLockedAt: new Date("2026-03-16T00:00:00Z"),
    executionAgentNameKey: "founding engineer",
    ...overrides,
  };
}

/**
 * Build a minimal mock that implements the drizzle query-builder chain
 * used by release(): db.select().from().where().then() for the read,
 * and db.update().set().where().returning().then() for the write.
 *
 * Captures the `.set()` argument so we can assert on it.
 */
function createMockDb(existingIssue: Record<string, unknown>) {
  let capturedSet: Record<string, unknown> | null = null;

  const updatedIssue = {
    ...existingIssue,
    status: "todo",
    assigneeAgentId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionLockedAt: null,
    executionAgentNameKey: null,
  };

  // Terminal node that resolves any chained query to an empty array
  const emptyChain: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (fn: (rows: unknown[]) => unknown) => Promise.resolve(fn([]));
        return () => emptyChain;
      },
    },
  );

  const db = {
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        // The first select().from(issues).where() is the existence check in release()
        // Subsequent select().from(issueLabels)... chains are from withIssueLabels
        const fromResult: any = {
          where: (..._args: unknown[]) => ({
            then: (fn: (rows: unknown[]) => unknown) => Promise.resolve(fn([existingIssue])),
          }),
          innerJoin: () => emptyChain,
          leftJoin: () => emptyChain,
        };
        return fromResult;
      },
    }),
    update: () => ({
      set: (fields: Record<string, unknown>) => {
        capturedSet = fields;
        return {
          where: () => ({
            returning: () => ({
              then: (fn: (rows: unknown[]) => unknown) =>
                Promise.resolve(fn([updatedIssue])),
            }),
          }),
        };
      },
    }),
  };

  return { db, getCapturedSet: () => capturedSet };
}

describe("release() clears execution lock fields", () => {
  it("clears executionRunId, executionLockedAt, and executionAgentNameKey", async () => {
    const fakeIssue = makeFakeIssue();
    const { db, getCapturedSet } = createMockDb(fakeIssue);

    const svc = issueService(db as any);
    const result = await svc.release("issue-1", "agent-1", "run-1");

    const setFields = getCapturedSet();
    expect(setFields).not.toBeNull();

    // Core assertion: execution lock fields must be explicitly cleared
    expect(setFields).toHaveProperty("executionRunId", null);
    expect(setFields).toHaveProperty("executionLockedAt", null);
    expect(setFields).toHaveProperty("executionAgentNameKey", null);

    // checkoutRunId should also be cleared (pre-existing behavior)
    expect(setFields).toHaveProperty("checkoutRunId", null);

    // assigneeAgentId reset and status revert to todo
    expect(setFields).toHaveProperty("assigneeAgentId", null);
    expect(setFields).toHaveProperty("status", "todo");
  });

  it("returns the released issue with cleared fields", async () => {
    const fakeIssue = makeFakeIssue();
    const { db } = createMockDb(fakeIssue);

    const svc = issueService(db as any);
    const result = await svc.release("issue-1", "agent-1", "run-1");

    expect(result).not.toBeNull();
    expect(result!.executionRunId).toBeNull();
    expect(result!.executionLockedAt).toBeNull();
    expect(result!.executionAgentNameKey).toBeNull();
    expect(result!.checkoutRunId).toBeNull();
    expect(result!.status).toBe("todo");
  });
});
