import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  approvals,
  budgetPolicies,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueApprovals,
  issueRelations,
  issueThreadInteractions,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged liveness escalation.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { attentionService } from "../services/attention.ts";
import { issueService } from "../services/issues.ts";
import { runningProcesses } from "../adapters/index.ts";
import {
  buildIssueBlockersResolvedWakeStateKey,
  buildIssueBlockersResolvedWakeStateKeyWithoutCycle,
} from "../services/issue-dependency-wakeups.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue liveness escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat resolved dependency wake reconciliation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-liveness-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    // Dependency reconciliation heals missing wakes by enqueuing an
    // on-demand wake, which dispatches a heartbeat run fire-and-forget (see
    // startNextQueuedRunForAgent → executeRun in the heartbeat service). That
    // background run keeps writing rows (workspace_operations, heartbeat_run_events)
    // after the awaited call resolves. Deterministically await those in-flight
    // executions before clearing tables — otherwise an escaping heartbeat_run_events
    // insert can land between the events delete and the heartbeat_runs delete and
    // trip the run_events → runs foreign key.
    await heartbeatService(db).drainActiveRunExecutions();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedBlockedChain(opts: {
    outsideLookback?: boolean;
    blockerStatus?: string;
    blockerAssigneeAgentId?: "coder" | "manager" | null;
  } = {}) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);

    const issueTimestamp = opts.outsideLookback === true
      ? new Date(Date.now() - 25 * 60 * 60 * 1000)
      : new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked parent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
      {
        id: blockerIssueId,
        companyId,
        title: "Missing unblock owner",
        status: opts.blockerStatus ?? "todo",
        priority: "medium",
        assigneeAgentId: opts.blockerAssigneeAgentId === "coder"
          ? coderId
          : opts.blockerAssigneeAgentId === "manager"
            ? managerId
            : null,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
    ]);

    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    return { companyId, managerId, coderId, blockedIssueId, blockerIssueId };
  }

  async function seedResolvedDependencyBackstopFixture(opts: {
    workspaceState?: "none" | "not_finalized" | "finalized";
    assignee?: "agent" | null;
    mentionRunStatus?: "queued" | "running";
  } = {}) {
    const workspaceState = opts.workspaceState ?? "none";
    const companyId = randomUUID();
    const agentId = randomUUID();
    const mentionAgentId = randomUUID();
    const ownerUserId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Priya",
        role: "engineer",
        status: "idle",
        adapterType: "test_adapter",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
      {
        id: mentionAgentId,
        companyId,
        name: "Mention Participant",
        role: "reviewer",
        status: "idle",
        adapterType: "test_adapter",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
    ]);

    if (workspaceState !== "none") {
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Synthetic dependency project",
        status: "in_progress",
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Synthetic workspace",
        sourceType: "git_worktree",
      });
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Synthetic execution workspace",
        providerType: "git_worktree",
      });
    }

    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        projectId: workspaceState === "none" ? null : projectId,
        title: "Synthetic blocked dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: opts.assignee === null ? null : agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockerIssueId,
        companyId,
        projectId: workspaceState === "none" ? null : projectId,
        title: "Synthetic completed blocker",
        status: "done",
        priority: "medium",
        executionWorkspaceId: workspaceState === "none" ? null : executionWorkspaceId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    let mentionWakeId: string | null = null;
    let mentionRunId: string | null = null;
    if (opts.mentionRunStatus) {
      const mentionWake = await db
        .insert(agentWakeupRequests)
        .values({
          companyId,
          agentId: mentionAgentId,
          source: "mention",
          triggerDetail: "comment",
          reason: "issue_commented",
          payload: { issueId: blockedIssueId, commentId: randomUUID() },
          status: opts.mentionRunStatus === "running" ? "claimed" : "queued",
          // Deliberately collide with the dependency state key to prove that a
          // non-assignee participant cannot falsely satisfy assignee delivery.
          idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
            dependentIssueId: blockedIssueId,
            blockerIssueIds: [blockerIssueId],
          }),
        })
        .returning()
        .then((rows) => rows[0]!);
      const mentionRun = await db
        .insert(heartbeatRuns)
        .values({
          companyId,
          agentId: mentionAgentId,
          invocationSource: "mention",
          triggerDetail: "comment",
          status: opts.mentionRunStatus,
          responsibleUserId: ownerUserId,
          wakeupRequestId: mentionWake.id,
          contextSnapshot: {
            issueId: blockedIssueId,
            taskId: blockedIssueId,
            wakeReason: "issue_commented",
            commentId: randomUUID(),
          },
          startedAt: opts.mentionRunStatus === "running" ? new Date() : null,
        })
        .returning()
        .then((rows) => rows[0]!);
      await db
        .update(agentWakeupRequests)
        .set({ runId: mentionRun.id })
        .where(eq(agentWakeupRequests.id, mentionWake.id));
      mentionWakeId = mentionWake.id;
      mentionRunId = mentionRun.id;
    }

    if (workspaceState === "not_finalized") {
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "adapter_execute",
        status: "succeeded",
        startedAt: new Date(Date.now() - 60_000),
      });
    } else if (workspaceState === "finalized") {
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date(),
      });
    }

    return {
      companyId,
      agentId,
      mentionAgentId,
      mentionWakeId,
      mentionRunId,
      blockedIssueId,
      blockerIssueId,
      executionWorkspaceId,
    };
  }

  it("runs exactly one bounded review-path recovery before surfacing a stalled decision", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Review Recovery Co",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Review Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "PAP-14994 fingerprint",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const heartbeat = heartbeatService(db);
    const followUpRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {
        issueId,
        interactionId: "superseded-confirmation",
        reviewPathLost: true,
        reviewPathConsumedRef: "superseded-confirmation",
      },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_commented",
        interactionId: "superseded-confirmation",
        reviewPathLost: true,
        reviewPathConsumedRef: "superseded-confirmation",
      },
    });
    expect(followUpRun).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();

    const recoveryWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.reason, "issue_review_path_lost"),
      ));
    expect(recoveryWakes).toHaveLength(1);
    expect(recoveryWakes[0]).toMatchObject({
      status: "completed",
      payload: expect.objectContaining({
        issueId,
        reviewPathConsumedRef: "superseded-confirmation",
        reviewPathRecoveryAttempt: 1,
        maxReviewPathRecoveryAttempts: 1,
      }),
    });

    const attention = await issueService(db)
      .listReviewAttention(companyId, [{ id: issueId, companyId, status: "in_review" }]);
    expect(attention.get(issueId)).toMatchObject({ state: "stalled", paths: [] });

    const feed = await attentionService(db).list(companyId, { userId: "responsible-user" });
    expect(feed.items.find((item) => item.subject.id === issueId)).toMatchObject({
      sourceKind: "review",
      decisionVerbs: expect.arrayContaining([
        expect.objectContaining({ id: "choose_review_path", label: "Choose review path" }),
      ]),
    });
  });

  it("keeps resolved dependency wake reconciliation active", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(
      buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    );
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const dependent = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssueId))
      .then((rows) => rows[0]);
    expect(dependent?.status).toBe("todo");

    const events = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityId: blockedIssueId,
      details: expect.objectContaining({ source: "issue_graph_liveness.backstop" }),
    });
  });

  it("heals a blocked dependent whose done blocker has no workspace finalize obligation", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(
      buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    );
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const events = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityId: blockedIssueId });
  });

  it("queues the dependent assignee exactly once when an unrelated mention run is queued", async () => {
    const { companyId, agentId, mentionAgentId, mentionWakeId, blockedIssueId } =
      await seedResolvedDependencyBackstopFixture({
        workspaceState: "none",
        mentionRunStatus: "queued",
      });

    const firstPass = await heartbeatService(db).reconcileIssueGraphLiveness();
    const secondPass = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(firstPass.dependencyWakesHealed).toBe(1);
    expect(firstPass.dependencyWakeIssueIds).toEqual([blockedIssueId]);
    expect(secondPass.dependencyWakesHealed).toBe(0);

    const dependent = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssueId))
      .then((rows) => rows[0]);
    expect(dependent?.status).not.toBe("blocked");
    expect(["todo", "in_progress"]).toContain(dependent?.status);

    const assigneeWakes = await db
      .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.reason, "issue_blockers_resolved"),
      ));
    expect(assigneeWakes).toHaveLength(1);
    expect(["queued", "claimed", "completed"]).toContain(assigneeWakes[0]?.status);

    const mentionWake = await db
      .select({ agentId: agentWakeupRequests.agentId, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, mentionWakeId!))
      .then((rows) => rows[0]);
    expect(mentionWake).toEqual({ agentId: mentionAgentId, status: "queued" });
  });

  it("defers one assignee wake behind a genuinely running mention and still unblocks the dependent", async () => {
    const { companyId, agentId, blockedIssueId } =
      await seedResolvedDependencyBackstopFixture({
        workspaceState: "none",
        mentionRunStatus: "running",
      });

    const firstPass = await heartbeatService(db).reconcileIssueGraphLiveness();
    const secondPass = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(firstPass.dependencyWakeDeferredOrFailed).toBe(1);
    expect(secondPass.dependencyWakesHealed).toBe(0);

    const dependent = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssueId))
      .then((rows) => rows[0]);
    expect(dependent?.status).toBe("todo");

    const assigneeWakes = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
      ));
    expect(assigneeWakes).toHaveLength(1);
  });

  it("reconciles a resolved blocked dependency after the assignee-null window closes", async () => {
    const { agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none", assignee: null });
    const heartbeat = heartbeatService(db);

    const beforeAssignment = await heartbeat.reconcileResolvedDependencyWakes();

    expect(beforeAssignment.healed).toBe(0);
    expect(beforeAssignment.checked).toBe(0);

    await db
      .update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, blockedIssueId));

    const afterAssignment = await heartbeat.reconcileResolvedDependencyWakes();

    expect(afterAssignment.healed).toBe(1);
    expect(afterAssignment.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);
    expect(wake).toMatchObject({
      reason: "issue_blockers_resolved",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });
  });

  it("retries a resolved dependency wake when the prior wake was skipped as stale", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    // The route-time wake writes the level-triggered state key. A skip records a
    // `skipped` row with that key. `skipped` is not an in-flight status, so the
    // backstop must still re-emit for the same ready state.
    const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "skipped",
      finishedAt: new Date(),
      error: "Cancelled because issue assignee changed before the queued run could start",
      idempotencyKey,
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.existingWakeSkipped).toBe(0);

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")))
      .orderBy(agentWakeupRequests.requestedAt);

    expect(wakes).toHaveLength(2);
    expect(wakes.map((wake) => wake.status)).toContain("skipped");
    expect(wakes.every((wake) => wake.idempotencyKey === idempotencyKey)).toBe(true);
    expect(wakes.some((wake) => ["queued", "claimed", "completed"].includes(wake.status))).toBe(true);
  });

  it("waits for workspace finalize before healing a resolved blocked dependent", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "not_finalized" });
    const heartbeat = heartbeatService(db);

    const beforeFinalize = await heartbeat.reconcileResolvedDependencyWakes();

    expect(beforeFinalize.healed).toBe(0);
    expect(beforeFinalize.notReadySkipped).toBe(1);

    const wakesBeforeFinalize = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakesBeforeFinalize).toHaveLength(0);

    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: blockerIssueId,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date(),
    });

    const afterFinalize = await heartbeat.reconcileResolvedDependencyWakes();

    expect(afterFinalize.healed).toBe(1);
    expect(afterFinalize.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);
    expect(wake).toMatchObject({
      reason: "issue_blockers_resolved",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });
  });

  it("does not duplicate an existing dependency wake keyed to any resolved blocker", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const secondBlockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondBlockerIssueId,
      companyId,
      title: "Second completed blocker",
      status: "done",
      priority: "medium",
      issueNumber: 3,
      identifier: "R-MULTI-3",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: secondBlockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const readiness = await issueService(db).getDependencyReadiness(blockedIssueId);
    const blockerIdNotUsedByBackstop = readiness.blockerIssueIds.find((id) => id !== blockerIssueId);
    if (!blockerIdNotUsedByBackstop) {
      throw new Error("Expected a second blocker id in dependency readiness");
    }
    expect(blockerIdNotUsedByBackstop).toBe(secondBlockerIssueId);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIdNotUsedByBackstop,
      },
      status: "queued",
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${blockerIdNotUsedByBackstop}`,
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.existingWakeSkipped).toBe(1);

    const wakes = await db
      .select({
        id: agentWakeupRequests.id,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.idempotencyKey).toBe(
      `issue_blockers_resolved:${blockedIssueId}:${blockerIdNotUsedByBackstop}`,
    );
    const dependent = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssueId))
      .then((rows) => rows[0]);
    expect(dependent?.status).toBe("todo");
  });

  it.each(["claimed", "queued"] as const)(
    "replaces a %s wake whose linked run is already terminal",
    async (wakeStatus) => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const [staleWake] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: wakeStatus,
      claimedAt: wakeStatus === "claimed" ? new Date() : null,
      idempotencyKey,
    }).returning({ id: agentWakeupRequests.id });
    const [terminalRun] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "system",
      status: "succeeded",
      wakeupRequestId: staleWake!.id,
      contextSnapshot: { issueId: blockedIssueId, taskId: blockedIssueId },
      finishedAt: new Date(),
    }).returning({ id: heartbeatRuns.id });
    await db.update(agentWakeupRequests)
      .set({ runId: terminalRun!.id })
      .where(eq(agentWakeupRequests.id, staleWake!.id));

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.existingWakeSkipped).toBe(0);
    const [dependent] = await db.select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    expect(dependent?.status).toBe("todo");
    const wakes = await db.select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
      ));
      expect(wakes).toHaveLength(2);
    },
  );

  it("revalidates the assignee and blockers after acquiring the dependent lock", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const replacementAgentId = randomUUID();
    const newBlockerIssueId = randomUUID();
    await db.insert(agents).values({
      id: replacementAgentId,
      companyId,
      name: "Replacement owner",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: newBlockerIssueId,
      companyId,
      title: "Concurrent unresolved blocker",
      status: "in_progress",
      priority: "medium",
      issueNumber: 3,
      identifier: "R-RACE-3",
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "queued",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });

    let signalLockAcquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { signalLockAcquired = resolve; });
    let releaseIssueLock!: () => void;
    const issueLockRelease = new Promise<void>((resolve) => { releaseIssueLock = resolve; });
    const concurrentMutation = db.transaction(async (tx) => {
      await tx.select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, blockedIssueId))
        .for("update");
      signalLockAcquired();
      await issueLockRelease;
      await tx.update(issues)
        .set({ assigneeAgentId: replacementAgentId, updatedAt: new Date() })
        .where(eq(issues.id, blockedIssueId));
      await tx.insert(issueRelations).values({
        companyId,
        issueId: newBlockerIssueId,
        relatedIssueId: blockedIssueId,
        type: "blocks",
      });
    });
    await lockAcquired;

    const reconciliation = heartbeatService(db).reconcileIssueGraphLiveness();
    // Let the backstop read the original ready state and reach its row lock.
    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseIssueLock();
    await concurrentMutation;
    const result = await reconciliation;

    expect(result.dependencyWakesHealed).toBe(0);
    expect(result.dependencyWakeExistingSkipped).toBe(1);
    const [dependent] = await db.select({
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
    }).from(issues).where(eq(issues.id, blockedIssueId));
    expect(dependent).toEqual({ status: "blocked", assigneeAgentId: replacementAgentId });
    const wakes = await db.select({ agentId: agentWakeupRequests.agentId })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.reason, "issue_blockers_resolved"),
      ));
    expect(wakes).toEqual([{ agentId }]);
  });

  it("keeps the dependent blocked when its covering wake completes during repair", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "queued",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    }).returning({ id: agentWakeupRequests.id });

    let signalWakeLockAcquired!: () => void;
    const wakeLockAcquired = new Promise<void>((resolve) => { signalWakeLockAcquired = resolve; });
    let releaseWakeLock!: () => void;
    const wakeLockRelease = new Promise<void>((resolve) => { releaseWakeLock = resolve; });
    const concurrentCompletion = db.transaction(async (tx) => {
      await tx.select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wake!.id))
        .for("update");
      signalWakeLockAcquired();
      await wakeLockRelease;
      await tx.update(agentWakeupRequests)
        .set({ status: "completed", finishedAt: new Date() })
        .where(eq(agentWakeupRequests.id, wake!.id));
    });
    await wakeLockAcquired;

    const reconciliation = heartbeatService(db).reconcileIssueGraphLiveness();
    // Let the backstop observe the queued wake before its locked revalidation.
    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseWakeLock();
    await concurrentCompletion;
    const result = await reconciliation;

    expect(result.dependencyWakesHealed).toBe(0);
    expect(result.dependencyWakeExistingSkipped).toBe(1);
    const [dependent] = await db.select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    expect(dependent?.status).toBe("blocked");
    const [completedWake] = await db.select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wake!.id));
    expect(completedWake?.status).toBe("completed");
  });

  it.each(["interaction", "approval", "pause"] as const)(
    "keeps an existing-wake dependent blocked under an active %s suppression gate",
    async (gate) => {
      const { companyId, agentId, blockedIssueId, blockerIssueId } =
        await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_blockers_resolved",
        payload: {
          issueId: blockedIssueId,
          resolvedBlockerIssueId: blockerIssueId,
          blockerIssueIds: [blockerIssueId],
        },
        status: "queued",
        idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: blockedIssueId,
          blockerIssueIds: [blockerIssueId],
        }),
      });
      if (gate === "interaction") {
        await db.insert(issueThreadInteractions).values({
          companyId,
          issueId: blockedIssueId,
          kind: "request_confirmation",
          status: "pending",
          continuationPolicy: "wake_assignee",
          payload: { version: 1, prompt: "Continue dependency recovery?" },
        });
      } else if (gate === "approval") {
        const [approval] = await db.insert(approvals).values({
          companyId,
          type: "dependency_recovery_review",
          status: "pending",
          payload: {},
        }).returning({ id: approvals.id });
        await db.insert(issueApprovals).values({
          companyId,
          issueId: blockedIssueId,
          approvalId: approval!.id,
        });
      } else {
        await db.insert(issueTreeHolds).values({
          companyId,
          rootIssueId: blockedIssueId,
          mode: "pause",
          status: "active",
          reason: "operator paused dependency recovery",
          releasePolicy: { strategy: "manual" },
        });
      }

      const result = await heartbeatService(db).reconcileIssueGraphLiveness();

      expect(result.dependencyWakesHealed).toBe(0);
      expect(result.dependencyWakeExistingSkipped).toBe(1);
      expect(
        gate === "interaction"
          ? result.dependencyWakeInteractionSkipped
          : gate === "approval"
            ? result.dependencyWakeApprovalSkipped
            : result.dependencyWakePauseHoldSkipped,
      ).toBe(1);
      const [dependent] = await db.select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, blockedIssueId));
      expect(dependent?.status).toBe("blocked");
    },
  );

  it("preserves an explicit unblock descriptor even when a covering wake exists", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const unblockDescriptor = { owner: "board" as const, action: "Approve the independent release gate" };
    await db.update(issues)
      .set({ unblockDescriptor })
      .where(eq(issues.id, blockedIssueId));
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "queued",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.notReadySkipped).toBe(1);
    const [dependent] = await db.select({
      status: issues.status,
      unblockDescriptor: issues.unblockDescriptor,
    }).from(issues).where(eq(issues.id, blockedIssueId));
    expect(dependent).toEqual({ status: "blocked", unblockDescriptor });
  });

  it.each(["interaction", "approval", "unblock_descriptor"] as const)(
    "does not make a dependency-ready issue runnable while a pending %s remains",
    async (gate) => {
      const { companyId, agentId, blockedIssueId, blockerIssueId } =
        await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
      if (gate === "interaction") {
        await db.insert(issueThreadInteractions).values({
          companyId,
          issueId: blockedIssueId,
          kind: "request_confirmation",
          status: "pending",
          continuationPolicy: "wake_assignee",
          payload: { version: 1, prompt: "Continue dependency recovery?" },
        });
      } else if (gate === "approval") {
        const [approval] = await db.insert(approvals).values({
          companyId,
          type: "dependency_recovery_review",
          status: "pending",
          payload: {},
        }).returning({ id: approvals.id });
        await db.insert(issueApprovals).values({
          companyId,
          issueId: blockedIssueId,
          approvalId: approval!.id,
        });
      } else {
        await db.update(issues)
          .set({
            unblockDescriptor: {
              owner: "board",
              action: "Approve the independent release gate",
            },
          })
          .where(eq(issues.id, blockedIssueId));
      }
      const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      });

      const run = await heartbeatService(db).wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_blockers_resolved",
        payload: { issueId: blockedIssueId, resolvedBlockerIssueId: blockerIssueId },
        idempotencyKey,
        contextSnapshot: { issueId: blockedIssueId, taskId: blockedIssueId },
      });

      expect(run).toBeNull();
      const [dependent] = await db.select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, blockedIssueId));
      expect(dependent?.status).toBe("blocked");
      const [skipped] = await db.select({ reason: agentWakeupRequests.reason })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
      expect(skipped?.reason).toBe("issue_blockers_resolved_wait_gate");
    },
  );

  it("rejects a dependency wake from an earlier blocked cycle", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const firstCycle = new Date("2026-08-04T10:00:00.000Z");
    const secondCycle = new Date("2026-08-04T10:05:00.000Z");
    await db.update(issues)
      .set({ blockedTransitionAt: firstCycle })
      .where(eq(issues.id, blockedIssueId));
    const staleKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle,
    });

    let signalLockAcquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { signalLockAcquired = resolve; });
    let releaseIssueLock!: () => void;
    const issueLockRelease = new Promise<void>((resolve) => { releaseIssueLock = resolve; });
    const concurrentCycle = db.transaction(async (tx) => {
      await tx.select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, blockedIssueId))
        .for("update");
      signalLockAcquired();
      await issueLockRelease;
      await tx.update(issues)
        .set({
          status: "blocked",
          blockedTransitionAt: secondCycle,
        })
        .where(eq(issues.id, blockedIssueId));
    });
    await lockAcquired;

    const wake = heartbeatService(db).wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: blockedIssueId, resolvedBlockerIssueId: blockerIssueId },
      idempotencyKey: staleKey,
      contextSnapshot: { issueId: blockedIssueId, taskId: blockedIssueId },
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseIssueLock();
    await concurrentCycle;
    expect(await wake).toBeNull();

    const [dependent] = await db.select({
      status: issues.status,
      blockedTransitionAt: issues.blockedTransitionAt,
      unblockDescriptor: issues.unblockDescriptor,
    }).from(issues).where(eq(issues.id, blockedIssueId));
    expect(dependent).toMatchObject({
      status: "blocked",
      blockedTransitionAt: secondCycle,
      unblockDescriptor: null,
    });
    const [skipped] = await db.select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, staleKey));
    expect(skipped?.reason).toBe("issue_blockers_resolved_stale_cycle");
  });

  it.each(["reassigned", "done"] as const)(
    "rejects a dependency wake after the dependent is %s before lock acquisition",
    async (mutation) => {
      const { companyId, agentId, mentionAgentId, blockedIssueId, blockerIssueId } =
        await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
      const blockedTransitionAt = new Date("2026-08-04T11:00:00.000Z");
      await db.update(issues)
        .set({ blockedTransitionAt })
        .where(eq(issues.id, blockedIssueId));
      const wakeKey = buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
        blockedTransitionAt,
      });

      let signalLockAcquired!: () => void;
      const lockAcquired = new Promise<void>((resolve) => { signalLockAcquired = resolve; });
      let releaseIssueLock!: () => void;
      const issueLockRelease = new Promise<void>((resolve) => { releaseIssueLock = resolve; });
      const concurrentMutation = db.transaction(async (tx) => {
        await tx.select({ id: issues.id })
          .from(issues)
          .where(eq(issues.id, blockedIssueId))
          .for("update");
        signalLockAcquired();
        await issueLockRelease;
        await tx.update(issues)
          .set(mutation === "reassigned"
            ? { assigneeAgentId: mentionAgentId }
            : { status: "done" })
          .where(eq(issues.id, blockedIssueId));
      });
      await lockAcquired;

      const wake = heartbeatService(db).wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_blockers_resolved",
        payload: { issueId: blockedIssueId, resolvedBlockerIssueId: blockerIssueId },
        idempotencyKey: wakeKey,
        contextSnapshot: { issueId: blockedIssueId, taskId: blockedIssueId },
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      releaseIssueLock();
      await concurrentMutation;
      expect(await wake).toBeNull();

      const [dependent] = await db.select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      }).from(issues).where(eq(issues.id, blockedIssueId));
      expect(dependent).toMatchObject(mutation === "reassigned"
        ? { status: "blocked", assigneeAgentId: mentionAgentId }
        : { status: "done", assigneeAgentId: agentId });
      const [skipped] = await db.select({ reason: agentWakeupRequests.reason })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.idempotencyKey, wakeKey));
      expect(skipped?.reason).toBe("issue_blockers_resolved_state_mismatch");
      const oldAssigneeRuns = await db.select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
        ));
      expect(oldAssigneeRuns).toHaveLength(0);
    },
  );

  it("timestamps an existing-wake repair after waiting for the dependent lock", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "queued",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });

    let signalLockAcquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { signalLockAcquired = resolve; });
    let releaseIssueLock!: () => void;
    const issueLockRelease = new Promise<void>((resolve) => { releaseIssueLock = resolve; });
    let concurrentUpdatedAt!: Date;
    const concurrentMutation = db.transaction(async (tx) => {
      await tx.select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, blockedIssueId))
        .for("update");
      signalLockAcquired();
      await issueLockRelease;
      concurrentUpdatedAt = new Date();
      await tx.update(issues)
        .set({ title: "Concurrent non-readiness update", updatedAt: concurrentUpdatedAt })
        .where(eq(issues.id, blockedIssueId));
    });
    await lockAcquired;

    const reconciliation = heartbeatService(db).reconcileIssueGraphLiveness();
    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseIssueLock();
    await concurrentMutation;
    const result = await reconciliation;

    expect(result.dependencyWakesHealed).toBe(1);
    const [dependent] = await db.select({
      status: issues.status,
      title: issues.title,
      updatedAt: issues.updatedAt,
    }).from(issues).where(eq(issues.id, blockedIssueId));
    expect(dependent).toMatchObject({ status: "todo", title: "Concurrent non-readiness update" });
    expect(dependent!.updatedAt.getTime()).toBeGreaterThanOrEqual(concurrentUpdatedAt.getTime());
  });

  it("heals a multi-blocker dependent when only a completed wake for an earlier blocker exists", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const secondBlockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondBlockerIssueId,
      companyId,
      title: "Earlier completed blocker",
      status: "done",
      priority: "medium",
      issueNumber: 3,
      identifier: "R-MULTI-3",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: secondBlockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    // An earlier partial resolution left a `completed` per-edge wake. The bug was
    // that this stale wake suppressed the wake for the current ready state. The
    // level-triggered dedup keys on the full blocker set, so this completed wake
    // no longer strands the dependent.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: secondBlockerIssueId,
      },
      status: "completed",
      finishedAt: new Date(),
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${secondBlockerIssueId}`,
    });

    const readiness = await issueService(db).getDependencyReadiness(blockedIssueId);
    expect(readiness.isDependencyReady).toBe(true);

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);
    expect(result.existingWakeSkipped).toBe(0);

    const stateKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: readiness.blockerIssueIds,
    });
    const healedWake = await db
      .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, stateKey)))
      .then((rows) => rows[0] ?? null);
    expect(healedWake).not.toBeNull();
    expect(["queued", "claimed", "completed"]).toContain(healedWake?.status);

    // A second reconciliation pass finds the state-key wake and stays bounded:
    // it heals nothing more and never enqueues a second wake for the same state.
    const secondPass = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(secondPass.healed).toBe(0);

    const stateKeyWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, stateKey)));
    expect(stateKeyWakes).toHaveLength(1);
  });

  it("heals a blocked dependent after a terminal reset when a previous-cycle old-key wake exists", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const previousCycleWakeAt = new Date("2026-07-01T12:00:00.000Z");
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    await db
      .update(issues)
      .set({ blockedTransitionAt, updatedAt: blockedTransitionAt })
      .where(eq(issues.id, blockedIssueId));
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "completed",
      finishedAt: previousCycleWakeAt,
      requestedAt: previousCycleWakeAt,
      idempotencyKey: buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);
    expect(result.existingWakeSkipped).toBe(0);

    const cycleKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt,
    });
    const healedWake = await db
      .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, cycleKey)))
      .then((rows) => rows[0] ?? null);
    expect(healedWake).not.toBeNull();
    expect(["queued", "claimed", "completed"]).toContain(healedWake?.status);

    const secondPass = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(secondPass.healed).toBe(0);

    const cycleKeyWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, cycleKey)));
    expect(cycleKeyWakes).toHaveLength(1);
  });

  it("re-heals a stranded blocked issue even when the current cycle has a completed old-key wake", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    const sameCycleWakeAt = new Date("2026-08-01T12:00:01.000Z");
    await db
      .update(issues)
      .set({ blockedTransitionAt, updatedAt: blockedTransitionAt })
      .where(eq(issues.id, blockedIssueId));
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "completed",
      finishedAt: sameCycleWakeAt,
      requestedAt: sameCycleWakeAt,
      idempotencyKey: buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.existingWakeSkipped).toBe(0);

    const dependent = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssueId))
      .then((rows) => rows[0]);
    expect(dependent?.status).toBe("todo");
  });

  it("counts null dependency wake returns as deferred instead of enqueue failures", async () => {
    const { companyId, agentId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    await db
      .update(agents)
      .set({
        runtimeConfig: { heartbeat: { wakeOnDemand: false, maxConcurrentRuns: 1 } },
      })
      .where(eq(agents.id, agentId));

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.deferredOrFailed).toBe(1);
    expect(result.enqueueFailed).toBe(0);

    const skippedWake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)))
      .then((rows) => rows[0] ?? null);
    expect(skippedWake).toMatchObject({
      status: "skipped",
      reason: "heartbeat.wakeOnDemand.disabled",
    });
  });

});
