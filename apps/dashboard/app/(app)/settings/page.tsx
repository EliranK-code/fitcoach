import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { CONSENT_VERSION, consentText, listAudit, PLATFORM_FLOOR, resolveReminderSettings, schema } from "@fitcoach/core";
import { ReminderSettingsForm } from "@/components/reminder-settings-form";
import { CoachSettingsForm, ConsentForm, PasswordForm, WhatsAppConnectForm } from "@/components/settings-forms";
import { Badge, Card, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/labels";
import { usageSummary } from "@/lib/queries";
import { requireSession } from "@/lib/session";

const KIND_LABEL: Record<string, string> = { chat: "שיחות", summary: "סיכומים", ingest: "עיבוד מסמכים", embedding: "חיפוש", transcription: "תמלול" };

export default async function SettingsPage() {
  const s = await requireSession();
  const db = s.handle.db;
  const tz = s.t.settings.timezone ?? s.cfg.TIMEZONE;
  const accounts = await db.select().from(schema.whatsappAccounts).where(eq(schema.whatsappAccounts.coachId, s.t.coachId));
  const usage = await usageSummary(db, s.t);
  const auditRows = await listAudit(db, s.t, 15);
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;

  return (
    <>
      <PageHeader title="הגדרות" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="פרטי המאמן ובטיחות">
          <CoachSettingsForm
            name={s.t.coachName}
            timezone={tz}
            floorFemale={s.t.settings.calorieFloorFemale}
            floorMale={s.t.settings.calorieFloorMale}
            minFemale={PLATFORM_FLOOR.female}
            minMale={PLATFORM_FLOOR.male}
          />
        </Card>

        <Card title="וואטסאפ">
          {accounts.length === 0 ? (
            <p className="mb-4 text-sm text-slate-500">עוד לא חובר מספר.</p>
          ) : (
            <ul className="mb-4 space-y-2 text-sm">
              {accounts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2">
                  <span dir="ltr" className="font-medium">
                    {a.displayPhone ?? a.phoneNumberId}
                  </span>
                  <Badge tone={a.status === "active" ? "green" : "gray"}>{a.status === "active" ? "פעיל" : a.status}</Badge>
                  <Badge>{a.mode === "managed" ? "מנוהל בפלטפורמה" : "מחובר ע\"י המאמן"}</Badge>
                  {s.cfg.WHATSAPP_DRY_RUN && <Badge tone="yellow">dry run</Badge>}
                </li>
              ))}
            </ul>
          )}
          <WhatsAppConnectForm />
          <div className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            כתובת ה-webhook להגדרה ב-Meta:
            <div dir="ltr" className="mt-1 select-all font-mono text-slate-800">
              {origin}/api/whatsapp/webhook
            </div>
            בפיתוח מקומי צריך כתובת https ציבורית (למשל cloudflared). ההוראות ב-README.
          </div>
        </Card>

        <Card title="הודעת ההסכמה (פרטיות)" className="lg:col-span-2">
          <ConsentForm
            text={s.t.settings.consentText ?? consentText(s.t.coachName)}
            version={s.t.settings.consentVersion ?? CONSENT_VERSION}
            custom={Boolean(s.t.settings.consentText)}
          />
        </Card>

        <Card title="תזכורות יזומות" className="lg:col-span-2">
          <ReminderSettingsForm values={resolveReminderSettings(s.t.settings.reminders)} />
        </Card>

        <Card title="שימוש ב-30 הימים האחרונים">
          {usage.length === 0 ? (
            <p className="text-sm text-slate-500">עוד אין שימוש.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="pb-2 text-start font-medium">סוג</th>
                  <th className="pb-2 text-start font-medium">קריאות</th>
                  <th className="pb-2 text-start font-medium">טוקני קלט</th>
                  <th className="pb-2 text-start font-medium">מה-cache</th>
                  <th className="pb-2 text-start font-medium">טוקני פלט</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100" dir="ltr">
                {usage.map((u) => (
                  <tr key={u.kind}>
                    <td className="py-1.5 text-end" dir="rtl">
                      {KIND_LABEL[u.kind] ?? u.kind}
                    </td>
                    <td className="py-1.5 text-end">{u.calls.toLocaleString()}</td>
                    <td className="py-1.5 text-end">{u.input.toLocaleString()}</td>
                    <td className="py-1.5 text-end">{u.cacheRead.toLocaleString()}</td>
                    <td className="py-1.5 text-end">{u.output.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-xs text-slate-500">מודל: {s.cfg.CLAUDE_MODEL}</p>
        </Card>

        <Card title="החלפת סיסמה">
          <PasswordForm />
        </Card>

        <Card title="יומן פעולות (פרטיות)" className="lg:col-span-2">
          <p className="mb-3 text-xs text-slate-500">כל צפייה בלקוח, ייצוא, מחיקה ושינוי הגדרות נרשמים כאן.</p>
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
