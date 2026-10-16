import Link from "next/link";
import { notFound } from "next/navigation";
import { audit, calorieFloor, getClient, isMinor, PROFILE_FIELDS, type ClientProfile, type ProfileNote } from "@fitcoach/core";
import { Conversation, type ChatItem } from "@/components/conversation";
import { DeleteClient } from "@/components/delete-client";
import { Badge, Button, Card, SEVERITY_TONE, WhatsAppText } from "@/components/ui";
import { WeightChart } from "@/components/weight-chart";
import { clearFlagsAction, setPausedAction } from "@/lib/actions/clients";
import { ALERT_TYPE_LABEL, CHANNEL_LABEL, CONSENT_LABEL, formatDateTime, GOAL_LABEL, SEVERITY_LABEL } from "@/lib/labels";
import { clientDetail } from "@/lib/queries";
import { requireSession } from "@/lib/session";

const ENUM_LABELS: Record<string, Record<string, string>> = {
  goal: GOAL_LABEL,
  sex: { male: "זכר", female: "נקבה", other: "אחר" },
  experience: { beginner: "מתחיל/ה", intermediate: "בינוני/ת", advanced: "מתקדם/ת" },
  equipment: { gym: "חדר כושר", home: "בית", both: "גם וגם", none: "בלי ציוד" },
  activityLevel: { sedentary: "יושבני", light: "קלה", moderate: "בינונית", active: "פעיל", very_active: "פעיל מאוד" },
};

