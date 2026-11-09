import Link from "next/link";
import { budgetStatus, formatUsd, listCoaches, platformDaySpendMicros, timeZoneOptions } from "@fitcoach/core";
import { NewCoachForm } from "@/components/admin-forms";
import { Badge, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { requireAdmin } from "@/lib/admin-session";

function BudgetBadge({ costMicros, budgetUsd }: { costMicros: number; budgetUsd: number | null }) {
  const { level, percent } = budgetStatus(costMicros, budgetUsd);
  if (percent === null) return null;
  return (
    <span className="ms-2">
      <Badge tone={level === "over" ? "red" : level === "warn" ? "yellow" : "gray"}>{percent}%</Badge>
    </span>
  );
}

export default async function AdminCoachesPage() {
  const s = await requireAdmin();
  const coaches = await listCoaches(s.handle.db);
  const daySpend = await platformDaySpendMicros(s.handle.db);
  const dayCap = s.cfg.PLATFORM_DAILY_CAP_USD;
  const dayCapReached = dayCap > 0 && daySpend >= dayCap * 1_000_000;
  return (
    <>
      <PageHeader title="Coaches" description="Status, clients and estimated cost this month (percent of budget, if set). Client details aren't shown here." />
      <div className="space-y-6">
        <Notice tone={dayCapReached ? "red" : undefined}>
          Platform spend today (UTC): <span dir="ltr">{formatUsd(daySpend)}</span>
          {dayCap > 0 ? (
            <>
              {" "}
              of a daily cap of <span dir="ltr">${dayCap}</span>.
              {dayCapReached && " The cap was reached: every bot stops answering until tomorrow. You can raise it with PLATFORM_DAILY_CAP_USD."}
            </>
          ) : (
            ". No daily cap (PLATFORM_DAILY_CAP_USD=0)."
          )}
        </Notice>
        <Card>
          {coaches.length === 0 ? (
            <EmptyState title="No coaches yet">Create the first coach with the form below.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-start text-xs text-slate-500">
                  <tr className="border-b border-slate-200">
                    <th className="py-2 text-start font-medium">Coach</th>
                    <th className="py-2 text-start font-medium">Status</th>
                    <th className="py-2 text-start font-medium">Knowledge base</th>
                    <th className="py-2 text-end font-medium">Numbers</th>
                    <th className="py-2 text-end font-medium">Clients</th>
                    <th className="py-2 text-end font-medium">Cost this month</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {coaches.map((c) => (
                    <tr key={c.id}>
                      <td className="py-2">
                        <Link href={`/admin/coaches/${c.slug}`} className="font-medium text-emerald-700 hover:underline">
                          {c.name}
                        </Link>
                        {c.demo && (
                          <span className="ms-2">
                            <Badge tone="purple">Demo</Badge>
                          </span>
                        )}
                        <div className="text-xs text-slate-500" dir="ltr">
                          {c.slug}
                        </div>
                      </td>
                      <td className="py-2">{c.status === "suspended" ? <Badge tone="yellow">Suspended</Badge> : <Badge tone="green">Active</Badge>}</td>
                      <td className="py-2">{c.starterKnowledge ? <Badge tone="orange">Waiting to be filled in</Badge> : <Badge>Ready</Badge>}</td>
                      <td className="py-2 text-end">{c.numbers}</td>
                      <td className="py-2 text-end">{c.clients}</td>
                      <td className="py-2 text-end">
                        <span dir="ltr">{formatUsd(c.monthCostMicros)}</span>
                        <BudgetBadge costMicros={c.monthCostMicros} budgetUsd={c.budgetUsd} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="New coach">
          <p className="mb-4 text-sm text-slate-500">
            The coach is created with an empty knowledge template. After creating it, send them an invite link and they fill in the knowledge base themselves. You can connect a WhatsApp number only after they publish it.
          </p>
          <NewCoachForm zones={timeZoneOptions(s.cfg.TIMEZONE)} defaultZone={s.cfg.TIMEZONE} />
        </Card>
      </div>
    </>
  );
}
