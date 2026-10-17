import Link from "next/link";
import { notFound } from "next/navigation";
import {
  budgetStatus,
  CoachLifecycleError,
  findCoachBySlug,
  formatUsd,
  listCoachNumbers,
  listCoachUsersForPanel,
  listCoaches,
  monthUsage,
} from "@fitcoach/core";
import { AssignNumberForm, BudgetForm, DeleteCoachForm, InviteForm, ResetLinkForm } from "@/components/admin-forms";
import { Badge, Button, Card, Notice, PageHeader, Stat } from "@/components/ui";
import { UsageSummary } from "@/components/usage-card";
import {
  assignNumberAction,
  deleteCoachAction,
  disconnectNumberAction,
  inviteAction,
  resetLinkAction,
  resetUserMfaAction,
  resumeCoachAction,
  setBudgetAction,
  suspendCoachAction,
} from "@/lib/actions/admin";
import { requireAdmin } from "@/lib/admin-session";
import { formatDateTime } from "@/lib/labels";

export default async function AdminCoachPage({ params }: { params: Promise<{ slug: string }> }) {
  const s = await requireAdmin();
  const { slug } = await params;
  const coach = await findCoachBySlug(s.handle.db, slug).catch((err) => {
    if (err instanceof CoachLifecycleError) notFound();
    throw err;
  });
  const summary = (await listCoaches(s.handle.db)).find((c) => c.id === coach.id)!;
  const users = await listCoachUsersForPanel(s.handle.db, coach.id);
  const numbers = await listCoachNumbers(s.handle.db, coach.id);
  const usage = await monthUsage(s.handle.db, { coachId: coach.id });
  const budget = budgetStatus(summary.monthCostMicros, summary.budgetUsd);
  const tz = s.cfg.TIMEZONE;
  const suspended = coach.status === "suspended";

  return (
    <>
      <div className="mb-2 text-sm">
        <Link href="/admin" className="text-slate-500 hover:underline">
          → לכל המאמנים
        </Link>
      </div>
      <PageHeader
        title={coach.name}
        description={
          <span dir="ltr" className="font-mono">
            {coach.slug}
          </span>
        }
        actions={
          suspended ? (
            <form action={resumeCoachAction.bind(null, coach.id)}>
              <Button size="sm">ביטול ההשעיה</Button>
            </form>
          ) : (
            <form action={suspendCoachAction.bind(null, coach.id)}>
              <Button size="sm" variant="secondary">
                השעיה
              </Button>
            </form>
          )
        }
      />
      {suspended && (
        <div className="mb-6">
          <Notice tone="yellow">
            מושהה מ-{formatDateTime(coach.suspendedAt!, tz)}: אין כניסה לדשבורד, הבוט לא עונה (לקוח קיים מקבל הודעה קבועה אחת), והתזכורות עצורות.
          </Notice>
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="לקוחות" value={summary.clients} />
        <Stat label="עלות משוערת החודש" value={formatUsd(summary.monthCostMicros)} tone={budget.level === "over" ? "red" : undefined} />
        <Stat label="גרסת בסיס הידע" value={summary.starterKnowledge ? "תבנית התחלתית" : coach.knowledgeVersion} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="שימוש החודש">
          <UsageSummary usage={usage} budgetUsd={summary.budgetUsd} />
          <div className="mt-4 border-t border-slate-100 pt-4">
            <BudgetForm action={setBudgetAction.bind(null, coach.id)} current={summary.budgetUsd} />
          </div>
        </Card>

        <Card title="משתמשי הדשבורד">
          {users.length === 0 ? (
            <p className="text-sm text-slate-500">עוד אין משתמשים. שלחו קישור הזמנה.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {users.map((u) => (
                <li key={u.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span dir="ltr" className="font-medium">
                      {u.email}
                    </span>
                    {u.mfa ? <Badge tone="green">אימות דו-שלבי</Badge> : <Badge>סיסמה בלבד</Badge>}
                    {u.lockedUntil && u.lockedUntil > new Date() && <Badge tone="red">נעול</Badge>}
                    <span className="text-xs text-slate-500">כניסה אחרונה: {u.lastLoginAt ? formatDateTime(u.lastLoginAt, tz) : "עוד לא"}</span>
                  </div>
                  <div className="flex flex-wrap items-start gap-2">
                    <ResetLinkForm action={resetLinkAction.bind(null, u.id)} />
                    {u.mfa && (
                      <form action={resetUserMfaAction.bind(null, coach.id, u.id, u.email)}>
                        <Button size="sm" variant="ghost">
                          ביטול האימות הדו-שלבי
                        </Button>
                      </form>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 border-t border-slate-100 pt-4">
            <InviteForm action={inviteAction.bind(null, coach.id)} />
          </div>
        </Card>

        <Card title="וואטסאפ">
          {numbers.length === 0 ? (
            <p className="mb-4 text-sm text-slate-500">לא מחובר מספר.</p>
          ) : (
            <ul className="mb-4 space-y-2 text-sm">
              {numbers.map((n) => (
                <li key={n.phoneNumberId} className="flex flex-wrap items-center gap-2">
                  <span dir="ltr" className="font-medium">
                    {n.displayPhone ?? n.phoneNumberId}
                  </span>
                  <Badge tone={n.status === "active" ? "green" : "gray"}>{n.status === "active" ? "פעיל" : n.status}</Badge>
                  <Badge>{n.mode === "managed" ? "מנוהל בפלטפורמה" : "מחובר ע\"י המאמן"}</Badge>
                  <form action={disconnectNumberAction.bind(null, coach.id, n.phoneNumberId)} className="ms-auto">
                    <Button size="sm" variant="ghost">
                      ניתוק
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          {summary.starterKnowledge ? (
            <Notice tone="yellow">אפשר לחבר מספר אחרי שהמאמן ממלא ומפרסם את בסיס הידע שלו.</Notice>
          ) : (
            <AssignNumberForm action={assignNumberAction.bind(null, coach.id)} />
          )}
        </Card>

        {suspended && (
          <Card title="מחיקת המאמן" className="border-red-200 lg:col-span-2">
            <DeleteCoachForm slug={coach.slug} action={deleteCoachAction.bind(null, coach.id)} />
          </Card>
        )}
      </div>
    </>
  );
}
