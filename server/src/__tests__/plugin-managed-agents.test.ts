import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  approvals,
  companies,
  createDb,
  pluginEntities,
  pluginCompanySettings,
  pluginManagedResources,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { agentService } from "../services/agents.js";
import { agentInstructionsService } from "../services/agent-instructions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
      };
    },
  } as any;
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

function manifest(): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.managed-agents-test",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Managed Agents Test",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["agents.managed"],
    entrypoints: { worker: "./dist/worker.js" },
    agents: [
      {
        agentKey: "wiki-maintainer",
        displayName: "Wiki Maintainer",
        role: "engineer",
        title: "Maintains plugin-owned knowledge",
        capabilities: "Maintains a plugin-owned wiki.",
        adapterType: "process",
        adapterConfig: { command: "pnpm wiki:maintain" },
        runtimeConfig: { heartbeat: { enabled: false } },
        permissions: { canCreateAgents: false },
        budgetMonthlyCents: 1234,
      },
    ],
  };
}

function pausedManifest(): PaperclipPluginManifestV1 {
  const pluginManifest = manifest();
  pluginManifest.agents![0] = {
    ...pluginManifest.agents![0]!,
    status: "paused",
  };
  return pluginManifest;
}

function releaseDevopsManifest(role = "devops"): PaperclipPluginManifestV1 {
  const pluginManifest = manifest();
  pluginManifest.agents![0] = {
    ...pluginManifest.agents![0]!,
    agentKey: "release-devops",
    displayName: "Release DevOps",
    role,
    adapterConfig: {},
    instructions: {
      entryFile: "AGENTS.md",
      content: [
        "# Release DevOps",
        "",
        "Drive each repository to at most two open implementation PRs.",
        "Preserve the full owner/repo#number identity.",
      ].join("\n"),
    },
  };
  return pluginManifest;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin-managed agent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin-managed agents", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-managed-agents-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentConfigRevisions);
    await db.delete(activityLog);
    await db.delete(pluginEntities);
    await db.delete(pluginManagedResources);
    await db.delete(pluginCompanySettings);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndPlugin(options: { requireApproval?: boolean; manifest?: PaperclipPluginManifestV1 } = {}) {
    const companyId = randomUUID();
    const pluginId = randomUUID();
    const pluginManifest = options.manifest ?? manifest();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: options.requireApproval ?? false,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: pluginManifest.id,
      packageName: "@paperclipai/plugin-managed-agents-test",
      version: pluginManifest.version,
      apiVersion: pluginManifest.apiVersion,
      categories: pluginManifest.categories,
      manifestJson: pluginManifest,
      status: "ready",
      installOrder: 1,
    });
    const services = buildHostServices(db, pluginId, pluginManifest.id, createEventBusStub(), undefined, {
      manifest: pluginManifest,
    });
    return { companyId, pluginId, pluginManifest, services };
  }

  async function createCeoWithPolicy(
    companyId: string,
    policy: string,
    status: "idle" | "pending_approval" = "idle",
  ) {
    const ceo = await agentService(db).create(companyId, {
      name: status === "pending_approval" ? "CEO Candidate" : "CEO",
      role: "ceo",
      status,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    const ceoInstructions = await agentInstructionsService().materializeManagedBundle(
      ceo,
      { "AGENTS.md": policy },
    );
    const updated = await agentService(db).update(ceo.id, { adapterConfig: ceoInstructions.adapterConfig }, {
      allowPendingApprovalConfigUpdate: true,
    });
    return updated!;
  }

  async function withTempInstructionsHome(run: () => Promise<void>) {
    const previousHome = process.env.PAPERCLIP_HOME;
    const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-agent-policy-"));
    process.env.PAPERCLIP_HOME = tempHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test";
    try {
      await run();
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }

  it("creates and resolves managed agents by stable resource key", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();

    const created = await services.agents.managedReconcile({
      companyId,
      agentKey: "wiki-maintainer",
    });

    expect(created.status).toBe("created");
    expect(created.agentId).toBeTruthy();
    expect(created.agent).toMatchObject({
      name: "Wiki Maintainer",
      role: "engineer",
      adapterConfig: { command: "pnpm wiki:maintain" },
    });

    const resolved = await services.agents.managedGet({
      companyId,
      agentKey: "wiki-maintainer",
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.agentId).toBe(created.agentId);

    const [binding] = await db.select().from(pluginEntities);
    expect(binding?.entityType).toBe("managed_agent");
    expect(binding?.scopeKind).toBe("company");
    expect(binding?.scopeId).toBe(companyId);
    expect(binding?.data).toMatchObject({
      resourceKind: "agent",
      resourceKey: "wiki-maintainer",
      agentId: created.agentId,
    });
  });

  it("preserves user edits during reconcile and resets only on explicit reset", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
    expect(created.agentId).toBeTruthy();

    await db
      .update(agents)
      .set({
        name: "Knowledge Lead",
        adapterConfig: { command: "custom" },
        updatedAt: new Date(),
      })
      .where(eq(agents.id, created.agentId!));

    const reconciled = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
    expect(reconciled.status).toBe("resolved");
    expect(reconciled.agent).toMatchObject({
      name: "Knowledge Lead",
      adapterConfig: { command: "custom" },
    });

    const reset = await services.agents.managedReset({ companyId, agentKey: "wiki-maintainer" });
    expect(reset.status).toBe("reset");
    expect(reset.agent).toMatchObject({
      name: "Wiki Maintainer",
      adapterConfig: { command: "pnpm wiki:maintain" },
    });
  });

  it("records plugin provenance when a manifest creates a paused managed agent", async () => {
    const { companyId, services } = await seedCompanyAndPlugin({ manifest: pausedManifest() });

    const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });

    expect(created.agent).toMatchObject({
      status: "paused",
      pauseReason: "Provisioned paused by plugin paperclip.managed-agents-test; requires explicit activation.",
    });
    expect(created.agent?.pausedAt).toBeInstanceOf(Date);
  });

  it("backfills a legacy null pause reason while the managed declaration and agent remain paused", async () => {
    const { companyId, services } = await seedCompanyAndPlugin({ manifest: pausedManifest() });
    const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
    await db
      .update(agents)
      .set({ pauseReason: null, updatedAt: new Date() })
      .where(eq(agents.id, created.agentId!));

    const reconciled = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });

    expect(reconciled.agent).toMatchObject({
      status: "paused",
      pauseReason: "Provisioned paused by plugin paperclip.managed-agents-test; requires explicit activation.",
    });
  });

  it.each(["manual", "budget", "system", "maintenance"])(
    "preserves the existing %s pause reason during reconcile",
    async (pauseReason) => {
      const { companyId, services } = await seedCompanyAndPlugin({ manifest: pausedManifest() });
      const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
      await db
        .update(agents)
        .set({ pauseReason, updatedAt: new Date() })
        .where(eq(agents.id, created.agentId!));

      const reconciled = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });

      expect(reconciled.agent).toMatchObject({ status: "paused", pauseReason });
    },
  );

  it("keeps an explicit resume durable across managed-agent reconcile", async () => {
    const { companyId, services } = await seedCompanyAndPlugin({ manifest: pausedManifest() });
    const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
    await agentService(db).resume(created.agentId!);

    const reconciled = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });

    expect(reconciled.agent).toMatchObject({
      status: "idle",
      pauseReason: null,
      pausedAt: null,
    });
  });

  it("creates managed agents with the most-used compatible company adapter", async () => {
    const pluginManifest = manifest();
    pluginManifest.agents![0] = {
      ...pluginManifest.agents![0]!,
      adapterType: "claude_local",
      adapterPreference: ["claude_local", "codex_local"],
      adapterConfig: {},
    };
    const { companyId, services } = await seedCompanyAndPlugin({ manifest: pluginManifest });
    await db.insert(agents).values([
      {
        id: randomUUID(),
        companyId,
        name: "Codex One",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: randomUUID(),
        companyId,
        name: "Codex Two",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: randomUUID(),
        companyId,
        name: "Claude One",
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });

    expect(created.status).toBe("created");
    expect(created.agent?.adapterType).toBe("codex_local");
  });

  it("materializes declared managed agent instructions with local folder paths", async () => {
    const previousHome = process.env.PAPERCLIP_HOME;
    const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-agent-home-"));
    const wikiRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-agent-wiki-")));
    process.env.PAPERCLIP_HOME = tempHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test";
    try {
      const pluginManifest = manifest();
      pluginManifest.localFolders = [
        {
          folderKey: "wiki-root",
          displayName: "Wiki root",
          access: "readWrite",
          requiredDirectories: [],
          requiredFiles: ["AGENTS.md"],
        },
      ];
      pluginManifest.agents![0] = {
        ...pluginManifest.agents![0]!,
        adapterType: "claude_local",
        adapterConfig: {},
        instructions: {
          entryFile: "AGENTS.md",
          content: [
            "# LLM Wiki Maintainer",
            "",
            "You are the LLM Wiki Maintainer.",
            "Wiki root: `{{localFolders.wiki-root.path}}`",
            "Wiki schema: `{{localFolders.wiki-root.agentsPath}}`",
            "",
          ].join("\n"),
        },
      };
      const { companyId, pluginId, services } = await seedCompanyAndPlugin({ manifest: pluginManifest });
      await fs.writeFile(path.join(wikiRoot, "AGENTS.md"), "# Wiki schema\n", "utf8");
      await db.insert(pluginCompanySettings).values({
        companyId,
        pluginId,
        enabled: true,
        settingsJson: {
          localFolders: {
            "wiki-root": {
              path: wikiRoot,
              access: "readWrite",
              requiredDirectories: [],
              requiredFiles: ["AGENTS.md"],
            },
          },
        },
      });

      const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });

      const instructionsFilePath = created.agent?.adapterConfig.instructionsFilePath;
      expect(typeof instructionsFilePath).toBe("string");
      const content = await fs.readFile(instructionsFilePath as string, "utf8");
      expect(content).toContain("You are the LLM Wiki Maintainer.");
      expect(content).toContain(`Wiki root: \`${wikiRoot}\``);
      expect(content).toContain(`Wiki schema: \`${path.join(wikiRoot, "AGENTS.md")}\``);
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
      await fs.rm(tempHome, { recursive: true, force: true });
      await fs.rm(wikiRoot, { recursive: true, force: true });
    }
  });

  it("reconciles a stale managed Release DevOps cap to the company policy", async () => {
    const previousHome = process.env.PAPERCLIP_HOME;
    const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-agent-policy-"));
    process.env.PAPERCLIP_HOME = tempHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test";
    try {
      const pluginManifest = releaseDevopsManifest();
      const { companyId, services } = await seedCompanyAndPlugin({ manifest: pluginManifest });
      await createCeoWithPolicy(
        companyId,
        [
          "# Company delivery policy",
          "",
          "Enforce a WIP limit of at most 5 open implementation PRs per repository.",
        ].join("\n"),
      );

      const created = await services.agents.managedReconcile({
        companyId,
        agentKey: "release-devops",
      });
      const instructionsPath = created.agent?.adapterConfig.instructionsFilePath as string;
      await expect(fs.readFile(instructionsPath, "utf8")).resolves.toContain(
        "at most 5 open implementation PRs",
      );

      await fs.writeFile(
        instructionsPath,
        [
          "# Release DevOps",
          "",
          "Drive each repository to at most two open implementation PRs.",
          "Preserve the full owner/repo#number identity.",
        ].join("\n"),
        "utf8",
      );

      await services.agents.managedReconcile({
        companyId,
        agentKey: "release-devops",
      });

      const reconciled = await fs.readFile(instructionsPath, "utf8");
      expect(reconciled).toContain("at most 5 open implementation PRs");
      expect(reconciled).not.toContain("at most two open implementation PRs");
      expect(reconciled).toContain("Preserve the full owner/repo#number identity.");
      const policyEvents = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "plugin.managed_agent.company_instruction_policy_reconciled"));
      expect(policyEvents).toHaveLength(1);
      expect(policyEvents[0]?.details).toMatchObject({
        companyImplementationPrCap: 5,
        replacedImplementationPrLimits: [2],
      });
      const policyRevisions = await db
        .select()
        .from(agentConfigRevisions)
        .where(eq(
          agentConfigRevisions.source,
          "plugin:paperclip.managed-agents-test:company-instruction-policy",
        ));
      expect(policyRevisions).toHaveLength(1);
      expect(policyRevisions[0]?.changedKeys).toContain("instructionsBundle");
      expect(policyRevisions[0]?.beforeConfig).toMatchObject({
        instructionsBundle: {
          entryFile: "AGENTS.md",
          files: {
            "AGENTS.md": expect.stringContaining("at most two open implementation PRs"),
          },
        },
      });
      expect(policyRevisions[0]?.afterConfig).toMatchObject({
        instructionsBundle: {
          entryFile: "AGENTS.md",
          files: {
            "AGENTS.md": expect.stringContaining("at most 5 open implementation PRs"),
          },
        },
      });
      const prewriteRevisions = await db
        .select()
        .from(agentConfigRevisions)
        .where(eq(
          agentConfigRevisions.source,
          "plugin:paperclip.managed-agents-test:company-instruction-policy:prewrite-snapshot",
        ));
      expect(prewriteRevisions).toHaveLength(1);
      expect(prewriteRevisions[0]?.afterConfig).toMatchObject({
        instructionsBundle: {
          entryFile: "AGENTS.md",
          files: {
            "AGENTS.md": expect.stringContaining("at most two open implementation PRs"),
          },
        },
      });

      const rolledBack = await agentService(db).rollbackConfigRevision(
        created.agentId!,
        prewriteRevisions[0]!.id,
        {},
      );
      expect(rolledBack).not.toBeNull();
      const restored = await fs.readFile(instructionsPath, "utf8");
      expect(restored).toContain("at most two open implementation PRs");
      expect(restored).not.toContain("at most 5 open implementation PRs");
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("ignores an unapproved CEO candidate when resolving company policy", async () => {
    await withTempInstructionsHome(async () => {
      const { companyId, services } = await seedCompanyAndPlugin({
        manifest: releaseDevopsManifest(),
      });
      await createCeoWithPolicy(
        companyId,
        "Enforce at most 5 open implementation PRs per repository.",
      );
      await createCeoWithPolicy(
        companyId,
        "Enforce at most 2 open implementation PRs per repository.",
        "pending_approval",
      );

      const created = await services.agents.managedReconcile({
        companyId,
        agentKey: "release-devops",
      });
      const instructionsPath = created.agent?.adapterConfig.instructionsFilePath as string;
      const content = await fs.readFile(instructionsPath, "utf8");
      expect(content).toContain("at most 5 open implementation PRs");
      expect(content).not.toContain("at most 2 open implementation PRs");
    });
  });

  it("does not rewrite pending managed-agent instructions after the hire request", async () => {
    await withTempInstructionsHome(async () => {
      const { companyId, services } = await seedCompanyAndPlugin({
        manifest: releaseDevopsManifest(),
        requireApproval: true,
      });
      const ceo = await createCeoWithPolicy(
        companyId,
        "Enforce at most 5 open implementation PRs per repository.",
      );
      const created = await services.agents.managedReconcile({
        companyId,
        agentKey: "release-devops",
      });
      expect(created.agent?.status).toBe("pending_approval");
      const candidatePath = created.agent?.adapterConfig.instructionsFilePath as string;
      await expect(fs.readFile(candidatePath, "utf8")).resolves.toContain(
        "at most 5 open implementation PRs",
      );

      const ceoPath = ceo.adapterConfig.instructionsFilePath as string;
      await fs.writeFile(
        ceoPath,
        "Enforce at most 6 open implementation PRs per repository.",
        "utf8",
      );
      await services.agents.managedReconcile({
        companyId,
        agentKey: "release-devops",
      });

      const preserved = await fs.readFile(candidatePath, "utf8");
      expect(preserved).toContain("at most 5 open implementation PRs");
      expect(preserved).not.toContain("at most 6 open implementation PRs");
    });
  });

  it("redacts inline secrets from stored instruction-bundle revisions", async () => {
    await withTempInstructionsHome(async () => {
      const { companyId, services } = await seedCompanyAndPlugin({
        manifest: releaseDevopsManifest(),
      });
      await createCeoWithPolicy(
        companyId,
        "Enforce at most 5 open implementation PRs per repository.",
      );
      const created = await services.agents.managedReconcile({
        companyId,
        agentKey: "release-devops",
      });
      const instructionsPath = created.agent?.adapterConfig.instructionsFilePath as string;
      await fs.writeFile(
        instructionsPath,
        [
          "Drive each repository to at most two open implementation PRs.",
          "OPENAI_API_KEY=sk-review-fixture-secret",
        ].join("\n"),
        "utf8",
      );

      await services.agents.managedReconcile({
        companyId,
        agentKey: "release-devops",
      });
      const revisions = await db
        .select()
        .from(agentConfigRevisions)
        .where(eq(
          agentConfigRevisions.source,
          "plugin:paperclip.managed-agents-test:company-instruction-policy:prewrite-snapshot",
        ));
      const serialized = JSON.stringify(revisions[0]?.afterConfig);
      expect(serialized).toContain("***REDACTED***");
      expect(serialized).not.toContain("sk-review-fixture-secret");
      await expect(
        agentService(db).rollbackConfigRevision(created.agentId!, revisions[0]!.id, {}),
      ).rejects.toThrow("Cannot roll back a revision that contains redacted secret values");
    });
  });

  it("fails closed before creating a managed agent when CEO policy is contradictory", async () => {
    await withTempInstructionsHome(async () => {
      const { companyId, services } = await seedCompanyAndPlugin({
        manifest: releaseDevopsManifest(),
      });
      await createCeoWithPolicy(
        companyId,
        [
          "Enforce at most 5 open implementation PRs per repository.",
          "Freeze at most 0 open implementation PRs per repository.",
        ].join("\n"),
      );

      await expect(services.agents.managedReconcile({
        companyId,
        agentKey: "release-devops",
      })).rejects.toThrow("contradictory implementation PR limits: 5, 0");

      const companyAgents = await db.select().from(agents).where(eq(agents.companyId, companyId));
      expect(companyAgents).toHaveLength(1);
      await expect(db.select().from(pluginEntities)).resolves.toHaveLength(0);
      await expect(db.select().from(pluginManagedResources)).resolves.toHaveLength(0);
    });
  });

  it("fails closed before creating a managed agent when active CEO instructions are unreadable", async () => {
    await withTempInstructionsHome(async () => {
      const { companyId, services } = await seedCompanyAndPlugin({
        manifest: releaseDevopsManifest(),
      });
      const ceo = await createCeoWithPolicy(
        companyId,
        "Enforce at most 5 open implementation PRs per repository.",
      );
      const instructionsPath = ceo.adapterConfig.instructionsFilePath as string;
      await fs.rm(instructionsPath);

      await expect(services.agents.managedReconcile({
        companyId,
        agentKey: "release-devops",
      })).rejects.toThrow("Instructions entry file does not exist: AGENTS.md");

      const companyAgents = await db.select().from(agents).where(eq(agents.companyId, companyId));
      expect(companyAgents).toHaveLength(1);
      await expect(db.select().from(pluginEntities)).resolves.toHaveLength(0);
    });
  });

  it("keeps read-only managed lookups available when CEO instructions are unreadable", async () => {
    await withTempInstructionsHome(async () => {
      const { companyId, services } = await seedCompanyAndPlugin({
        manifest: releaseDevopsManifest(),
      });
      const ceo = await createCeoWithPolicy(
        companyId,
        "Enforce at most 5 open implementation PRs per repository.",
      );
      const created = await services.agents.managedReconcile({
        companyId,
        agentKey: "release-devops",
      });
      await fs.rm(ceo.adapterConfig.instructionsFilePath as string);

      const resolved = await services.agents.managedGet({
        companyId,
        agentKey: "release-devops",
      });
      expect(resolved.status).toBe("resolved");
      expect(resolved.agentId).toBe(created.agentId);
      expect(resolved.defaultDrift).toBeNull();
    });
  });

  it("uses the persisted role when a declaration changes an existing managed agent to CEO", async () => {
    await withTempInstructionsHome(async () => {
      const pluginManifest = releaseDevopsManifest("ceo");
      const { companyId, pluginId, services } = await seedCompanyAndPlugin({ manifest: pluginManifest });
      await createCeoWithPolicy(
        companyId,
        "Enforce at most 5 open implementation PRs per repository.",
      );
      const agentId = randomUUID();
      const [candidate] = await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Release DevOps",
        role: "devops",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        metadata: {
          paperclipManagedResource: {
            pluginId,
            pluginKey: pluginManifest.id,
            resourceKind: "agent",
            resourceKey: "release-devops",
          },
        },
      }).returning();
      const materialized = await agentInstructionsService().materializeManagedBundle(
        candidate!,
        {
          "AGENTS.md": "Drive each repository to at most two open implementation PRs.",
        },
      );
      await agentService(db).update(agentId, { adapterConfig: materialized.adapterConfig });

      const relinked = await services.agents.managedReconcile({
        companyId,
        agentKey: "release-devops",
      });
      expect(relinked.status).toBe("relinked");
      expect(relinked.agent?.role).toBe("devops");
      const instructionsPath = relinked.agent?.adapterConfig.instructionsFilePath as string;
      await expect(fs.readFile(instructionsPath, "utf8")).resolves.toContain(
        "at most 5 open implementation PRs",
      );
    });
  });

  it("repairs a missing binding by relinking a same-company managed agent marker", async () => {
    const { companyId, pluginId, pluginManifest, services } = await seedCompanyAndPlugin();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Renamed Wiki Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "custom" },
      runtimeConfig: {},
      permissions: {},
      metadata: {
        paperclipManagedResource: {
          pluginId,
          pluginKey: pluginManifest.id,
          resourceKind: "agent",
          resourceKey: "wiki-maintainer",
        },
      },
    });

    const relinked = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
    expect(relinked.status).toBe("relinked");
    expect(relinked.agentId).toBe(agentId);

    const [binding] = await db.select().from(pluginEntities);
    expect(binding?.data).toMatchObject({ agentId });
  });

  it("respects board approval policy for new managed agents", async () => {
    const { companyId, services } = await seedCompanyAndPlugin({ requireApproval: true });

    const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });

    expect(created.status).toBe("created");
    expect(created.agent?.status).toBe("pending_approval");
    expect(created.approvalId).toBeTruthy();

    const [approval] = await db.select().from(approvals).where(eq(approvals.id, created.approvalId!));
    expect(approval).toMatchObject({
      type: "hire_agent",
      status: "pending",
    });
    expect(approval?.payload).toMatchObject({
      agentId: created.agentId,
      sourcePluginKey: "paperclip.managed-agents-test",
      managedResourceKey: "wiki-maintainer",
    });
  });
});
