-- Row-level security as a second line of tenant isolation, behind the coach_id filter in every repository.
-- Repositories run their statements as app_tenant with app.coach_id set (db/scope.ts). Platform paths (queue and
-- reminder claiming, webhook routing, login) run as the table owner, which RLS does not restrict.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    CREATE ROLE app_tenant NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
GRANT app_tenant TO CURRENT_USER;
--> statement-breakpoint
CREATE FUNCTION app_coach_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.coach_id', true), '')::uuid
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_tenant;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_tenant;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_tenant;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_tenant;
--> statement-breakpoint
-- A coach can read and update its own row; creating and deleting coaches is a platform operation.
REVOKE INSERT, DELETE ON coaches FROM app_tenant;
--> statement-breakpoint
-- Audit and usage records are append-only for tenants.
REVOKE UPDATE, DELETE ON audit_log, usage_events FROM app_tenant;
--> statement-breakpoint
ALTER TABLE coaches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON coaches TO app_tenant
  USING (id = (SELECT app_coach_id()))
  WITH CHECK (id = (SELECT app_coach_id()));
--> statement-breakpoint
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'alerts', 'audit_log', 'chat_messages', 'client_memory', 'client_profiles', 'clients', 'coach_knowledge',
    'coach_users', 'conversation_epochs', 'inbound_messages', 'knowledge_chunks', 'knowledge_documents',
    'llm_messages', 'meal_logs', 'meal_plans', 'reminders', 'sessions', 'turn_jobs', 'usage_events',
    'weight_logs', 'whatsapp_accounts', 'workout_logs', 'workout_plans'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I TO app_tenant '
      'USING (coach_id = (SELECT app_coach_id())) WITH CHECK (coach_id = (SELECT app_coach_id()))',
      tbl
    );
  END LOOP;
END $$;
