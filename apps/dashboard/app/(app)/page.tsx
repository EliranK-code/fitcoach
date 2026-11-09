import Link from "next/link";
import { listAlerts, monthUsage, spendBlock, spendBlockMessage, spendCaps } from "@fitcoach/core";
import { Badge, ButtonLink, Card, EmptyState, Notice, PageHeader, SEVERITY_TONE, Stat } from "@/components/ui";
import { BudgetNotice } from "@/components/usage-card";
import { ALERT_TYPE_LABEL, formatRelative, SEVERITY_LABEL, SEVERITY_ORDER } from "@/lib/labels";
import { clientRows, overviewStats } from "@/lib/queries";
import { requireSession } from "@/lib/session";

export default async function OverviewPage() {
  const s = await requireSession();
  const db = s.handle.db;
  const stats = await overviewStats(db, s.t);
  const alerts = (await listAlerts(db, s.t, { status: "open" }))
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 5);
  const rows = await clientRows(db, s.t);
  const names = new Map(rows.map((r) => [r.id, r.name]));
  const usage = s.t.settings.monthlyBudgetUsd ? await monthUsage(db, s.t) : null;
  const block = await spendBlock(db, s.t, spendCaps(s.cfg));

  return (
    <>
      <PageHeader title={`Hi, ${s.t.coachName}`} description="What's happening with your clients" />
      {block ? (
        <div className="mb-6">
          <Notice tone="red">{spendBlockMessage(block)}</Notice>
        </div>
      ) : (
        usage && <BudgetNotice usage={usage} budgetUsd={s.t.settings.monthlyBudgetUsd} />
      )}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Needs attention" value={stats.openAlerts} tone={stats.urgentAlerts > 0 ? "red" : undefined} />
        <Stat label="Clients" value={stats.clients} />
        <Stat label="Active this week" value={stats.activeClients} tone="green" />
        <Stat label="Messages in 24 hours" value={stats.messages24h} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Open alerts" actions={<ButtonLink href="/alerts" size="sm">All alerts</ButtonLink>}>
          {alerts.length === 0 ? (
            <EmptyState title="No open alerts">The bot is handling everything right now.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {alerts.map((a) => (
                <li key={a.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={SEVERITY_TONE[a.severity]}>{SEVERITY_LABEL[a.severity]}</Badge>
                    <span className="text-sm font-medium">{ALERT_TYPE_LABEL[a.type] ?? a.type}</span>
                    <Link href={`/clients/${a.clientId}`} className="text-sm text-emerald-700 hover:underline">
                      {names.get(a.clientId) ?? "Client"}
                    </Link>
                    <span className="ms-auto text-xs text-slate-500">{formatRelative(a.createdAt)}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-slate-600">{a.summary}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Recent activity" actions={<ButtonLink href="/clients" size="sm">All clients</ButtonLink>}>
          {rows.length === 0 ? (
            <EmptyState title="No clients yet">Clients show up here after their first WhatsApp message.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {rows.slice(0, 6).map((r) => (
                <li key={r.id} className="flex items-center gap-3 py-3">
                  <Link href={`/clients/${r.id}`} className="text-sm font-medium hover:text-emerald-700">
                    {r.name}
                  </Link>
                  {r.botPaused && <Badge tone="purple">Paused</Badge>}
                  {r.openAlerts > 0 && <Badge tone="red">{r.openAlerts} {r.openAlerts === 1 ? "alert" : "alerts"}</Badge>}
                  <span className="ms-auto text-xs text-slate-500">{formatRelative(r.lastInboundAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
