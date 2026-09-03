import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  approvals,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueApprovals,
  issueRelations,
  issueThreadInteractions,
  issueWatchdogs,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { runningProcesses } from "../adapters/index.ts";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { taskWatchdogService } from "../services/task-watchdogs.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Issue watchdog route test run.",
    provider: "test",
    model: "test-model",
  })),
);

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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue watchdog route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue watchdog routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-watchdogs-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issueRelations);
    await db.delete(issueWatchdogs);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string, actor?: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor ?? {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, { taskWatchdogEnqueueWakeup: null }));
    app.use(errorHandler);
    return app;
  }

  function uniqueIssuePrefix() {
    return `W${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
  }

  async function seedCloudTenantMember(companyId: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
  }

  async function seedCompany(name = "Paperclip") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    return companyId;
  }

  async function seedAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: overrides.name ?? "Watchdog Agent",
      role: overrides.role ?? "engineer",
      status: overrides.status ?? "active",
      adapterType: overrides.adapterType ?? "codex_local",
      adapterConfig: overrides.adapterConfig ?? {},
      runtimeConfig: overrides.runtimeConfig ?? {},
      permissions: overrides.permissions ?? {},
      reportsTo: overrides.reportsTo,
    });
    return id;
  }

  async function seedIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: overrides.title ?? "Watched task",
      status: overrides.status ?? "todo",
      priority: overrides.priority ?? "medium",
      identifier: overrides.identifier,
      issueNumber: overrides.issueNumber,
      assigneeAgentId: overrides.assigneeAgentId,
      parentId: overrides.parentId,
      projectId: overrides.projectId,
      goalId: overrides.goalId,
      originKind: overrides.originKind,
      originId: overrides.originId,
      // Default to an "established" issue (created before the first-run grace
      // window) so attaching a watchdog evaluates immediately instead of being
      // deferred by the pending-first-run guard.
      createdAt: overrides.createdAt ?? new Date(Date.now() - 60 * 60 * 1000),
    });
    return id;
  }

  async function seedWatchdogRun(input: {
    companyId: string;
    watchdogAgentId: string;
    watchedIssueId: string;
    watchdogIssueId: string;
    triggeredAt?: Date;
    runCreatedAt?: Date;
  }) {
    const triggeredAt = input.triggeredAt ?? new Date(Date.now() - 60_000);
    await db.insert(issueWatchdogs).values({
      companyId: input.companyId,
      issueId: input.watchedIssueId,
      watchdogAgentId: input.watchdogAgentId,
      watchdogIssueId: input.watchdogIssueId,
      lastTriggeredAt: triggeredAt,
      status: "active",
    });
    await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId: input.companyId });
    await db.update(issueWatchdogs).set({ lastTriggeredAt: triggeredAt }).where(and(
      eq(issueWatchdogs.companyId, input.companyId),
      eq(issueWatchdogs.issueId, input.watchedIssueId),
    ));
    const [watchdog] = await db
      .select({
        id: issueWatchdogs.id,
        lastObservedFingerprint: issueWatchdogs.lastObservedFingerprint,
        lastObservedStopSnapshot: issueWatchdogs.lastObservedStopSnapshot,
      })
      .from(issueWatchdogs)
      .where(and(eq(issueWatchdogs.companyId, input.companyId), eq(issueWatchdogs.issueId, input.watchedIssueId)));
    const stopSnapshot = watchdog?.lastObservedStopSnapshot as {
      materialLeaves?: Array<{
        issueId: string;
        status: string;
        assigneeAgentId: string | null;
        assigneeUserId: string | null;
        blockerIssueIds: string[];
        pendingInteractionIds: string[];
        pendingApprovalIds: string[];
      }>;
      waitsByIssueId?: Record<string, { pendingInteractionIds: string[]; pendingApprovalIds: string[] }>;
    } | null;
    const waitsByIssueId = stopSnapshot?.waitsByIssueId ?? {};
    const [sourceIssue, sourceBlockers, sourceApprovals] = await Promise.all([
      db.select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        updatedAt: issues.updatedAt,
      }).from(issues).where(eq(issues.id, input.watchedIssueId)).then((rows) => rows[0]),
      db.select({ issueId: issueRelations.issueId })
        .from(issueRelations)
        .where(and(
          eq(issueRelations.companyId, input.companyId),
          eq(issueRelations.relatedIssueId, input.watchedIssueId),
          eq(issueRelations.type, "blocks"),
        )),
      db.select({ id: approvals.id })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(and(
          eq(issueApprovals.companyId, input.companyId),
          eq(issueApprovals.issueId, input.watchedIssueId),
          eq(approvals.status, "pending"),
        )),
    ]);
    const sourceWaits = waitsByIssueId[input.watchedIssueId] ?? {
      pendingInteractionIds: [],
      pendingApprovalIds: sourceApprovals.map((row) => row.id).sort(),
    };
    const boundaryIssueIds = new Set([
      input.watchedIssueId,
      ...(stopSnapshot?.materialLeaves ?? []).map((leaf) => leaf.issueId),
    ]);
    const commitOrderedActions = new Set([
      "issue.updated",
      "issue.document_created",
      "issue.document_updated",
      "issue.document_upserted",
      "issue.document_restored",
      "issue.document_deleted",
      "issue.attachment_added",
      "issue.attachment_removed",
      "issue.work_product_created",
      "issue.work_product_updated",
      "issue.work_product_deleted",
    ]);
    const boundaryActivities = await db
      .select({ entityId: activityLog.entityId, action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.companyId, input.companyId));
    const issueActivityCount = boundaryActivities.filter((activity) =>
      boundaryIssueIds.has(activity.entityId) && commitOrderedActions.has(activity.action)
    ).length;
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.watchdogAgentId,
      status: "running",
      contextSnapshot: {
        issueId: input.watchdogIssueId,
        watchdogId: watchdog?.id,
        taskWatchdog: {
          triggeredAt: triggeredAt.toISOString(),
          recoveryActivityBoundary: { version: 1, issueActivityCount },
          watchedIssueId: input.watchedIssueId,
          watchedIssueIdentifier: "WDOG-ROOT",
          watchedIssueTitle: "Watched root",
          stopFingerprint: watchdog?.lastObservedFingerprint,
          terminalLeafSummaries: (stopSnapshot?.materialLeaves?.length ?? 0) > 0
            ? stopSnapshot!.materialLeaves
            : sourceIssue ? [{
                issueId: sourceIssue.id,
                identifier: sourceIssue.identifier,
                title: sourceIssue.title,
                status: sourceIssue.status,
                assigneeAgentId: sourceIssue.assigneeAgentId,
                assigneeUserId: sourceIssue.assigneeUserId,
                blockerIssueIds: sourceBlockers.map((row) => row.issueId).sort(),
                pendingInteractionIds: sourceWaits.pendingInteractionIds,
                pendingApprovalIds: sourceWaits.pendingApprovalIds,
                updatedAt: sourceIssue.updatedAt.toISOString(),
              }]
            : [],
          pendingInteractions: Object.fromEntries(Object.entries(waitsByIssueId)
            .filter(([, waits]) => waits.pendingInteractionIds.length > 0)
            .map(([issueId, waits]) => [issueId, waits.pendingInteractionIds.map((id) => ({ id, kind: null }))])),
          pendingApprovals: Object.fromEntries(Object.entries(waitsByIssueId)
            .filter(([, waits]) => waits.pendingApprovalIds.length > 0)
            .map(([issueId, waits]) => [issueId, waits.pendingApprovalIds])),
          capabilities: {
            targetScope: {
              watchedIssueId: input.watchedIssueId,
              watchdogIssueId: input.watchdogIssueId,
            },
          },
        },
      },
      createdAt: input.runCreatedAt,
    });
    return runId;
  }

  async function seedWatchdogMutationWithStaleOwnership(input: {
    sourceStatus: "in_progress" | "done" | "cancelled";
    sourceChild?: boolean;
    preexistingWatchdogBlocker?: boolean;
    sourcePendingApproval?: boolean;
    preexistingResolvedBlocker?: boolean;
  }) {
    const companyId = await seedCompany();
    const ownerAgentId = await seedAgent(companyId, { name: "Stopped owner" });
    const watchdogAgentId = await seedAgent(companyId, { name: "Recovery watchdog" });
    const sourceIssueId = await seedIssue(companyId, {
      title: "Stopped source",
      identifier: input.sourceStatus === "done" ? "WDOG-HTTP-COMMENT" : "WDOG-HTTP-PATCH",
      status: input.sourceStatus,
      assigneeAgentId: ownerAgentId,
    });
    const sourceChildId = input.sourceChild
      ? await seedIssue(companyId, {
          title: "Stopped source child",
          status: "in_progress",
          assigneeAgentId: ownerAgentId,
          parentId: sourceIssueId,
        })
      : null;
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: sourceIssueId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: sourceIssueId,
    });
    let sourceApprovalId: string | null = null;
    if (input.sourcePendingApproval) {
      sourceApprovalId = randomUUID();
      await db.insert(approvals).values({
        id: sourceApprovalId,
        companyId,
        type: "request_board_approval",
        status: "pending",
        payload: { title: "Pending source approval" },
      });
      await db.insert(issueApprovals).values({
        companyId,
        issueId: sourceIssueId,
        approvalId: sourceApprovalId,
      });
    }
    let resolvedBlockerIssueId: string | null = null;
    if (input.preexistingResolvedBlocker) {
      resolvedBlockerIssueId = await seedIssue(companyId, {
        title: "Resolved source blocker",
        status: "done",
      });
      await db.insert(issueRelations).values({
        companyId,
        issueId: resolvedBlockerIssueId,
        relatedIssueId: sourceIssueId,
        type: "blocks",
      });
    }
    if (input.preexistingWatchdogBlocker) {
      await db.insert(issueRelations).values({
        companyId,
        issueId: watchdogIssueId,
        relatedIssueId: sourceIssueId,
        type: "blocks",
        createdByActorType: "system",
      });
    }
    const staleRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: staleRunId,
      companyId,
      agentId: ownerAgentId,
      status: "failed",
      invocationSource: "assignment",
      finishedAt: new Date(),
      contextSnapshot: { issueId: sourceIssueId },
    });
    await db.update(issues).set({
      checkoutRunId: staleRunId,
      executionRunId: staleRunId,
      executionAgentNameKey: "stopped-owner",
      executionLockedAt: new Date(),
    }).where(eq(issues.id, sourceIssueId));
    const watchdogTriggeredAt = new Date(Date.now() - 60_000);
    const watchdogRunCreatedAt = new Date(Date.now() - 30_000);
    const watchdogRunId = await seedWatchdogRun({
      companyId,
      watchdogAgentId,
      watchedIssueId: sourceIssueId,
      watchdogIssueId,
      triggeredAt: watchdogTriggeredAt,
      runCreatedAt: watchdogRunCreatedAt,
    });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId: watchdogRunId,
      source: "agent_jwt",
    });
    return {
      app,
      companyId,
      ownerAgentId,
      sourceIssueId,
      sourceChildId,
      staleRunId,
      watchdogAgentId,
      watchdogIssueId,
      watchdogRunId,
      preexistingWatchdogBlocker: input.preexistingWatchdogBlocker === true,
      sourceApprovalId,
      resolvedBlockerIssueId,
      watchdogTriggeredAt,
      watchdogRunCreatedAt,
    };
  }

  async function recordServerOwnedWatchdogBlockerTransition(
    fixture: Awaited<ReturnType<typeof seedWatchdogMutationWithStaleOwnership>>,
    previousStatus: "in_progress" | "done" | "cancelled",
    opts: { createdAt?: Date; executionPolicy?: Record<string, unknown> } = {},
  ) {
    await db.update(issues).set({
      status: "blocked",
      executionPolicy: opts.executionPolicy ?? { mode: "auto" },
    }).where(eq(issues.id, fixture.sourceIssueId));
    if (!fixture.preexistingWatchdogBlocker) {
      await db.insert(issueRelations).values({
        companyId: fixture.companyId,
        issueId: fixture.watchdogIssueId,
        relatedIssueId: fixture.sourceIssueId,
        type: "blocks",
        createdByActorType: "system",
        createdAt: opts.createdAt ? new Date(opts.createdAt.getTime() - 1) : undefined,
      });
    }
    if (fixture.resolvedBlockerIssueId) {
      await db.delete(issueRelations).where(and(
        eq(issueRelations.companyId, fixture.companyId),
        eq(issueRelations.issueId, fixture.resolvedBlockerIssueId),
        eq(issueRelations.relatedIssueId, fixture.sourceIssueId),
        eq(issueRelations.type, "blocks"),
      ));
    }
    await db.insert(activityLog).values({
      companyId: fixture.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.updated",
      entityType: "issue",
      entityId: fixture.sourceIssueId,
      details: {
        source: "recovery.reconcile_continuation_waiting_on_review",
        status: "blocked",
        previousStatus,
        blockedByIssueIds: [fixture.watchdogIssueId],
      },
      createdAt: opts.createdAt,
    });
  }

  async function waitForAssignmentWakeup(companyId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const rows = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, companyId))
        .limit(1);
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("creates, updates, reads, lists, and removes an issue watchdog with activity logs", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, { identifier: "WDOG-1", issueNumber: 1 });
    const firstAgentId = await seedAgent(companyId, { name: "First Watchdog" });
    const secondAgentId = await seedAgent(companyId, { name: "Second Watchdog" });
    const app = createApp(companyId);

    const created = await request(app)
      .put(`/api/issues/${issueId}/watchdog`)
      .send({ agentId: firstAgentId, instructions: "Check screenshots and tests." });

    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({
      issueId,
      watchdogAgentId: firstAgentId,
      instructions: "Check screenshots and tests.",
      status: "active",
    });

    const updated = await request(app)
      .put(`/api/issues/${issueId}/watchdog`)
      .send({ agentId: secondAgentId, instructions: "Be skeptical." });

    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.id).toBe(created.body.id);
    expect(updated.body).toMatchObject({
      issueId,
      watchdogAgentId: secondAgentId,
      instructions: "Be skeptical.",
      status: "active",
    });

    const read = await request(app).get(`/api/issues/${issueId}/watchdog`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({ id: created.body.id, watchdogAgentId: secondAgentId });

    const detail = await request(app).get(`/api/issues/${issueId}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.watchdog).toMatchObject({ id: created.body.id, watchdogAgentId: secondAgentId });

    const list = await request(app).get(`/api/companies/${companyId}/issues`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.find((issue: { id: string }) => issue.id === issueId)?.watchdog)
      .toMatchObject({ id: created.body.id, watchdogAgentId: secondAgentId });

    const removed = await request(app).delete(`/api/issues/${issueId}/watchdog`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toEqual({ ok: true });

    const afterDelete = await request(app).get(`/api/issues/${issueId}/watchdog`);
    expect(afterDelete.status, JSON.stringify(afterDelete.body)).toBe(200);
    expect(afterDelete.body).toBeNull();

    const stored = await db
      .select()
      .from(issueWatchdogs)
      .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)))
      .then((rows) => rows[0] ?? null);
    expect(stored).toMatchObject({
      id: created.body.id,
      status: "disabled",
      watchdogAgentId: secondAgentId,
    });

    const actions = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    const actionNames = actions.map((row) => row.action);
    expect(actionNames.filter((action) => action.startsWith("issue.watchdog_"))).toEqual([
      "issue.watchdog_created",
      "issue.watchdog_updated",
      "issue.watchdog_removed",
    ]);
    expect(actionNames).toContain("issue.task_watchdog_triggered");
  });

  it("handles concurrent first-time watchdog upserts without duplicate-key failures", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, { identifier: "WDOG-RACE", issueNumber: 99 });
    const agentId = await seedAgent(companyId, { name: "Race Watchdog" });
    const app = createApp(companyId);

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        request(app)
          .put(`/api/issues/${issueId}/watchdog`)
          .send({ agentId, instructions: `Concurrent instructions ${index}` }),
      ),
    );

    expect(responses.map((res) => res.status), JSON.stringify(responses.map((res) => res.body)))
      .toEqual(Array(12).fill(200));
    const stored = await db
      .select()
      .from(issueWatchdogs)
      .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ status: "active", watchdogAgentId: agentId });
  });

  it("creates an issue and watchdog atomically from the create issue route", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const app = createApp(companyId);

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Create with watchdog",
        watchdog: {
          agentId,
          instructions: "Confirm the final state.",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.watchdog).toMatchObject({
      issueId: res.body.id,
      watchdogAgentId: agentId,
      instructions: "Confirm the final state.",
      status: "active",
    });

    const rows = await db
      .select()
      .from(issueWatchdogs)
      .where(eq(issueWatchdogs.issueId, res.body.id));
    expect(rows).toHaveLength(1);

    const activityRows = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, res.body.id));
    expect(activityRows.map((row) => row.action)).toContain("issue.watchdog_created");
  });

  it("does not create an immediate watchdog review for a newly assigned issue", async () => {
    const companyId = await seedCompany();
    const workerAgentId = await seedAgent(companyId, { name: "Worker" });
    const watchdogAgentId = await seedAgent(companyId, { name: "Watchdog" });
    const app = createApp(companyId);

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Assigned issue with watchdog",
        assigneeAgentId: workerAgentId,
        watchdog: {
          agentId: watchdogAgentId,
          instructions: "Confirm whether the worker got started.",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await waitForAssignmentWakeup(companyId);
    expect(res.body).toMatchObject({
      assigneeAgentId: workerAgentId,
      watchdog: {
        issueId: res.body.id,
        watchdogAgentId,
        status: "active",
      },
    });

    const watchdogReviewIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogReviewIssues).toHaveLength(0);

    const [watchdog] = await db
      .select()
      .from(issueWatchdogs)
      .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, res.body.id)));
    expect(watchdog?.triggerCount).toBe(0);

    const taskWatchdogActivity = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, res.body.id), eq(activityLog.action, "issue.task_watchdog_triggered")));
    expect(taskWatchdogActivity).toHaveLength(0);
  });

  it("enforces persisted watchdog scope for issue mutations and child creation", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Scoped Watchdog" });
    const watchedRootId = await seedIssue(companyId, { title: "Watched root", identifier: "WDOG-ROOT" });
    const watchedChildId = await seedIssue(companyId, { title: "Watched child", parentId: watchedRootId });
    const unrelatedRootId = await seedIssue(companyId, { title: "Unrelated root" });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const watchdogIssueChildId = await seedIssue(companyId, {
      title: "Watchdog issue child",
      parentId: watchdogIssueId,
    });
    const runId = await seedWatchdogRun({
      companyId,
      watchdogAgentId,
      watchedIssueId: watchedRootId,
      watchdogIssueId,
    });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const watchdogIssuePatch = await request(app)
      .patch(`/api/issues/${watchdogIssueId}`)
      .send({ title: "Reusable watchdog issue completed" });
    expect(watchdogIssuePatch.status, JSON.stringify(watchdogIssuePatch.body)).toBe(200);

    const deniedWatchdogDescendantPatch = await request(app)
      .patch(`/api/issues/${watchdogIssueChildId}`)
      .send({ title: "Denied watchdog descendant mutation" });
    expect(deniedWatchdogDescendantPatch.status, JSON.stringify(deniedWatchdogDescendantPatch.body)).toBe(403);
    expect(deniedWatchdogDescendantPatch.body.error).toBe(
      "Task-watchdog runs can only mutate the watched issue subtree.",
    );

    const deniedPatch = await request(app)
      .patch(`/api/issues/${unrelatedRootId}`)
      .send({ title: "Out-of-scope mutation" });
    expect(deniedPatch.status, JSON.stringify(deniedPatch.body)).toBe(403);
    expect(deniedPatch.body.error).toBe("Task-watchdog runs can only mutate the watched issue subtree.");

    const deniedChild = await request(app)
      .post(`/api/issues/${unrelatedRootId}/children`)
      .send({ title: "Denied unrelated child" });
    expect(deniedChild.status, JSON.stringify(deniedChild.body)).toBe(403);
    expect(deniedChild.body.error).toBe("Task-watchdog runs can only mutate the watched issue subtree.");

    const deniedWatchdogIssueChild = await request(app)
      .post(`/api/issues/${watchdogIssueId}/children`)
      .send({ title: "Denied watchdog issue child" });
    expect(deniedWatchdogIssueChild.status, JSON.stringify(deniedWatchdogIssueChild.body)).toBe(403);
    const deniedVisibleProbeIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.title, "Denied watchdog issue child")));
    expect(deniedVisibleProbeIssues).toHaveLength(0);

    const deniedParentCreate = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Denied parent create", parentId: unrelatedRootId });
    expect(deniedParentCreate.status, JSON.stringify(deniedParentCreate.body)).toBe(403);
    expect(deniedParentCreate.body.error).toBe("Task-watchdog runs can only mutate the watched issue subtree.");

    const deniedNestedWatchdog = await request(app)
      .put(`/api/issues/${watchedChildId}/watchdog`)
      .send({ agentId: watchdogAgentId, instructions: "Create a nested watchdog" });
    expect(deniedNestedWatchdog.status, JSON.stringify(deniedNestedWatchdog.body)).toBe(403);
    expect(deniedNestedWatchdog.body.error).toBe("Task-watchdog runs cannot change watchdog configuration.");

    const deniedWatchdogRemoval = await request(app).delete(`/api/issues/${watchedRootId}/watchdog`);
    expect(deniedWatchdogRemoval.status, JSON.stringify(deniedWatchdogRemoval.body)).toBe(403);
    expect(deniedWatchdogRemoval.body.error).toBe("Task-watchdog runs cannot change watchdog configuration.");

    const nestedWatchdogs = await db
      .select({ id: issueWatchdogs.id })
      .from(issueWatchdogs)
      .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, watchedChildId)));
    expect(nestedWatchdogs).toHaveLength(0);

    const allowedChild = await request(app)
      .post(`/api/issues/${watchedChildId}/children`)
      .send({ title: "Allowed watched child" });
    expect(allowedChild.status, JSON.stringify(allowedChild.body)).toBe(201);
    expect(allowedChild.body.parentId).toBe(watchedChildId);
  });

  it("lets a watchdog PATCH a stopped issue after clearing terminal stale ownership", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: fixture.sourceIssueId,
      status: "done",
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
    const [audit] = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, fixture.companyId),
      eq(activityLog.entityId, fixture.sourceIssueId),
      eq(activityLog.action, "issue.task_watchdog_stale_ownership_cleared"),
    ));
    expect(audit).toMatchObject({
      actorType: "system",
      actorId: "task_watchdog_recovery",
      agentId: fixture.watchdogAgentId,
      runId: fixture.watchdogRunId,
      details: {
        clearedCheckoutRunId: fixture.staleRunId,
        clearedExecutionRunId: fixture.staleRunId,
        referencedRunStatuses: { [fixture.staleRunId]: "failed" },
      },
    });
  });

  it("accepts the server-owned reusable-watchdog blocker transition for source recovery", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress");
    await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId: fixture.companyId });
    const [run, persistedWatchdog] = await Promise.all([
      db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, fixture.watchdogRunId))
        .then((rows) => rows[0]),
      db.select({ lastObservedFingerprint: issueWatchdogs.lastObservedFingerprint })
        .from(issueWatchdogs)
        .where(eq(issueWatchdogs.issueId, fixture.sourceIssueId))
        .then((rows) => rows[0]),
    ]);
    expect((run?.contextSnapshot as any)?.taskWatchdog?.stopFingerprint).not.toBe(
      persistedWatchdog?.lastObservedFingerprint,
    );

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: fixture.sourceIssueId,
      status: "blocked",
      executionPolicy: null,
      checkoutRunId: null,
      executionRunId: null,
    });
    const blockerRelations = await db.select().from(issueRelations).where(and(
      eq(issueRelations.companyId, fixture.companyId),
      eq(issueRelations.issueId, fixture.watchdogIssueId),
      eq(issueRelations.relatedIssueId, fixture.sourceIssueId),
      eq(issueRelations.type, "blocks"),
    ));
    expect(blockerRelations).toHaveLength(1);
    const [audit] = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, fixture.companyId),
      eq(activityLog.entityId, fixture.sourceIssueId),
      eq(activityLog.action, "issue.updated"),
      eq(activityLog.runId, fixture.watchdogRunId),
    ));
    expect(audit).toMatchObject({
      actorType: "agent",
      agentId: fixture.watchdogAgentId,
      runId: fixture.watchdogRunId,
    });
  });

  it("keeps the same watchdog run authorized across its bounded recovery batch", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });

    const first = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ priority: "high" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const second = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ billingCode: "watchdog-recovery" });
    expect(second.status, JSON.stringify(second.body)).toBe(200);

    const third = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ priority: "critical" });
    expect(third.status, JSON.stringify(third.body)).toBe(200);

    const fourth = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ billingCode: "must-not-commit" });
    expect(fourth.status, JSON.stringify(fourth.body)).toBe(409);
    expect(second.body).toMatchObject({
      priority: "high",
      billingCode: "watchdog-recovery",
    });

    const [source] = await db
      .select({ priority: issues.priority, billingCode: issues.billingCode })
      .from(issues)
      .where(eq(issues.id, fixture.sourceIssueId));
    expect(source).toEqual({
      priority: "critical",
      billingCode: "watchdog-recovery",
    });

    const ownActivities = await db
      .select({ runId: activityLog.runId })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, fixture.companyId),
        eq(activityLog.entityId, fixture.sourceIssueId),
        eq(activityLog.action, "issue.updated"),
        eq(activityLog.runId, fixture.watchdogRunId),
      ));
    expect(ownActivities).toHaveLength(3);
  });

  it("rejects recovery provenance superseded by a later user source transition", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress", {
      createdAt: new Date(Date.now() - 5_000),
    });
    const boardApp = createApp(fixture.companyId);
    const todo = await request(boardApp)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ status: "todo" });
    expect(todo.status, JSON.stringify(todo.body)).toBe(200);
    const blocked = await request(boardApp)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ status: "blocked" });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
    expect(source?.executionPolicy).toEqual({ mode: "auto" });
  });

  it("rejects a watchdog mutation after a descendant material boundary", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({
      sourceStatus: "in_progress",
      sourceChild: true,
    });
    expect(fixture.sourceChildId).not.toBeNull();
    await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress", {
      createdAt: new Date(Date.now() - 5_000),
    });
    const canonicalBoundary = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceChildId}`)
      .send({ priority: "medium" });
    expect(canonicalBoundary.status, JSON.stringify(canonicalBoundary.body)).toBe(200);

    const boardApp = createApp(fixture.companyId);
    const boardMutation = await request(boardApp)
      .patch(`/api/issues/${fixture.sourceChildId}`)
      .send({ priority: "high" });
    expect(boardMutation.status, JSON.stringify(boardMutation.body)).toBe(200);

    const watchdogMutation = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceChildId}`)
      .send({ priority: "low" });

    expect(watchdogMutation.status, JSON.stringify(watchdogMutation.body)).toBe(409);
    const [child] = await db
      .select({ priority: issues.priority })
      .from(issues)
      .where(eq(issues.id, fixture.sourceChildId!));
    expect(child?.priority).toBe("high");
  });

  it("locks every mutable descendant before transactional watchdog revalidation", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({
      sourceStatus: "in_progress",
      sourceChild: true,
    });
    const untargetedDescendantId = fixture.sourceChildId!;

    let requestSettled = false;
    let watchdogRequest!: Promise<request.Response>;
    await db.transaction(async (tx) => {
      await tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, untargetedDescendantId))
        .for("update");

      watchdogRequest = request(fixture.app)
        .patch(`/api/issues/${fixture.sourceIssueId}`)
        .send({ priority: "low" })
        .then((response) => {
          requestSettled = true;
          return response;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(requestSettled).toBe(false);

      const boundaryAt = new Date();
      await tx.update(issues)
        .set({ priority: "high", updatedAt: boundaryAt })
        .where(eq(issues.id, untargetedDescendantId));
      await tx.insert(activityLog).values({
        companyId: fixture.companyId,
        actorType: "user",
        actorId: "concurrent-board-user",
        action: "issue.updated",
        entityType: "issue",
        entityId: untargetedDescendantId,
        details: { priority: "high" },
        createdAt: boundaryAt,
      });
    });

    const res = await watchdogRequest;
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [target, sibling] = await Promise.all([
      db.select({ priority: issues.priority }).from(issues)
        .where(eq(issues.id, fixture.sourceIssueId)).then((rows) => rows[0]),
      db.select({ priority: issues.priority }).from(issues)
        .where(eq(issues.id, untargetedDescendantId)).then((rows) => rows[0]),
    ]);
    expect(target?.priority).toBe("medium");
    expect(sibling?.priority).toBe("high");
  });

  it("rejects recovery provenance superseded by a later unrelated agent run transition", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress", {
      createdAt: new Date(Date.now() - 5_000),
    });
    const unrelatedAgentId = await seedAgent(fixture.companyId, { name: "Unrelated transition agent" });
    const unrelatedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: unrelatedRunId,
      companyId: fixture.companyId,
      agentId: unrelatedAgentId,
      status: "succeeded",
      finishedAt: new Date(),
      contextSnapshot: { issueId: fixture.sourceIssueId },
    });
    await db.insert(activityLog).values({
      companyId: fixture.companyId,
      actorType: "agent",
      actorId: unrelatedAgentId,
      agentId: unrelatedAgentId,
      runId: unrelatedRunId,
      action: "issue.updated",
      entityType: "issue",
      entityId: fixture.sourceIssueId,
      details: {
        status: "blocked",
        previousStatus: "todo",
        blockedByIssueIds: [fixture.watchdogIssueId],
      },
      createdAt: new Date(),
    });

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
    expect(source?.executionPolicy).toEqual({ mode: "auto" });
  });

  it("rejects recovery provenance superseded by plugin-host issue patch transitions", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress", {
      createdAt: new Date(Date.now() - 5_000),
    });
    const transitionAt = Date.now();
    await db.insert(activityLog).values([
      {
        companyId: fixture.companyId,
        actorType: "plugin",
        actorId: "test-plugin",
        action: "issue.updated",
        entityType: "issue",
        entityId: fixture.sourceIssueId,
        details: {
          patch: { status: "todo" },
          _previous: { status: "blocked" },
        },
        createdAt: new Date(transitionAt),
      },
      {
        companyId: fixture.companyId,
        actorType: "plugin",
        actorId: "test-plugin",
        action: "issue.updated",
        entityType: "issue",
        entityId: fixture.sourceIssueId,
        details: {
          patch: { status: "blocked" },
          _previous: { status: "todo" },
        },
        createdAt: new Date(transitionAt + 1),
      },
    ]);

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
    expect(source?.executionPolicy).toEqual({ mode: "auto" });
  });

  it("rejects a watchdog blocker edge whose agent provenance survives creator deletion", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    const unrelatedAgentId = await seedAgent(fixture.companyId, { name: "Deleted blocker author" });
    const transitionAt = new Date(Date.now() - 5_000);
    await db.update(issues).set({
      status: "blocked",
      executionPolicy: { mode: "auto" },
    }).where(eq(issues.id, fixture.sourceIssueId));
    await db.insert(issueRelations).values({
      companyId: fixture.companyId,
      issueId: fixture.watchdogIssueId,
      relatedIssueId: fixture.sourceIssueId,
      type: "blocks",
      createdByActorType: "agent",
      createdByAgentId: unrelatedAgentId,
      createdAt: new Date(transitionAt.getTime() - 1),
    });
    await db.delete(agents).where(eq(agents.id, unrelatedAgentId));
    await db.insert(activityLog).values({
      companyId: fixture.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.updated",
      entityType: "issue",
      entityId: fixture.sourceIssueId,
      details: {
        source: "recovery.reconcile_continuation_waiting_on_review",
        status: "blocked",
        previousStatus: "in_progress",
        blockedByIssueIds: [fixture.watchdogIssueId],
      },
      createdAt: transitionAt,
    });

    const [persistedEdge] = await db.select({
      createdByActorType: issueRelations.createdByActorType,
      createdByAgentId: issueRelations.createdByAgentId,
    }).from(issueRelations).where(and(
      eq(issueRelations.companyId, fixture.companyId),
      eq(issueRelations.issueId, fixture.watchdogIssueId),
      eq(issueRelations.relatedIssueId, fixture.sourceIssueId),
    ));
    expect(persistedEdge).toEqual({ createdByActorType: "agent", createdByAgentId: null });

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
    expect(source?.executionPolicy).toEqual({ mode: "auto" });
  });

  it.each([
    ["title", { title: "Board-renamed source" }],
    ["description", { description: "Board-authored source details" }],
    ["priority", { priority: "high" }],
  ] as const)("rejects watchdog recovery authority after a board %s edit", async (_field, patch) => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress", {
      createdAt: new Date(Date.now() - 5_000),
    });
    const contentUpdate = await request(createApp(fixture.companyId))
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send(patch);
    expect(contentUpdate.status, JSON.stringify(contentUpdate.body)).toBe(200);

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
    expect(source).toMatchObject(patch);
    expect(source?.executionPolicy).toEqual({ mode: "auto" });
  });

  it("uses the immutable run trigger when the shared watchdog timestamp advances", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    const boardEditAt = new Date(fixture.watchdogTriggeredAt.getTime() + 10_000);
    await db.update(issues)
      .set({ title: "Board edit after run snapshot" })
      .where(eq(issues.id, fixture.sourceIssueId));
    await db.insert(activityLog).values({
      companyId: fixture.companyId,
      actorType: "user",
      actorId: "outside-board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: fixture.sourceIssueId,
      details: { title: "Board edit after run snapshot" },
      createdAt: boardEditAt,
    });
    await db.update(issueWatchdogs)
      .set({ lastTriggeredAt: new Date(boardEditAt.getTime() + 10_000) })
      .where(eq(issueWatchdogs.issueId, fixture.sourceIssueId));

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ title: "Stale watchdog overwrite" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
    expect(source?.title).toBe("Board edit after run snapshot");
  });

  it("rejects watchdog recovery after a content edit that resubmits an unchanged policy", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    const unchangedPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [{
        id: randomUUID(),
        type: "review",
        approvalsNeeded: 1,
        participants: [{
          id: randomUUID(),
          type: "agent",
          agentId: fixture.watchdogAgentId,
          userId: null,
        }],
      }],
    };
    await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress", {
      createdAt: new Date(Date.now() - 5_000),
      executionPolicy: unchangedPolicy,
    });
    const titleUpdate = await request(createApp(fixture.companyId))
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({
        title: "Renamed with unchanged policy",
        executionPolicy: unchangedPolicy,
      });
    expect(titleUpdate.status, JSON.stringify(titleUpdate.body)).toBe(200);
    expect(titleUpdate.body.changes).not.toHaveProperty("executionPolicy");

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
    expect(source).toMatchObject({
      status: "blocked",
      title: "Renamed with unchanged policy",
      executionPolicy: unchangedPolicy,
    });
  });

  it("rejects recovery provenance superseded by an execution-policy edit", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress", {
      createdAt: new Date(Date.now() - 5_000),
    });
    const policyUpdate = await request(createApp(fixture.companyId))
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({
        executionPolicy: {
          mode: "normal",
          stages: [{
            type: "review",
            participants: [{ type: "agent", agentId: fixture.watchdogAgentId }],
          }],
        },
      });
    expect(policyUpdate.status, JSON.stringify(policyUpdate.body)).toBe(200);

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
    expect(source?.executionPolicy).toMatchObject({
      mode: "normal",
      stages: [{
        type: "review",
        participants: [{ type: "agent", agentId: fixture.watchdogAgentId }],
      }],
    });
  });

  it("rejects an unseen execution-policy edit whose activity timestamp predates the watchdog snapshot", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress", {
      createdAt: new Date(Date.now() - 5_000),
    });
    const executionPolicy = {
      mode: "normal",
      stages: [{
        type: "review",
        participants: [{ type: "agent", agentId: fixture.watchdogAgentId }],
      }],
    };
    await db.update(issues)
      .set({ executionPolicy })
      .where(eq(issues.id, fixture.sourceIssueId));
    await db.insert(activityLog).values({
      companyId: fixture.companyId,
      actorType: "user",
      actorId: "transaction-started-before-watchdog",
      action: "issue.updated",
      entityType: "issue",
      entityId: fixture.sourceIssueId,
      details: { executionPolicy },
      createdAt: new Date(fixture.watchdogTriggeredAt.getTime() - 1_000),
    });

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
    expect(source?.executionPolicy).toEqual(executionPolicy);
  });

  it("fails closed when a persisted watchdog run lacks its recovery activity boundary", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    const [run] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.watchdogRunId));
    const contextSnapshot = structuredClone(run?.contextSnapshot) as {
      taskWatchdog?: { recoveryActivityBoundary?: unknown };
    };
    delete contextSnapshot.taskWatchdog?.recoveryActivityBoundary;
    await db.update(heartbeatRuns)
      .set({ contextSnapshot })
      .where(eq(heartbeatRuns.id, fixture.watchdogRunId));

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ priority: "high" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [source] = await db.select({ priority: issues.priority })
      .from(issues)
      .where(eq(issues.id, fixture.sourceIssueId));
    expect(source?.priority).toBe("medium");
  });

  it.each([
    ["interaction", "issue.thread_interaction_created", "issue.thread_interaction_accepted"],
    ["approval", "issue.approval_linked", "issue.approval_unlinked"],
  ] as const)(
    "rejects recovery provenance superseded by a completed %s wait lifecycle",
    async (_kind, openedAction, closedAction) => {
      const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
      await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress", {
        createdAt: new Date(Date.now() - 5_000),
      });
      const interactionId = _kind === "interaction" ? randomUUID() : null;
      const approvalId = _kind === "approval" ? randomUUID() : null;
      if (interactionId) {
        await db.insert(issueThreadInteractions).values({
          id: interactionId,
          companyId: fixture.companyId,
          issueId: fixture.sourceIssueId,
          kind: "request_confirmation",
          status: "accepted",
          continuationPolicy: "wake_assignee_on_accept",
          payload: { version: 1, prompt: "Continue?" },
        });
      }
      if (approvalId) {
        await db.insert(approvals).values({
          id: approvalId,
          companyId: fixture.companyId,
          type: "task",
          status: "pending",
          payload: {},
        });
      }
      await db.insert(activityLog).values([
        {
          companyId: fixture.companyId,
          actorType: "user",
          actorId: "outside-board-user",
          action: openedAction,
          entityType: "issue",
          entityId: fixture.sourceIssueId,
          details: interactionId ? { interactionId } : { approvalId },
          createdAt: new Date(Date.now() - 2_000),
        },
        {
          companyId: fixture.companyId,
          actorType: "user",
          actorId: "outside-board-user",
          action: closedAction,
          entityType: "issue",
          entityId: fixture.sourceIssueId,
          details: interactionId ? { interactionId } : { approvalId },
          createdAt: new Date(Date.now() - 1_000),
        },
      ]);

      const res = await request(fixture.app)
        .patch(`/api/issues/${fixture.sourceIssueId}`)
        .send({ executionPolicy: null });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
      expect(source?.executionPolicy).toEqual({ mode: "auto" });
    },
  );

  it.each([
    "issue.document_created",
    "issue.document_updated",
    "issue.document_upserted",
    "issue.document_restored",
    "issue.document_deleted",
    "issue.attachment_added",
    "issue.attachment_removed",
    "issue.work_product_created",
    "issue.work_product_updated",
    "issue.work_product_deleted",
  ] as const)("rejects recovery provenance superseded by %s", async (action) => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress", {
      createdAt: new Date(Date.now() - 5_000),
    });
    await db.insert(activityLog).values({
      companyId: fixture.companyId,
      actorType: "user",
      actorId: "outside-board-user",
      action,
      entityType: "issue",
      entityId: fixture.sourceIssueId,
      details: action.startsWith("issue.document_")
        ? { documentId: randomUUID() }
        : action.startsWith("issue.attachment_")
          ? { attachmentId: randomUUID() }
          : { workProductId: randomUUID() },
      createdAt: new Date(Date.now() - 1_000),
    });

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
    expect(source?.executionPolicy).toEqual({ mode: "auto" });
  });

  it("keeps recovery authority across a non-waking interaction lifecycle", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress", {
      createdAt: new Date(Date.now() - 5_000),
    });
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId: fixture.companyId,
      issueId: fixture.sourceIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "none",
      payload: { version: 1, prompt: "Informational only" },
    });
    await db.insert(activityLog).values([
      {
        companyId: fixture.companyId,
        actorType: "user",
        actorId: "outside-board-user",
        action: "issue.thread_interaction_created",
        entityType: "issue",
        entityId: fixture.sourceIssueId,
        details: { interactionId },
        createdAt: new Date(Date.now() - 2_000),
      },
      {
        companyId: fixture.companyId,
        actorType: "user",
        actorId: "outside-board-user",
        action: "issue.thread_interaction_accepted",
        entityType: "issue",
        entityId: fixture.sourceIssueId,
        details: { interactionId },
        createdAt: new Date(Date.now() - 1_000),
      },
    ]);

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.executionPolicy).toBeNull();
  });

  it.each([
    ["an already-approved link", "approved", false, "issue.approval_linked"],
    ["a repeated pending link", "pending", true, "issue.approval_linked"],
    ["a missing pending unlink", "pending", false, "issue.approval_unlinked"],
  ] as const)(
    "keeps recovery authority across %s that does not change a wait",
    async (_label, approvalStatus, sourcePendingApproval, action) => {
      const fixture = await seedWatchdogMutationWithStaleOwnership({
        sourceStatus: "in_progress",
        sourcePendingApproval,
      });
      await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress", {
        createdAt: new Date(Date.now() - 5_000),
      });
      const approvalId = fixture.sourceApprovalId ?? randomUUID();
      if (!fixture.sourceApprovalId) {
        await db.insert(approvals).values({
          id: approvalId,
          companyId: fixture.companyId,
          type: "task",
          status: approvalStatus,
          payload: {},
        });
      }
      await db.insert(activityLog).values({
        companyId: fixture.companyId,
        actorType: "user",
        actorId: "outside-board-user",
        action,
        entityType: "issue",
        entityId: fixture.sourceIssueId,
        details: { approvalId },
        createdAt: new Date(Date.now() - 1_000),
      });

      const res = await request(fixture.app)
        .patch(`/api/issues/${fixture.sourceIssueId}`)
        .send({ executionPolicy: null });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.executionPolicy).toBeNull();
    },
  );

  it("rejects recovery provenance superseded by a linked approval decision cycle", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({
      sourceStatus: "in_progress",
      sourcePendingApproval: true,
    });
    await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress", {
      createdAt: new Date(Date.now() - 5_000),
    });
    await db.update(approvals)
      .set({ status: "revision_requested" })
      .where(eq(approvals.id, fixture.sourceApprovalId!));
    await db.insert(activityLog).values({
      companyId: fixture.companyId,
      actorType: "user",
      actorId: "outside-board-user",
      action: "approval.revision_requested",
      entityType: "approval",
      entityId: fixture.sourceApprovalId!,
      details: {},
      createdAt: new Date(Date.now() - 2_000),
    });
    await db.update(approvals)
      .set({ status: "pending" })
      .where(eq(approvals.id, fixture.sourceApprovalId!));
    await db.insert(activityLog).values({
      companyId: fixture.companyId,
      actorType: "agent",
      actorId: fixture.ownerAgentId,
      agentId: fixture.ownerAgentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: fixture.sourceApprovalId!,
      details: {},
      createdAt: new Date(Date.now() - 1_000),
    });

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
    expect(source?.executionPolicy).toEqual({ mode: "auto" });
  });

  it("rejects recovery provenance superseded by a linked approval cancellation", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({
      sourceStatus: "in_progress",
      sourcePendingApproval: true,
    });
    await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress", {
      createdAt: new Date(Date.now() - 5_000),
    });
    await db.update(approvals)
      .set({ status: "cancelled" })
      .where(eq(approvals.id, fixture.sourceApprovalId!));
    await db.insert(activityLog).values({
      companyId: fixture.companyId,
      actorType: "system",
      actorId: "built-in-agents",
      action: "approval.cancelled",
      entityType: "approval",
      entityId: fixture.sourceApprovalId!,
      details: { reason: "Duplicate cleanup" },
      createdAt: new Date(Date.now() - 1_000),
    });

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
    expect(source?.executionPolicy).toEqual({ mode: "auto" });
  });

  it("accepts a server-owned blocker transition that returns to an already-reviewed snapshot", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress");
    await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId: fixture.companyId });
    const [observed] = await db
      .select({
        fingerprint: issueWatchdogs.lastObservedFingerprint,
        snapshot: issueWatchdogs.lastObservedStopSnapshot,
      })
      .from(issueWatchdogs)
      .where(eq(issueWatchdogs.issueId, fixture.sourceIssueId));
    await db
      .update(issueWatchdogs)
      .set({
        lastReviewedFingerprint: observed?.fingerprint,
        lastReviewedStopSnapshot: observed?.snapshot,
      })
      .where(eq(issueWatchdogs.issueId, fixture.sourceIssueId));

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: fixture.sourceIssueId,
      status: "blocked",
      executionPolicy: null,
    });
  });

  it.each(
    [
      ["outside board user", { createdByUserId: "outside-board-user" }],
      ["unrelated agent", { createAgent: true }],
    ] as Array<[string, { createdByUserId?: string; createAgent?: boolean }]>,
  )("rejects a reusable-watchdog blocker transition created by an %s", async (_label, creator) => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    const unrelatedAgentId = creator.createAgent
      ? await seedAgent(fixture.companyId, { name: "Unrelated recovery actor" })
      : null;
    const unrelatedRunId = unrelatedAgentId ? randomUUID() : null;
    if (unrelatedAgentId && unrelatedRunId) {
      await db.insert(heartbeatRuns).values({
        id: unrelatedRunId,
        companyId: fixture.companyId,
        agentId: unrelatedAgentId,
        status: "succeeded",
        finishedAt: new Date(),
        contextSnapshot: { issueId: fixture.sourceIssueId },
      });
    }
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, fixture.sourceIssueId));
    await db.insert(issueRelations).values({
      companyId: fixture.companyId,
      issueId: fixture.watchdogIssueId,
      relatedIssueId: fixture.sourceIssueId,
      type: "blocks",
      createdByAgentId: unrelatedAgentId,
      createdByUserId: creator.createdByUserId ?? null,
    });
    await db.insert(activityLog).values({
      companyId: fixture.companyId,
      actorType: unrelatedAgentId ? "agent" : "user",
      actorId: unrelatedAgentId ?? creator.createdByUserId ?? "outside",
      agentId: unrelatedAgentId,
      runId: unrelatedRunId,
      action: "issue.updated",
      entityType: "issue",
      entityId: fixture.sourceIssueId,
      details: {
        status: "blocked",
        previousStatus: "in_progress",
        blockedByIssueIds: [fixture.watchdogIssueId],
      },
    });

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ title: "Must remain unchanged" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
    expect(source?.title).toBe("Stopped source");
  });

  it("accepts an attributable status-only transition when the reusable blocker predates the wake", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({
      sourceStatus: "in_progress",
      preexistingWatchdogBlocker: true,
    });
    await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress");

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: fixture.sourceIssueId,
      status: "blocked",
      executionPolicy: null,
    });
  });

  it.each(["done", "cancelled"] as const)(
    "accepts an attributable reusable-blocker transition from terminal status %s",
    async (sourceStatus) => {
      const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus });
      await recordServerOwnedWatchdogBlockerTransition(fixture, sourceStatus);

      const res = await request(fixture.app)
        .patch(`/api/issues/${fixture.sourceIssueId}`)
        .send({ executionPolicy: null });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        id: fixture.sourceIssueId,
        status: "blocked",
        executionPolicy: null,
      });
    },
  );

  it("accepts recovery provenance recorded after the watchdog trigger but before run creation", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    const recoveryCreatedAt = new Date(
      fixture.watchdogTriggeredAt.getTime() +
      (fixture.watchdogRunCreatedAt.getTime() - fixture.watchdogTriggeredAt.getTime()) / 2,
    );
    await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress", {
      createdAt: recoveryCreatedAt,
    });

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(recoveryCreatedAt.getTime()).toBeLessThan(fixture.watchdogRunCreatedAt.getTime());
    expect(res.body).toMatchObject({
      id: fixture.sourceIssueId,
      status: "blocked",
      executionPolicy: null,
    });
  });

  it("accepts unchanged terminal-source waits represented only in the leaf summary", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({
      sourceStatus: "done",
      sourcePendingApproval: true,
    });
    await recordServerOwnedWatchdogBlockerTransition(fixture, "done");

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(fixture.sourceApprovalId).not.toBeNull();
    const linkedApprovals = await db.select().from(issueApprovals).where(and(
      eq(issueApprovals.issueId, fixture.sourceIssueId),
      eq(issueApprovals.approvalId, fixture.sourceApprovalId!),
    ));
    expect(linkedApprovals).toHaveLength(1);
  });

  it("rejects the reusable-blocker exception after the authorizing watchdog run completes", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress");
    await db.update(heartbeatRuns).set({
      status: "succeeded",
      finishedAt: new Date(),
    }).where(eq(heartbeatRuns.id, fixture.watchdogRunId));

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
    expect(source?.executionPolicy).toEqual({ mode: "auto" });
  });

  it("accepts server recovery that removes a terminal observed blocker", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({
      sourceStatus: "in_progress",
      preexistingResolvedBlocker: true,
    });
    await recordServerOwnedWatchdogBlockerTransition(fixture, "in_progress");

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const blockerRelations = await db.select().from(issueRelations).where(and(
      eq(issueRelations.companyId, fixture.companyId),
      eq(issueRelations.relatedIssueId, fixture.sourceIssueId),
      eq(issueRelations.type, "blocks"),
    ));
    expect(blockerRelations.map((relation) => relation.issueId)).toEqual([fixture.watchdogIssueId]);
  });

  it("rejects an old run after its immutable reusable watchdog issue is replaced", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    await db.delete(issues).where(eq(issues.id, fixture.watchdogIssueId));
    const replacementWatchdogIssueId = await seedIssue(fixture.companyId, {
      title: "Replacement reusable watchdog issue",
      parentId: fixture.sourceIssueId,
      assigneeAgentId: fixture.watchdogAgentId,
      originKind: "task_watchdog",
      originId: fixture.sourceIssueId,
    });
    await db.update(issueWatchdogs).set({
      watchdogIssueId: replacementWatchdogIssueId,
      lastTriggeredAt: new Date(),
    }).where(eq(issueWatchdogs.issueId, fixture.sourceIssueId));
    await recordServerOwnedWatchdogBlockerTransition({
      ...fixture,
      watchdogIssueId: replacementWatchdogIssueId,
    }, "in_progress");

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ executionPolicy: null });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
    expect(source?.executionPolicy).toEqual({ mode: "auto" });
  });

  it("rejects a source mutation when another blocker changes the self-blocked fingerprint", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    const concurrentBlockerId = await seedIssue(fixture.companyId, {
      title: "Concurrent outside blocker",
      status: "in_progress",
      assigneeAgentId: fixture.ownerAgentId,
    });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, fixture.sourceIssueId));
    await db.insert(issueRelations).values([
      {
        companyId: fixture.companyId,
        issueId: fixture.watchdogIssueId,
        relatedIssueId: fixture.sourceIssueId,
        type: "blocks",
      },
      {
        companyId: fixture.companyId,
        issueId: concurrentBlockerId,
        relatedIssueId: fixture.sourceIssueId,
        type: "blocks",
      },
    ]);

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({ title: "Must remain unchanged" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      error: "Task-watchdog review is stale because the watched subtree stop fingerprint changed; refresh the source state before mutating it.",
      details: {
        currentState: "stopped",
      },
    });
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
    expect(source?.title).toBe("Stopped source");
  });

  it("lets a watchdog add a disposition-only comment after clearing terminal stale ownership", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "done" });

    const res = await request(fixture.app)
      .post(`/api/issues/${fixture.sourceIssueId}/comments`)
      .send({ body: "Stopped disposition is verified; stale ownership was recovered." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      issueId: fixture.sourceIssueId,
      body: "Stopped disposition is verified; stale ownership was recovered.",
    });
    const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
    expect(source).toMatchObject({
      status: "done",
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
    const [audit] = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, fixture.companyId),
      eq(activityLog.entityId, fixture.sourceIssueId),
      eq(activityLog.action, "issue.task_watchdog_stale_ownership_cleared"),
    ));
    expect(audit).toMatchObject({
      runId: fixture.watchdogRunId,
      details: {
        clearedCheckoutRunId: fixture.staleRunId,
        clearedExecutionRunId: fixture.staleRunId,
        referencedRunStatuses: { [fixture.staleRunId]: "failed" },
      },
    });
  });

  it("ignores the current watchdog checkout on the reusable watchdog issue during source recovery", async () => {
    const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "in_progress" });
    const recoveryAgentId = await seedAgent(fixture.companyId, { name: "Recovery owner" });
    await db.insert(principalPermissionGrants).values({
      companyId: fixture.companyId,
      principalType: "agent",
      principalId: fixture.watchdogAgentId,
      permissionKey: "tasks:assign",
    });
    await db.update(issues).set({
      status: "in_progress",
      checkoutRunId: fixture.watchdogRunId,
      executionRunId: fixture.watchdogRunId,
      executionAgentNameKey: "recovery-watchdog",
      executionLockedAt: new Date(),
    }).where(eq(issues.id, fixture.watchdogIssueId));

    const res = await request(fixture.app)
      .patch(`/api/issues/${fixture.sourceIssueId}`)
      .send({
        status: "todo",
        assigneeAgentId: recoveryAgentId,
        comment: "Recovered the source path and handed it back to an invokable owner.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: fixture.sourceIssueId,
      status: "todo",
      assigneeAgentId: recoveryAgentId,
      checkoutRunId: null,
      executionRunId: null,
    });
    const [recoveryComment] = await db.select().from(issueComments).where(and(
      eq(issueComments.issueId, fixture.sourceIssueId),
      eq(issueComments.authorAgentId, fixture.watchdogAgentId),
    ));
    expect(recoveryComment).toMatchObject({
      body: "Recovered the source path and handed it back to an invokable owner.",
      authorAgentId: fixture.watchdogAgentId,
    });
    const [watchdogIssue] = await db.select().from(issues).where(eq(issues.id, fixture.watchdogIssueId));
    expect(watchdogIssue).toMatchObject({
      status: "in_progress",
      checkoutRunId: fixture.watchdogRunId,
      executionRunId: fixture.watchdogRunId,
    });
  });

  it.each([
    ["checkoutRunId", "queued"],
    ["checkoutRunId", "running"],
    ["checkoutRunId", "scheduled_retry"],
    ["executionRunId", "queued"],
    ["executionRunId", "running"],
    ["executionRunId", "scheduled_retry"],
  ] as const)(
    "keeps a cross-issue %s owned by a same-company %s run and denies the watchdog PATCH",
    async (ownershipField, status) => {
      const fixture = await seedWatchdogMutationWithStaleOwnership({ sourceStatus: "done" });
      const contextIssueId = await seedIssue(fixture.companyId, {
        title: "Live owner's original issue",
        status: "in_progress",
        assigneeAgentId: fixture.ownerAgentId,
      });
      const liveRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: liveRunId,
        companyId: fixture.companyId,
        agentId: fixture.ownerAgentId,
        status,
        invocationSource: "assignment",
        startedAt: status === "running" ? new Date() : undefined,
        scheduledRetryAt: status === "scheduled_retry" ? new Date(Date.now() + 60_000) : undefined,
        contextSnapshot: { issueId: contextIssueId },
      });
      await db.update(issues).set({
        checkoutRunId: ownershipField === "checkoutRunId" ? liveRunId : null,
        executionRunId: ownershipField === "executionRunId" ? liveRunId : null,
        executionAgentNameKey: "live-owner",
        executionLockedAt: new Date(),
      }).where(eq(issues.id, fixture.sourceIssueId));
      await db.update(issues).set({
        status: "in_progress",
        checkoutRunId: fixture.watchdogRunId,
        executionRunId: fixture.watchdogRunId,
        executionAgentNameKey: "recovery-watchdog",
        executionLockedAt: new Date(),
      }).where(eq(issues.id, fixture.watchdogIssueId));

      const res = await request(fixture.app)
        .patch(`/api/issues/${fixture.sourceIssueId}`)
        .send({ title: "Must remain unchanged" });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.details).toMatchObject({ currentState: "live" });
      const [source] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
      expect(source).toMatchObject({
        checkoutRunId: ownershipField === "checkoutRunId" ? liveRunId : null,
        executionRunId: ownershipField === "executionRunId" ? liveRunId : null,
        executionAgentNameKey: "live-owner",
      });
      const [watchdogIssue] = await db.select().from(issues).where(eq(issues.id, fixture.watchdogIssueId));
      expect(watchdogIssue).toMatchObject({
        status: "in_progress",
        checkoutRunId: fixture.watchdogRunId,
        executionRunId: fixture.watchdogRunId,
      });
      const cleanupAudits = await db.select().from(activityLog).where(and(
        eq(activityLog.companyId, fixture.companyId),
        eq(activityLog.entityId, fixture.sourceIssueId),
        eq(activityLog.action, "issue.task_watchdog_stale_ownership_cleared"),
      ));
      expect(cleanupAudits).toHaveLength(0);
    },
  );

  it("routes watchdog-discovered product bugs outside the watched source tree with evidence links", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Product Bug Watchdog" });
    const watchedRootId = await seedIssue(companyId, {
      title: "Watched root",
      identifier: "PAP-100",
      issueNumber: 100,
    });
    const watchedChildId = await seedIssue(companyId, {
      title: "Watched child",
      identifier: "PAP-101",
      issueNumber: 101,
      parentId: watchedRootId,
    });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      identifier: "PAP-102",
      issueNumber: 102,
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const runId = await seedWatchdogRun({
      companyId,
      watchdogAgentId,
      watchedIssueId: watchedRootId,
      watchdogIssueId,
    });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Fix watchdog source-tree pollution",
        description: "Watchdog found a Paperclip follow-up routing bug.",
        parentId: watchedChildId,
        watchdogDiscovery: {
          kind: "product_bug",
          evidenceMarkdown: "The watchdog would otherwise create this under the watched child.",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      title: "Fix watchdog source-tree pollution",
      parentId: null,
      originKind: "task_watchdog_product_bug",
      originId: watchedRootId,
      originRunId: runId,
    });
    expect(res.body.description).toContain("## Watchdog Discovery");
    expect(res.body.description).toContain("Watched source issue: [PAP-100](/PAP/issues/PAP-100)");
    expect(res.body.description).toContain("Watchdog issue: [PAP-102](/PAP/issues/PAP-102)");
    expect(res.body.referencedIssueIdentifiers).toEqual(expect.arrayContaining(["PAP-100", "PAP-102"]));

    const watchedSourceChildren = await db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.parentId, watchedChildId)));
    expect(watchedSourceChildren).toHaveLength(0);

    const [createdActivity] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, res.body.id)));
    expect(createdActivity?.details).toMatchObject({
      watchdogDiscovery: {
        kind: "product_bug",
        sourceIssueId: watchedRootId,
        watchdogIssueId,
      },
    });
  });

  it("rejects watchdog interaction-resolution attempts outside the persisted watched subtree", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Interaction Watchdog" });
    const watchedRootId = await seedIssue(companyId, { title: "Watched root" });
    const unrelatedRootId = await seedIssue(companyId, { title: "Unrelated root" });
    const watchdogIssueId = await seedIssue(companyId, { title: "Reusable watchdog issue" });
    const runId = await seedWatchdogRun({
      companyId,
      watchdogAgentId,
      watchedIssueId: watchedRootId,
      watchdogIssueId,
    });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const res = await request(app)
      .post(`/api/issues/${unrelatedRootId}/interactions/${randomUUID()}/accept`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Task-watchdog runs can only mutate the watched issue subtree.");
  });

  it("rejects cross-company watched issues and watchdog agents", async () => {
    const companyId = await seedCompany("Allowed company");
    const otherCompanyId = await seedCompany("Other company");
    const issueId = await seedIssue(companyId);
    const otherIssueId = await seedIssue(otherCompanyId);
    const otherAgentId = await seedAgent(otherCompanyId);
    const app = createApp(companyId);

    const foreignIssue = await request(app)
      .put(`/api/issues/${otherIssueId}/watchdog`)
      .send({ agentId: otherAgentId });
    // Uniform 404 so cross-tenant ids are indistinguishable from missing ones.
    expect(foreignIssue.status, JSON.stringify(foreignIssue.body)).toBe(404);
    expect(foreignIssue.body.error).toBe("Issue not found");

    const foreignAgent = await request(app)
      .put(`/api/issues/${issueId}/watchdog`)
      .send({ agentId: otherAgentId });
    expect(foreignAgent.status, JSON.stringify(foreignAgent.body)).toBe(404);
  });

  it.each(["paused", "terminated", "pending_approval"])(
    "rejects %s watchdog agents",
    async (status) => {
      const companyId = await seedCompany();
      const issueId = await seedIssue(companyId);
      const agentId = await seedAgent(companyId, { status });
      const app = createApp(companyId);

      const res = await request(app)
        .put(`/api/issues/${issueId}/watchdog`)
        .send({ agentId });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toBe("Cannot assign watchdog to an agent that is not invokable");
    },
  );
});
