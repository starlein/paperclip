ALTER TABLE "issue_relations" ADD COLUMN IF NOT EXISTS "created_by_actor_type" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
DO $$
DECLARE
  changed_rows integer;
BEGIN
  LOOP
    WITH "candidates" AS (
      SELECT "relation"."id"
      FROM "issue_relations" AS "relation"
      WHERE "relation"."created_by_actor_type" = 'unknown'
        AND (
          "relation"."created_by_agent_id" IS NOT NULL
          OR "relation"."created_by_user_id" IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM "issues" AS "watchdog"
            INNER JOIN "activity_log" AS "recovery"
              ON "recovery"."company_id" = "relation"."company_id"
              AND "recovery"."entity_type" = 'issue'
              AND "recovery"."entity_id" = "relation"."related_issue_id"::text
              AND "recovery"."action" = 'issue.updated'
            WHERE "watchdog"."id" = "relation"."issue_id"
              AND "watchdog"."company_id" = "relation"."company_id"
              AND "watchdog"."origin_kind" = 'task_watchdog'
              AND "watchdog"."origin_id" = "relation"."related_issue_id"::text
              AND "relation"."type" = 'blocks'
              AND "recovery"."actor_type" = 'system'
              AND "recovery"."actor_id" = 'system'
              AND "recovery"."agent_id" IS NULL
              AND "recovery"."run_id" IS NULL
              AND "recovery"."details" ->> 'source' = 'recovery.reconcile_continuation_waiting_on_review'
              AND "recovery"."details" ->> 'status' = 'blocked'
              AND ("recovery"."details" -> 'blockedByIssueIds') ? ("relation"."issue_id"::text)
              AND "recovery"."created_at" >= "relation"."created_at"
              AND "recovery"."created_at" <= "relation"."created_at" + interval '5 minutes'
              AND NOT EXISTS (
                SELECT 1
                FROM "activity_log" AS "competing"
                WHERE "competing"."company_id" = "relation"."company_id"
                  AND "competing"."entity_type" = 'issue'
                  AND "competing"."entity_id" = "relation"."related_issue_id"::text
                  AND "competing"."created_at" >= "relation"."created_at"
                  AND "competing"."created_at" <= "recovery"."created_at"
                  AND NOT (
                    "competing"."action" = 'issue.updated'
                    AND "competing"."actor_type" = 'system'
                    AND "competing"."actor_id" = 'system'
                    AND "competing"."agent_id" IS NULL
                    AND "competing"."run_id" IS NULL
                    AND "competing"."details" ->> 'source' = 'recovery.reconcile_continuation_waiting_on_review'
                  )
              )
          )
        )
      ORDER BY "relation"."id"
      LIMIT 500
      FOR UPDATE OF "relation"
    )
    UPDATE "issue_relations" AS "relation"
    SET "created_by_actor_type" = CASE
      WHEN "relation"."created_by_agent_id" IS NOT NULL THEN 'agent'
      WHEN "relation"."created_by_user_id" IS NOT NULL THEN 'user'
      ELSE 'system'
    END
    FROM "candidates"
    WHERE "relation"."id" = "candidates"."id";

    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    EXIT WHEN changed_rows = 0;
  END LOOP;
END $$;
