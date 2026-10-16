CREATE TABLE "inbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coach_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"phone_number_id" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"body_enc" text,
	"sent_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_messages_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "turn_jobs" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"coach_id" uuid NOT NULL,
	"phone_number_id" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "bot_seen" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_coach_id_coaches_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_jobs" ADD CONSTRAINT "turn_jobs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_jobs" ADD CONSTRAINT "turn_jobs_coach_id_coaches_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_messages_client_status" ON "inbound_messages" USING btree ("client_id","status","sent_at");--> statement-breakpoint
CREATE INDEX "turn_jobs_run_at" ON "turn_jobs" USING btree ("run_at");