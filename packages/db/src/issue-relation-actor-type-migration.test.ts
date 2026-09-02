import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function migrationStatements(): Promise<string[]> {
  const migrationSql = await readFile(
    fileURLToPath(new URL("./migrations/0234_rapid_firebird.sql", import.meta.url)),
    "utf8",
  );
  return migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

d("issue relation actor provenance migration", () => {
  it("replays without laundering deleted actors into system recovery provenance", async () => {
    const database = await startEmbeddedPostgresTestDatabase("relation-actor-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const companyId = randomUUID();
    const watchedIssueIds = [randomUUID(), randomUUID(), randomUUID()];
    const watchdogIssueIds = [randomUUID(), randomUUID(), randomUUID()];
    const relationIds = [randomUUID(), randomUUID(), randomUUID()];
    const relationCreatedAt = "2026-09-02T08:00:00.000Z";
    const competingAt = "2026-09-02T08:00:30.000Z";
    const recoveryAt = "2026-09-02T08:01:00.000Z";

    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Relation actor migration test', 'RAM')
    `;
    for (let index = 0; index < watchedIssueIds.length; index += 1) {
      await sql`
        INSERT INTO "issues" (
          "id", "company_id", "title", "identifier", "origin_kind", "origin_id"
        ) VALUES
          (
            ${watchedIssueIds[index]},
            ${companyId},
            ${`Watched issue ${index + 1}`},
            ${`RAM-${index * 2 + 1}`},
            'manual',
            NULL
          ),
          (
            ${watchdogIssueIds[index]},
            ${companyId},
            ${`Watchdog issue ${index + 1}`},
            ${`RAM-${index * 2 + 2}`},
            'task_watchdog',
            ${watchedIssueIds[index]}
          )
      `;
    }

    await sql`
      INSERT INTO "issue_relations" (
        "id",
        "company_id",
        "issue_id",
        "related_issue_id",
        "type",
        "created_by_actor_type",
        "created_by_agent_id",
        "created_by_user_id",
        "created_at",
        "updated_at"
      ) VALUES
        (
          ${relationIds[0]}, ${companyId}, ${watchdogIssueIds[0]}, ${watchedIssueIds[0]},
          'blocks', 'unknown', NULL, NULL, ${relationCreatedAt}, ${relationCreatedAt}
        ),
        (
          ${relationIds[1]}, ${companyId}, ${watchdogIssueIds[1]}, ${watchedIssueIds[1]},
          'blocks', 'agent', NULL, NULL, ${relationCreatedAt}, ${relationCreatedAt}
        ),
        (
          ${relationIds[2]}, ${companyId}, ${watchdogIssueIds[2]}, ${watchedIssueIds[2]},
          'blocks', 'unknown', NULL, NULL, ${relationCreatedAt}, ${relationCreatedAt}
        )
    `;

    for (const index of [0, 2]) {
      await sql`
        INSERT INTO "activity_log" (
          "company_id", "actor_type", "actor_id", "action", "entity_type", "entity_id",
          "agent_id", "run_id", "details", "created_at"
        ) VALUES (
          ${companyId}, 'system', 'system', 'issue.updated', 'issue', ${watchedIssueIds[index]},
          NULL, NULL,
          ${sql.json({
            source: "recovery.reconcile_continuation_waiting_on_review",
            status: "blocked",
            blockedByIssueIds: [watchdogIssueIds[index]],
          })},
          ${recoveryAt}
        )
      `;
    }
    await sql`
      INSERT INTO "activity_log" (
        "company_id", "actor_type", "actor_id", "action", "entity_type", "entity_id",
        "agent_id", "run_id", "details", "created_at"
      ) VALUES (
        ${companyId}, 'agent', 'deleted-agent', 'issue.updated', 'issue', ${watchedIssueIds[2]},
        NULL, NULL, '{}'::jsonb, ${competingAt}
      )
    `;

    const statements = await migrationStatements();
    for (const statement of statements) await sql.unsafe(statement);
    for (const statement of statements) await sql.unsafe(statement);

    const rows = await sql<{ id: string; created_by_actor_type: string }[]>`
      SELECT "id", "created_by_actor_type"
      FROM "issue_relations"
      WHERE "id" IN (${relationIds[0]}, ${relationIds[1]}, ${relationIds[2]})
      ORDER BY "id"
    `;
    expect(rows).toEqual(
      [
        { id: relationIds[0], created_by_actor_type: "system" },
        { id: relationIds[1], created_by_actor_type: "agent" },
        { id: relationIds[2], created_by_actor_type: "unknown" },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
  }, 240_000);
});
