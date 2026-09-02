import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockPublishActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  publishActivity: mockPublishActivity,
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
  };
}

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  let transactionActive = false;
  const selectWhere = vi.fn();
  const select = vi.fn(() => {
    let linkedIssueLockQuery = false;
    const query: any = {
      from: vi.fn(() => query),
      innerJoin: vi.fn(() => {
        linkedIssueLockQuery = true;
        return query;
      }),
      where: selectWhere.mockImplementation(() => query),
      orderBy: vi.fn(() => query),
      for: vi.fn(() => query),
      then: (resolve: (value: ApprovalRecord[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(linkedIssueLockQuery ? [] : pendingSelectResults.shift() ?? []).then(resolve, reject),
    };
    return query;
  });

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  const db: any = { select, update };
  db.transaction = vi.fn(async (callback: (tx: typeof db) => Promise<unknown>) => {
    transactionActive = true;
    try {
      return await callback(db);
    } finally {
      transactionActive = false;
    }
  });

  return {
    db,
    selectWhere,
    returning,
    isTransactionActive: () => transactionActive,
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue({ agent: { id: "agent-1" }, activated: true });
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockPublishActivity.mockReturnValue(undefined);
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("treats repeated reject retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1", approved.payload);
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("creates the agent from payload when approval does not reference a pending agent", async () => {
    const approved = {
      ...createApproval("approved"),
      payload: {
        name: "New Agent",
        adapterConfig: {
          env: {
            API_KEY: {
              type: "secret_ref",
              secretId: "secret-1",
              version: "latest",
            },
          },
        },
      },
    };
    const dbStub = createDbStub([[{ ...createApproval("pending"), payload: approved.payload }]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: approved.payload.adapterConfig,
      }),
    );
  });

  it("persists request-revision activity before the locked transaction commits", async () => {
    const revised = createApproval("revision_requested");
    const dbStub = createDbStub([[createApproval("pending")]], [revised]);
    mockLogActivity.mockImplementation(async (_tx, _input, publications) => {
      expect(dbStub.isTransactionActive()).toBe(true);
      publications.push({ companyId: "company-1", payload: {}, pluginEvent: null });
    });
    mockPublishActivity.mockImplementation(() => {
      expect(dbStub.isTransactionActive()).toBe(false);
    });

    const result = await approvalService(dbStub.db as any)
      .requestRevision("approval-1", "board-user", "Please revise");

    expect(result.status).toBe("revision_requested");
    expect(mockLogActivity).toHaveBeenCalledWith(
      dbStub.db,
      expect.objectContaining({
        actorType: "user",
        actorId: "board-user",
        action: "approval.revision_requested",
        entityId: "approval-1",
      }),
      expect.any(Array),
    );
    expect(mockPublishActivity).toHaveBeenCalledTimes(1);
  });

  it("persists resubmission activity before the locked transaction commits", async () => {
    const resubmitted = createApproval("pending");
    const dbStub = createDbStub([[createApproval("revision_requested")]], [resubmitted]);
    mockLogActivity.mockImplementation(async (_tx, _input, publications) => {
      expect(dbStub.isTransactionActive()).toBe(true);
      publications.push({ companyId: "company-1", payload: {}, pluginEvent: null });
    });

    const result = await approvalService(dbStub.db as any).resubmit(
      "approval-1",
      { revised: true },
      {
        actorType: "agent",
        actorId: "agent-1",
        agentId: "agent-1",
        runId: "run-1",
        agentApiKeyId: "key-1",
      },
    );

    expect(result.status).toBe("pending");
    expect(mockLogActivity).toHaveBeenCalledWith(
      dbStub.db,
      expect.objectContaining({
        actorType: "agent",
        actorId: "agent-1",
        agentId: "agent-1",
        runId: "run-1",
        action: "approval.resubmitted",
        entityId: "approval-1",
      }),
      expect.any(Array),
    );
    expect(mockPublishActivity).toHaveBeenCalledTimes(1);
  });
});

describe("approvalService.findOpenHireApprovalForAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the open hire approval the company/type/status/agentId filter yields", async () => {
    const match = {
      ...createApproval("pending"),
      id: "approval-match",
      payload: { agentId: "agent-1" },
    };
    // The company, type, open-status and payload->>'agentId' predicates run in
    // SQL, so the DB hands back only the matching row.
    const dbStub = createDbStub([[match]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.findOpenHireApprovalForAgent("company-1", "agent-1");

    expect(result?.id).toBe("approval-match");
    expect(dbStub.selectWhere).toHaveBeenCalledTimes(1);
  });

  it("returns null when no open approval matches the agent", async () => {
    const dbStub = createDbStub([[]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.findOpenHireApprovalForAgent("company-1", "agent-1");

    expect(result).toBeNull();
  });
});
