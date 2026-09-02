ALTER TABLE "issue_relations" ADD COLUMN IF NOT EXISTS "created_by_actor_type" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
UPDATE "issue_relations"
SET "created_by_actor_type" = CASE
  WHEN "created_by_agent_id" IS NOT NULL THEN 'agent'
  WHEN "created_by_user_id" IS NOT NULL THEN 'user'
  ELSE 'unknown'
END;
