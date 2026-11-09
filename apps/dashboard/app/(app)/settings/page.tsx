import { eq } from "drizzle-orm";
import {
  clientAccessMode,
  coachCapUsd,
  CONSENT_VERSION,
  consentText,
  listAudit,
  mfaEnabled,
  monthUsage,
  PLATFORM_FLOOR,
  resolveReminderSettings,
  schema,
  onboardingMode,
  spendCaps,
  timeZoneOptions,
  withTenant,
} from "@fitcoach/core";
import { MfaCard } from "@/components/mfa-card";
import { ReminderSettingsForm } from "@/components/reminder-settings-form";
import { EmbeddedSignup } from "@/components/embedded-signup";
import { ClientAccessForm, CoachSettingsForm, ConsentForm, PasswordForm } from "@/components/settings-forms";
import { Badge, Card, Notice, PageHeader } from "@/components/ui";
import { UsageSummary } from "@/components/usage-card";
import { formatDateTime } from "@/lib/labels";
import { requireSession } from "@/lib/session";

export default async function SettingsPage() {
  const s = await requireSession();
  const db = s.handle.db;
  const tz = s.t.settings.timezone ?? s.cfg.TIMEZONE;
  const accounts = await withTenant(db, s.t, (db) =>
    db.select().from(schema.whatsappAccounts).where(eq(schema.whatsappAccounts.coachId, s.t.coachId)),
  );
  const usage = await monthUsage(db, s.t);
  const auditRows = await listAudit(db, s.t, 15);
  const signupMode = onboardingMode(s.cfg);

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Coach details and safety">
          <CoachSettingsForm
            name={s.t.coachName}
            timezone={tz}
            zones={timeZoneOptions(tz)}
            floorFemale={s.t.settings.calorieFloorFemale}
            floorMale={s.t.settings.calorieFloorMale}
            minFemale={PLATFORM_FLOOR.female}
            minMale={PLATFORM_FLOOR.male}
          />
        </Card>

        <Card title="WhatsApp">
          {accounts.length === 0 ? (
            <p className="mb-4 text-sm text-slate-500">No number connected yet.</p>
          ) : (
            <ul className="mb-4 space-y-2 text-sm">
              {accounts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2">
                  <span dir="ltr" className="font-medium">
                    {a.displayPhone ?? a.phoneNumberId}
                  </span>
                  <Badge tone={a.status === "active" ? "green" : "gray"}>{a.status === "active" ? "Active" : a.status}</Badge>
                  <Badge>{a.mode === "managed" ? "Managed by the platform" : "Connected by the coach"}</Badge>
                  {s.cfg.WHATSAPP_DRY_RUN && <Badge tone="yellow">dry run</Badge>}
                </li>
              ))}
            </ul>
          )}
          {s.t.settings.starterKnowledge ? (
            <Notice tone="yellow">You can connect a number after you fill in and publish the knowledge base, so the bot doesn't answer clients from an empty template.</Notice>
          ) : accounts.some((a) => a.status === "active") ? (
            <p className="text-xs text-slate-500">To change or disconnect the number, contact the administrator.</p>
          ) : signupMode === "unavailable" ? (
            <Notice>Connecting your own number isn't set up on this platform yet. The administrator can connect a number for you.</Notice>
          ) : (
            <EmbeddedSignup
              mode={signupMode}
              appId={s.cfg.META_APP_ID}
              configId={s.cfg.META_EMBEDDED_SIGNUP_CONFIG_ID}
              graphVersion={s.cfg.WHATSAPP_GRAPH_VERSION}
            />
          )}
        </Card>

        <Card title="Bot access" className="lg:col-span-2">
          <ClientAccessForm mode={clientAccessMode(s.t.settings)} />
        </Card>

        <Card title="Consent notice (privacy)" className="lg:col-span-2">
          <ConsentForm
            text={s.t.settings.consentText ?? consentText(s.t.coachName)}
            version={s.t.settings.consentVersion ?? CONSENT_VERSION}
            custom={Boolean(s.t.settings.consentText)}
          />
        </Card>

        <Card title="Proactive reminders" className="lg:col-span-2">
          <ReminderSettingsForm values={resolveReminderSettings(s.t.settings.reminders)} />
        </Card>

        <Card title="Usage this month">
          <UsageSummary usage={usage} budgetUsd={s.t.settings.monthlyBudgetUsd} capUsd={coachCapUsd(s.t, spendCaps(s.cfg))} />
          <p className="mt-2 text-xs text-slate-500">Model: {s.cfg.CLAUDE_MODEL}</p>
        </Card>

        <div className="space-y-6">
          <Card title="Change password">
            <PasswordForm />
          </Card>
          <Card title="Two-step verification">
            <MfaCard enabled={mfaEnabled(s.user)} />
          </Card>
        </div>

        <Card title="Audit log (privacy)" className="lg:col-span-2">
          <p className="mb-3 text-xs text-slate-500">Every client view, export, deletion and settings change is logged here.</p>
          <ul className="divide-y divide-slate-100 text-sm">
            {auditRows.map((r) => (
              <li key={r.id} className="flex flex-wrap gap-x-3 py-1.5">
                <span className="text-slate-500">{formatDateTime(r.createdAt, tz)}</span>
                <span dir="ltr">{r.actor}</span>
                <span className="font-medium" dir="ltr">
                  {r.action}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
