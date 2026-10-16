CREATE TABLE "platform_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"coach_id" uuid,
	"coach_slug" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coaches" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "platform_audit_created" ON "platform_audit" USING btree ("created_at");--> statement-breakpoint
-- Platform-only: RLS on with no tenant policy, and the default tenant grants from 0005 taken back.
ALTER TABLE "platform_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "platform_audit" FROM app_tenant;--> statement-breakpoint
REVOKE ALL ON SEQUENCE "platform_audit_id_seq" FROM app_tenant;
