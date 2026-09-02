import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals, issues } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { redactEventPayload } from "../redaction.js";

interface LinkActor {
  agentId?: string | null;
  userId?: string | null;
}

export function issueApprovalService(db: Db) {
  async function getIssue(dbOrTx: any, issueId: string, lock = false) {
    const query = dbOrTx
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));
    return (lock ? query.for("update") : query).then((rows: Array<typeof issues.$inferSelect>) => rows[0] ?? null);
  }

  async function getApproval(dbOrTx: any, approvalId: string, lock = false) {
    const query = dbOrTx
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    return (lock ? query.for("update") : query).then((rows: Array<typeof approvals.$inferSelect>) => rows[0] ?? null);
  }

  async function assertIssueAndApprovalSameCompany(
    dbOrTx: any,
    issueId: string,
    approvalId: string,
    lock = false,
  ) {
    // Issue first, approval second is the global lock order shared with approval
    // status mutation. Dependency recovery already owns the issue row, so a new
    // pending link cannot appear between its wait-gate read and disposition.
    const issue = await getIssue(dbOrTx, issueId, lock);
    if (!issue) throw notFound("Issue not found");

    const approval = await getApproval(dbOrTx, approvalId, lock);
    if (!approval) throw notFound("Approval not found");

    if (issue.companyId !== approval.companyId) {
      throw unprocessable("Issue and approval must belong to the same company");
    }

    return { issue, approval };
  }

  return {
    listApprovalsForIssue: async (issueId: string) => {
      const issue = await getIssue(db, issueId);
      if (!issue) throw notFound("Issue not found");

      const result = await db
        .select({
          id: approvals.id,
          companyId: approvals.companyId,
          type: approvals.type,
          requestedByAgentId: approvals.requestedByAgentId,
          requestedByUserId: approvals.requestedByUserId,
          status: approvals.status,
          payload: approvals.payload,
          decisionNote: approvals.decisionNote,
          decidedByUserId: approvals.decidedByUserId,
          decidedAt: approvals.decidedAt,
          createdAt: approvals.createdAt,
          updatedAt: approvals.updatedAt,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(eq(issueApprovals.issueId, issueId))
        .orderBy(desc(issueApprovals.createdAt));
      return result.map((approval) => ({
        ...approval,
        payload: redactEventPayload(approval.payload) ?? {},
      }));
    },

    listIssuesForApproval: async (approvalId: string) => {
      const approval = await getApproval(db, approvalId);
      if (!approval) throw notFound("Approval not found");

      return db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          goalId: issues.goalId,
          parentId: issues.parentId,
          title: issues.title,
          description: issues.description,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          createdByAgentId: issues.createdByAgentId,
          createdByUserId: issues.createdByUserId,
          issueNumber: issues.issueNumber,
          identifier: issues.identifier,
          requestDepth: issues.requestDepth,
          billingCode: issues.billingCode,
          startedAt: issues.startedAt,
          completedAt: issues.completedAt,
          cancelledAt: issues.cancelledAt,
          createdAt: issues.createdAt,
          updatedAt: issues.updatedAt,
        })
        .from(issueApprovals)
        .innerJoin(issues, eq(issueApprovals.issueId, issues.id))
        .where(eq(issueApprovals.approvalId, approvalId))
        .orderBy(desc(issueApprovals.createdAt));
    },

    link: async (issueId: string, approvalId: string, actor?: LinkActor) => {
      return db.transaction(async (tx) => {
        const { issue } = await assertIssueAndApprovalSameCompany(tx, issueId, approvalId, true);

        await tx
          .insert(issueApprovals)
          .values({
            companyId: issue.companyId,
            issueId,
            approvalId,
            linkedByAgentId: actor?.agentId ?? null,
            linkedByUserId: actor?.userId ?? null,
          })
          .onConflictDoNothing();

        return tx
          .select()
          .from(issueApprovals)
          .where(and(eq(issueApprovals.issueId, issueId), eq(issueApprovals.approvalId, approvalId)))
          .then((rows) => rows[0] ?? null);
      });
    },

    unlink: async (issueId: string, approvalId: string) => {
      await db.transaction(async (tx) => {
        await assertIssueAndApprovalSameCompany(tx, issueId, approvalId, true);
        await tx
          .delete(issueApprovals)
          .where(and(eq(issueApprovals.issueId, issueId), eq(issueApprovals.approvalId, approvalId)));
      });
    },

    linkManyForApproval: async (approvalId: string, issueIds: string[], actor?: LinkActor) => {
      if (issueIds.length === 0) return;

      const uniqueIssueIds = Array.from(new Set(issueIds));
      await db.transaction(async (tx) => {
        const rows = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
          })
          .from(issues)
          .where(inArray(issues.id, uniqueIssueIds))
          .orderBy(asc(issues.id))
          .for("update");

        if (rows.length !== uniqueIssueIds.length) {
          throw notFound("One or more issues not found");
        }

        const approval = await getApproval(tx, approvalId, true);
        if (!approval) throw notFound("Approval not found");
        for (const row of rows) {
          if (row.companyId !== approval.companyId) {
            throw unprocessable("Issue and approval must belong to the same company");
          }
        }

        await tx
          .insert(issueApprovals)
          .values(
            uniqueIssueIds.map((issueId) => ({
              companyId: approval.companyId,
              issueId,
              approvalId,
              linkedByAgentId: actor?.agentId ?? null,
              linkedByUserId: actor?.userId ?? null,
            })),
          )
          .onConflictDoNothing();
      });
    },
  };
}
