import Link from "next/link";
import { notFound } from "next/navigation";
import { audit, calorieFloor, getClient, isMinor, PROFILE_FIELDS, type ClientProfile, type ProfileNote } from "@fitcoach/core";
import { Conversation, type ChatItem } from "@/components/conversation";
import { DeleteClient } from "@/components/delete-client";
import { Badge, Button, Card, Notice, SEVERITY_TONE, WhatsAppText } from "@/components/ui";
import { WeightChart } from "@/components/weight-chart";
import { approveClientAction, clearFlagsAction, revokeAccessAction, setPausedAction } from "@/lib/actions/clients";
import { stopClientRemindersAction } from "@/lib/actions/reminders";
import { ALERT_TYPE_LABEL, CHANNEL_LABEL, DAY_NAMES, REMINDER_KIND_LABEL, CONSENT_LABEL, formatDateTime, GOAL_LABEL, SEVERITY_LABEL } from "@/lib/labels";
import { clientAccess, clientDetail } from "@/lib/queries";
import { requireSession } from "@/lib/session";

const ENUM_LABELS: Record<string, Record<string, string>> = {
  goal: GOAL_LABEL,
  sex: { male: "Male", female: "Female", other: "Other" },
  experience: { beginner: "Beginner", intermediate: "Intermediate", advanced: "Advanced" },
  equipment: { gym: "Gym", home: "Home", both: "Both", none: "No equipment" },
  activityLevel: { sedentary: "Sedentary", light: "Light", moderate: "Moderate", active: "Active", very_active: "Very active" },
};

