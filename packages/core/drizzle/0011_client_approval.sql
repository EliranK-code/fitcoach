ALTER TABLE "clients" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
-- Everyone who was a client before approval existed keeps talking to the bot.
UPDATE "clients" SET "approved_at" = "created_at";
