import { describe, expect, it } from "vitest";

const NOW = new Date("2026-04-01T00:10:00Z");

const {
  isDispatchableAgent,
  classifyIssueDispatch,
  detectStrandedAssignments,
  detectMiscategorizedRtaaTasks,
  summarizeByStatus,
  formatWatchdogReport,
} = await import("../../../scripts/pipeline-watchdog.mjs");

describe("pipeline watchdog", () => {
  const runningAgent = {
    id: "agent-running",
    name: "Runner",
    status: "running",
    pauseReason: null,
  };
  const idleAgent = {
    id: "agent-idle",
    name: "Idle",
    status: "idle",
    pauseReason: null,
  };
  const pausedAgent = {
    id: "agent-paused",
    name: "Paused",
    status: "paused",
    pauseReason: "manual",
  };

  const terminatedAgent = {
    id: "agent-terminated",
    name: "Terminated",
    status: "terminated",
    pauseReason: null,
  };
  const pendingApprovalAgent = {
    id: "agent-pending",
    name: "PendingApproval",
    status: "pending_approval",
    pauseReason: null,
  };

  it("treats idle agents as dispatchable and paused/terminated/pending_approval as non-dispatchable", () => {
    expect(isDispatchableAgent(idleAgent)).toBe(true);
    expect(isDispatchableAgent(runningAgent)).toBe(true);
    expect(isDispatchableAgent(pausedAgent)).toBe(false);
    expect(isDispatchableAgent(terminatedAgent)).toBe(false);
    expect(isDispatchableAgent(pendingApprovalAgent)).toBe(false);
    expect(isDispatchableAgent({ id: "err", name: "Err", status: "error", pauseReason: null })).toBe(false);
    expect(isDispatchableAgent(null)).toBe(false);
  });

  it("classifies actionable issues with no pickup", () => {
    const issue = {
      identifier: "DLD-1",
      status: "in_progress",
      assigneeAgentId: idleAgent.id,
      assigneeUserId: null,
      executionRunId: null,
      checkoutRunId: null,
      updatedAt: "2026-04-01T00:00:00Z",
    };
    expect(classifyIssueDispatch(issue, idleAgent, { now: NOW })).toBe("actionable-no-pickup");
    expect(classifyIssueDispatch({ ...issue, updatedAt: "2026-04-01T00:09:30Z" }, idleAgent, { now: NOW })).toBe("within-grace-window");
    expect(classifyIssueDispatch(issue, runningAgent, { now: NOW })).toBe("running-without-run-id");
    expect(classifyIssueDispatch(issue, pausedAgent, { now: NOW })).toBe("non-dispatchable-agent");
    expect(classifyIssueDispatch({ ...issue, status: "blocked" }, idleAgent, { now: NOW })).toBe("blocked-awaiting-unblock");
    expect(classifyIssueDispatch({ ...issue, assigneeAgentId: null, assigneeUserId: "user-1", status: "in_review" }, null, { now: NOW })).toBe("assigned-user-review");
  });

  it("classifies dispatched issues (with run IDs)", () => {
    const issue = {
      identifier: "DLD-10",
      status: "in_progress",
      assigneeAgentId: idleAgent.id,
      assigneeUserId: null,
      executionRunId: "run-123",
      checkoutRunId: null,
      updatedAt: "2026-04-01T00:00:00Z",
    };
    expect(classifyIssueDispatch(issue, idleAgent, { now: NOW })).toBe("dispatched");
    expect(classifyIssueDispatch({ ...issue, executionRunId: null, checkoutRunId: "run-456" }, idleAgent, { now: NOW })).toBe("dispatched");
  });

  it("classifies unassigned and blocked-unassigned issues", () => {
    const base = {
      identifier: "DLD-11",
      assigneeAgentId: null,
      assigneeUserId: null,
      executionRunId: null,
      checkoutRunId: null,
      updatedAt: "2026-04-01T00:00:00Z",
    };
    expect(classifyIssueDispatch({ ...base, status: "todo" }, null, { now: NOW })).toBe("unassigned");
    expect(classifyIssueDispatch({ ...base, status: "blocked" }, null, { now: NOW })).toBe("blocked-unassigned");
  });

  it("classifies unknown-agent when agent not in map", () => {
    const issue = {
      identifier: "DLD-12",
      status: "in_progress",
      assigneeAgentId: "nonexistent-agent",
      assigneeUserId: null,
      executionRunId: null,
      checkoutRunId: null,
      updatedAt: "2026-04-01T00:00:00Z",
    };
    expect(classifyIssueDispatch(issue, null, { now: NOW })).toBe("unknown-agent");
  });

  it("classifies assigned-user for non-review human assignment", () => {
    const issue = {
      identifier: "DLD-13",
      status: "in_progress",
      assigneeAgentId: null,
      assigneeUserId: "user-1",
      executionRunId: null,
      checkoutRunId: null,
      updatedAt: "2026-04-01T00:00:00Z",
    };
    expect(classifyIssueDispatch(issue, null, { now: NOW })).toBe("assigned-user");
  });

  it("classifies awaiting-review-pickup for in_review agent issues", () => {
    const issue = {
      identifier: "DLD-14",
      status: "in_review",
      assigneeAgentId: idleAgent.id,
      assigneeUserId: null,
      executionRunId: null,
      checkoutRunId: null,
      updatedAt: "2026-04-01T00:00:00Z",
    };
    expect(classifyIssueDispatch(issue, idleAgent, { now: NOW })).toBe("awaiting-review-pickup");
  });

  it("summarizeByStatus counts correctly", () => {
    const issues = [
      { status: "in_progress" },
      { status: "in_progress" },
      { status: "todo" },
      { status: "blocked" },
    ];
    expect(summarizeByStatus(issues)).toEqual({ in_progress: 2, todo: 1, blocked: 1 });
    expect(summarizeByStatus([])).toEqual({});
  });

  it("detectMiscategorizedRtaaTasks returns empty when no project ID", () => {
    const issues = [{ parentId: "root", projectId: null }];
    expect(detectMiscategorizedRtaaTasks(issues, { rtaaProjectId: null, rootIssueIds: ["root"] })).toEqual([]);
    expect(detectMiscategorizedRtaaTasks(issues, { rtaaProjectId: "proj", rootIssueIds: [] })).toEqual([]);
    expect(detectMiscategorizedRtaaTasks(issues)).toEqual([]);
  });

  it("finds stranded assignments and miscategorized RTAA tasks", () => {
    const issues = [
      {
        identifier: "DLD-2",
        title: "Blocked on paused owner",
        status: "in_progress",
        assigneeAgentId: pausedAgent.id,
        assigneeUserId: null,
        executionRunId: null,
        checkoutRunId: null,
        updatedAt: "2026-04-01T00:00:00Z",
        projectId: "rtaa-project",
        parentId: null,
      },
      {
        identifier: "DLD-3",
        title: "Actionable but idle",
        status: "in_progress",
        assigneeAgentId: idleAgent.id,
        assigneeUserId: null,
        executionRunId: null,
        checkoutRunId: null,
        updatedAt: "2026-04-01T00:00:00Z",
        projectId: "rtaa-project",
        parentId: null,
      },
      {
        identifier: "DLD-4",
        title: "RTAA child missing project",
        status: "blocked",
        assigneeAgentId: idleAgent.id,
        assigneeUserId: null,
        executionRunId: null,
        checkoutRunId: null,
        updatedAt: "2026-04-01T00:09:45Z",
        projectId: null,
        parentId: "root-rtaa",
      },
    ];
    const agentById = new Map([
      [idleAgent.id, idleAgent],
      [pausedAgent.id, pausedAgent],
    ]);

    const stranded = detectStrandedAssignments(issues, agentById, { now: NOW });
    expect(stranded.map((issue) => issue.identifier)).toEqual(["DLD-2", "DLD-3"]);

    const miscategorized = detectMiscategorizedRtaaTasks(issues, {
      rtaaProjectId: "rtaa-project",
      rootIssueIds: ["root-rtaa"],
    });
    expect(miscategorized.map((issue) => issue.identifier)).toEqual(["DLD-4"]);
  });

  it("renders a readable markdown report", () => {
    const report = formatWatchdogReport({
      companyId: "company-1",
      generatedAt: "2026-04-01T00:00:00Z",
      issues: [
        {
          identifier: "DLD-5",
          title: "Example",
          status: "in_progress",
          assigneeAgentId: idleAgent.id,
          executionRunId: null,
          checkoutRunId: null,
        },
      ],
      stranded: [
        {
          identifier: "DLD-6",
          title: "Stranded",
          status: "in_progress",
          assignee: pausedAgent.name,
          agentStatus: pausedAgent.status,
          dispatchState: "non-dispatchable-agent",
        },
      ],
      miscategorized: [],
    });

    expect(report).toContain("# Paperclip Pipeline Watchdog Report");
    expect(report).toContain("DLD-6");
    expect(report).toContain("non-dispatchable-agent");
    expect(report).toContain("DLD-5");
  });
});