function profileValue(key: keyof ClientProfile, value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join(" · ") : "none";
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
  const access = clientAccess(d.client);

  const sendDisabledReason =
    d.client.consentStatus !== "granted"
      ? "The client hasn't accepted the privacy notice yet."
      : d.client.channel === "whatsapp" && !d.canSendWhatsApp
        ? "The coach has no WhatsApp number connected."
        : d.client.channel === "whatsapp" && !d.windowOpen
          ? "More than 24 hours have passed since the client's last message. On WhatsApp you can only send an approved template now."
          : undefined;

  return (
    <>
      <div className="mb-6">
        <Link href="/clients" className="text-sm text-slate-500 hover:text-slate-800">
          ← All clients
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{name}</h1>
          <Badge tone="gray">{CHANNEL_LABEL[d.client.channel] ?? d.client.channel}</Badge>
          {access === "pending" && <Badge tone="orange">Join request</Badge>}
          {access === "revoked" && <Badge tone="gray">No bot access</Badge>}
          {d.client.consentStatus !== "granted" && <Badge tone="yellow">{CONSENT_LABEL[d.client.consentStatus]}</Badge>}
          {d.client.botPaused && <Badge tone="purple">Bot paused: you're handling the conversation</Badge>}
          {d.client.flags.minor && <Badge tone="orange">Minor</Badge>}
          {d.client.flags.eatingDisorderRisk && <Badge tone="red">Eating-disorder risk</Badge>}
        </div>
        {name !== d.phone && (
          <div className="mt-1 text-sm text-slate-500" dir="ltr">
            {d.phone}
          </div>
        )}
        {access !== "approved" && (
          <div className="mt-4">
            <Notice tone="yellow">
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex-1">
                  {access === "pending"
                    ? "This number isn't approved yet. The bot doesn't answer it or keep what it writes. If this is your client, approve them and the bot will send the consent notice right away (if they wrote in the last 24 hours).)."
                    : "The client's access to the bot was removed: the bot doesn't answer or send reminders. Their data is kept."}
                </span>
                <form action={approveClientAction.bind(null, id)}>
                  <Button size="sm">{access === "pending" ? "Approve client" : "Restore access"}</Button>
                </form>
              </div>
            </Notice>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <form action={setPausedAction.bind(null, id, !d.client.botPaused)}>
            <Button size="sm" variant={d.client.botPaused ? "primary" : "secondary"}>
              {d.client.botPaused ? "Hand the conversation back to the bot" : "Take over the conversation (pause the bot)"}
            </Button>
          </form>
          {(d.client.flags.minor || d.client.flags.eatingDisorderRisk) && (
            <form action={clearFlagsAction.bind(null, id)}>
              <Button size="sm" variant="secondary">
                Clear safety flags
              </Button>
            </form>
          )}
          <a
            href={`/api/clients/${id}/export`}
            className="inline-flex items-center rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
          >
            Export data (JSON)
          </a>
          {access === "approved" && d.client.channel === "whatsapp" && (
            <form action={revokeAccessAction.bind(null, id)}>
              <Button size="sm" variant="secondary">
                Remove bot access
              </Button>
            </form>
          )}
          <DeleteClient clientId={id} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Card title="Conversation">
            <Conversation
              clientId={id}
              initial={d.messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() }) as ChatItem)}
              timeZone={tz}
              canSend={!sendDisabledReason}
              sendDisabledReason={sendDisabledReason}
            />
          </Card>

          {openAlerts.length > 0 && (
            <Card title="Open alerts" actions={<Link href="/alerts" className="text-sm text-emerald-700">Handle</Link>}>
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

          <Card title="Plans">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700">
                  Meal plan {d.mealPlan && <span className="font-normal text-slate-500">version {d.mealPlan.version}, internal estimate {d.mealPlan.dailyCalories} kcal</span>}
                </h3>
                {d.mealPlan ? (
                  <div className="whitespace-chat rounded-lg bg-slate-50 p-3 text-sm">
                    <WhatsAppText text={d.mealPlan.planText} />
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">No meal plan yet.</p>
                )}
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700">
                  Workout plan {d.workoutPlan && <span className="font-normal text-slate-500">version {d.workoutPlan.version}</span>}
                </h3>
                {d.workoutPlan ? (
                  <div className="whitespace-chat rounded-lg bg-slate-50 p-3 text-sm">
                    <WhatsAppText text={d.workoutPlan.planText} />
                    <p className="mt-2 text-xs text-slate-500">Progression: {d.workoutPlan.progressionRule}</p>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">No workout plan yet.</p>
                )}
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-6 lg:col-span-2">
          <Card
            title="Reminders"
            actions={
              !d.client.flags.remindersOptOut && d.reminders.some((r) => r.enabled) ? (
                <form action={stopClientRemindersAction.bind(null, id)}>
                  <Button size="sm" variant="ghost">
                    Stop reminders
                  </Button>
                </form>
              ) : undefined
            }
          >
            {d.client.flags.remindersOptOut ? (
              <p className="text-sm text-slate-500">The client asked not to get proactive messages.</p>
            ) : d.reminders.length === 0 ? (
              <p className="text-sm text-slate-500">No reminders. The bot offers them after onboarding.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {d.reminders.map((r) => (
                  <li key={r.id} className={r.enabled ? "" : "text-slate-400"}>
                    <strong>{REMINDER_KIND_LABEL[r.kind] ?? r.kind}</strong> · days {r.days.map((day) => DAY_NAMES[day]).join(" ")} ·{" "}
                    <span dir="ltr">{r.time}</span>
                    {r.nextRunAt && <span className="text-slate-500"> · next: {formatDateTime(r.nextRunAt, tz)}</span>}
                  </li>
                ))}
              </ul>
            )}
            {d.client.channel !== "whatsapp" && <p className="mt-2 text-xs text-slate-500">Reminders are sent only to WhatsApp clients.</p>}
          </Card>

          <Card title="Profile">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              {PROFILE_FIELDS.filter((f) => f.spec.kind !== "note").map((f) => {
                const value = d.profile[f.key];
                return (
                  <div key={f.key} className="contents">
                    <dt className="text-slate-500">{f.label}</dt>
                    <dd className={value === undefined ? "text-slate-400" : ""}>{value === undefined ? (f.onboarding ? "not collected yet" : "—") : profileValue(f.key, value)}</dd>
                  </div>
                );
              })}
            </dl>
            <p className="mt-3 text-xs text-slate-500">Safe calorie floor for meal plans: {floor.floor} kcal a day</p>
          </Card>

          <Card title="Weight (90 days)">
            <WeightChart data={d.weights.map((w) => ({ date: w.measuredOn, kg: w.weightKg }))} />
          </Card>

          {notes.length > 0 && (
            <Card title="What we've learned about the client">
              <ul className="space-y-1.5 text-sm">
                {notes.map((n, i) => (
                  <li key={i}>
                    <span className="text-slate-500">{n.date.split("-").reverse().join("/")}:</span> {n.text}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="Long-term memory">
            {d.memory?.summary ? (
              <div className="whitespace-chat text-sm text-slate-700">{d.memory.summary}</div>
            ) : (
              <p className="text-sm text-slate-500">The summary is created automatically as the conversation grows.</p>
            )}
          </Card>

          <Card title="Log">
            <h3 className="mb-1 text-sm font-semibold text-slate-700">Recent workouts</h3>
            {d.workouts.length ? (
              <ul className="mb-4 space-y-1 text-sm">
                {d.workouts.map((w, i) => (
                  <li key={i}>
                    <span className="text-slate-500">{w.performedOn.split("-").reverse().join("/")}</span> {w.title}:{" "}
                    {w.exercises.map((e) => `${e.name} ${e.sets}×${e.reps}${e.weightKg ? ` ${e.weightKg}kg` : ""}`).join(", ")}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-4 text-sm text-slate-500">None.</p>
            )}
            <h3 className="mb-1 text-sm font-semibold text-slate-700">Recent meals</h3>
            {d.meals.length ? (
              <ul className="space-y-1 text-sm">
                {d.meals.map((m, i) => (
                  <li key={i}>
                    <span className="text-slate-500">{m.eatenOn.split("-").reverse().join("/")}</span> {m.description}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">None.</p>
            )}
          </Card>

          <p className="text-xs text-slate-500">
            Joined: {formatDateTime(d.client.createdAt, tz)}
            {d.client.consentAt && ` · Privacy consent: ${formatDateTime(d.client.consentAt, tz)} (version ${d.client.consentVersion})`}
          </p>
        </div>
      </div>
    </>
  );
}