function profileValue(key: keyof ClientProfile, value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join(" · ") : "אין";
  return ENUM_LABELS[key]?.[String(value)] ?? String(value);
}

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSession();
  const { id } = await params;
  const db = s.handle.db;
  if (!(await getClient(db, s.t, id))) notFound();
  const d = await clientDetail(db, s.t, id);
  await audit(db, s.t, { actor: s.actor, action: "client_viewed", targetType: "client", targetId: id });

  const tz = s.t.settings.timezone ?? s.cfg.TIMEZONE;
  const name = d.profile.name ?? d.phone;
  const minor = Boolean(d.client.flags.minor) || isMinor(d.profile);
  const floor = calorieFloor(d.profile, s.t.settings, { minor });
  const notes = (d.profile.notes ?? []) as ProfileNote[];
  const openAlerts = d.alerts.filter((a) => a.status === "open");

  const sendDisabledReason =
    d.client.consentStatus !== "granted"
      ? "הלקוח/ה עוד לא אישר/ה את הודעת הפרטיות."
      : d.client.channel === "whatsapp" && !d.canSendWhatsApp
        ? "אין מספר וואטסאפ מחובר למאמן."
        : d.client.channel === "whatsapp" && !d.windowOpen
          ? "עברו יותר מ-24 שעות מההודעה האחרונה של הלקוח/ה. בוואטסאפ אפשר לשלוח עכשיו רק תבנית (template) מאושרת."
          : undefined;

  return (
    <>
      <div className="mb-6">
        <Link href="/clients" className="text-sm text-slate-500 hover:text-slate-800">
          → לכל הלקוחות
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{name}</h1>
          <Badge tone="gray">{CHANNEL_LABEL[d.client.channel] ?? d.client.channel}</Badge>
          {d.client.consentStatus !== "granted" && <Badge tone="yellow">{CONSENT_LABEL[d.client.consentStatus]}</Badge>}
          {d.client.botPaused && <Badge tone="purple">הבוט מושהה: את/ה מנהל/ת את השיחה</Badge>}
          {d.client.flags.minor && <Badge tone="orange">קטין/ה</Badge>}
          {d.client.flags.eatingDisorderRisk && <Badge tone="red">סיכון הפרעת אכילה</Badge>}
        </div>
        {name !== d.phone && (
          <div className="mt-1 text-sm text-slate-500" dir="ltr" style={{ textAlign: "right" }}>
            {d.phone}
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <form action={setPausedAction.bind(null, id, !d.client.botPaused)}>
            <Button size="sm" variant={d.client.botPaused ? "primary" : "secondary"}>
              {d.client.botPaused ? "החזר את הבוט לשיחה" : "השתלט על השיחה (השהה את הבוט)"}
            </Button>
          </form>
          {(d.client.flags.minor || d.client.flags.eatingDisorderRisk) && (
            <form action={clearFlagsAction.bind(null, id)}>
              <Button size="sm" variant="secondary">
                נקה דגלי בטיחות
              </Button>
            </form>
          )}
          <a
            href={`/api/clients/${id}/export`}
            className="inline-flex items-center rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
          >
            ייצוא המידע (JSON)
          </a>
          <DeleteClient clientId={id} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Card title="השיחה">
            <Conversation
              clientId={id}
              initial={d.messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() }) as ChatItem)}
              timeZone={tz}
              canSend={!sendDisabledReason}
              sendDisabledReason={sendDisabledReason}
            />
          </Card>

          {openAlerts.length > 0 && (
            <Card title="התראות פתוחות" actions={<Link href="/alerts" className="text-sm text-emerald-700">לטיפול</Link>}>
              <ul className="space-y-2 text-sm">
                {openAlerts.map((a) => (
                  <li key={a.id} className="flex items-start gap-2">
                    <Badge tone={SEVERITY_TONE[a.severity]}>{SEVERITY_LABEL[a.severity]}</Badge>
                    <span>
                      <strong>{ALERT_TYPE_LABEL[a.type]}:</strong> {a.summary}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="תוכניות">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700">
                  תפריט {d.mealPlan && <span className="font-normal text-slate-500">גרסה {d.mealPlan.version}, הערכה פנימית {d.mealPlan.dailyCalories} קק"ל</span>}
                </h3>
                {d.mealPlan ? (
                  <div className="whitespace-chat rounded-lg bg-slate-50 p-3 text-sm">
                    <WhatsAppText text={d.mealPlan.planText} />
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">עוד אין תפריט.</p>
                )}
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700">
                  תוכנית אימונים {d.workoutPlan && <span className="font-normal text-slate-500">גרסה {d.workoutPlan.version}</span>}
                </h3>
                {d.workoutPlan ? (
                  <div className="whitespace-chat rounded-lg bg-slate-50 p-3 text-sm">
                    <WhatsAppText text={d.workoutPlan.planText} />
                    <p className="mt-2 text-xs text-slate-500">התקדמות: {d.workoutPlan.progressionRule}</p>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">עוד אין תוכנית אימונים.</p>
                )}
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-6 lg:col-span-2">
          <Card title="פרופיל">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              {PROFILE_FIELDS.filter((f) => f.spec.kind !== "note").map((f) => {
                const value = d.profile[f.key];
                return (
                  <div key={f.key} className="contents">
                    <dt className="text-slate-500">{f.label}</dt>
                    <dd className={value === undefined ? "text-slate-400" : ""}>{value === undefined ? (f.onboarding ? "עוד לא נאסף" : "—") : profileValue(f.key, value)}</dd>
                  </div>
                );
              })}
            </dl>
            <p className="mt-3 text-xs text-slate-500">רף קלורי בטוח לתפריטים: {floor.floor} קק"ל ליום</p>
          </Card>

          <Card title="משקל (90 יום)">
            <WeightChart data={d.weights.map((w) => ({ date: w.measuredOn, kg: w.weightKg }))} />
          </Card>

          {notes.length > 0 && (
            <Card title="מה למדנו על הלקוח/ה">
              <ul className="space-y-1.5 text-sm">
                {notes.map((n, i) => (
                  <li key={i}>
                    <span className="text-slate-500">{n.date.split("-").reverse().join("/")}:</span> {n.text}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="זיכרון ארוך טווח">
            {d.memory?.summary ? (
              <div className="whitespace-chat text-sm text-slate-700">{d.memory.summary}</div>
            ) : (
              <p className="text-sm text-slate-500">הסיכום נוצר אוטומטית כשהשיחה מתארכת.</p>
            )}
          </Card>

          <Card title="יומן">
            <h3 className="mb-1 text-sm font-semibold text-slate-700">אימונים אחרונים</h3>
            {d.workouts.length ? (
              <ul className="mb-4 space-y-1 text-sm">
                {d.workouts.map((w, i) => (
                  <li key={i}>
                    <span className="text-slate-500">{w.performedOn.split("-").reverse().join("/")}</span> {w.title}:{" "}
                    {w.exercises.map((e) => `${e.name} ${e.sets}×${e.reps}${e.weightKg ? ` ${e.weightKg}ק"ג` : ""}`).join(", ")}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-4 text-sm text-slate-500">אין.</p>
            )}
            <h3 className="mb-1 text-sm font-semibold text-slate-700">ארוחות אחרונות</h3>
            {d.meals.length ? (
              <ul className="space-y-1 text-sm">
                {d.meals.map((m, i) => (
                  <li key={i}>
                    <span className="text-slate-500">{m.eatenOn.split("-").reverse().join("/")}</span> {m.description}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">אין.</p>
            )}
          </Card>

          <p className="text-xs text-slate-500">
            הצטרפות: {formatDateTime(d.client.createdAt, tz)}
            {d.client.consentAt && ` · אישור פרטיות: ${formatDateTime(d.client.consentAt, tz)} (גרסה ${d.client.consentVersion})`}
          </p>
        </div>
      </div>
    </>
  );
}
