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
          ← All coaches
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
              <Button size="sm">Resume</Button>
            </form>
          ) : (
            <form action={suspendCoachAction.bind(null, coach.id)}>
              <Button size="sm" variant="secondary">
                Suspend
              </Button>
            </form>
          )
        }
      />
      {suspended && (
        <div className="mb-6">
          <Notice tone="yellow">
            Suspended since {formatDateTime(coach.suspendedAt!, tz)}: no dashboard sign-in, the bot doesn't answer (an existing client gets one fixed notice), and reminders are stopped.
          </Notice>
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Clients" value={summary.clients} />
        <Stat label="Estimated cost this month" value={formatUsd(summary.monthCostMicros)} tone={budget.level === "over" ? "red" : undefined} />
        <Stat label="Knowledge base version" value={summary.starterKnowledge ? "Starter template" : coach.knowledgeVersion} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Usage this month">
          <UsageSummary usage={usage} budgetUsd={summary.budgetUsd} capUsd={summary.capUsd ?? (s.cfg.COACH_MONTHLY_CAP_USD || null)} />
          <div className="mt-4 border-t border-slate-100 pt-4">
            <BudgetForm
              action={setBudgetAction.bind(null, coach.id)}
              budget={summary.budgetUsd}
              cap={summary.capUsd}
              defaultCap={s.cfg.COACH_MONTHLY_CAP_USD}
            />
          </div>
        </Card>

        <Card title="Dashboard users">
          {users.length === 0 ? (
            <p className="text-sm text-slate-500">No users yet. Send an invite link.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {users.map((u) => (
                <li key={u.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span dir="ltr" className="font-medium">
                      {u.email}
                    </span>
                    {u.mfa ? <Badge tone="green">Two-step verification</Badge> : <Badge>Password only</Badge>}
                    {u.lockedUntil && u.lockedUntil > new Date() && <Badge tone="red">Locked</Badge>}
                    <span className="text-xs text-slate-500">Last sign-in: {u.lastLoginAt ? formatDateTime(u.lastLoginAt, tz) : "never"}</span>
                  </div>
                  <div className="flex flex-wrap items-start gap-2">
                    <ResetLinkForm action={resetLinkAction.bind(null, u.id)} />
                    {u.mfa && (
                      <form action={resetUserMfaAction.bind(null, coach.id, u.id, u.email)}>
                        <Button size="sm" variant="ghost">
                          Turn off two-step verification
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

        <Card title="WhatsApp">
          {numbers.length === 0 ? (
            <p className="mb-4 text-sm text-slate-500">No number connected.</p>
          ) : (
            <ul className="mb-4 space-y-2 text-sm">
              {numbers.map((n) => (
                <li key={n.phoneNumberId} className="flex flex-wrap items-center gap-2">
                  <span dir="ltr" className="font-medium">
                    {n.displayPhone ?? n.phoneNumberId}
                  </span>
                  <Badge tone={n.status === "active" ? "green" : "gray"}>{n.status === "active" ? "Active" : n.status}</Badge>
                  <Badge>{n.mode === "managed" ? "Managed by the platform" : "Connected by the coach"}</Badge>
                  <form action={disconnectNumberAction.bind(null, coach.id, n.phoneNumberId)} className="ms-auto">
                    <Button size="sm" variant="ghost">
                      Disconnect
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          {summary.starterKnowledge ? (
            <Notice tone="yellow">You can connect a number once the coach fills in and publishes their knowledge base.</Notice>
          ) : (
            <AssignNumberForm action={assignNumberAction.bind(null, coach.id)} />
          )}
        </Card>

        {suspended && (
          <Card title="Delete coach" className="border-red-200 lg:col-span-2">
            <DeleteCoachForm slug={coach.slug} action={deleteCoachAction.bind(null, coach.id)} />
          </Card>
        )}
      </div>
    </>
  );
}
