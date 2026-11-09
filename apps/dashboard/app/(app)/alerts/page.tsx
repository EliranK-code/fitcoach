import Link from "next/link";
import { listAlerts } from "@fitcoach/core";
import { AlertActions } from "@/components/alert-actions";
import { Badge, Button, Card, EmptyState, PageHeader, SEVERITY_TONE } from "@/components/ui";
import { approveClientAction } from "@/lib/actions/clients";
import { ALERT_TYPE_LABEL, formatDateTime, SEVERITY_LABEL, SEVERITY_ORDER, SOURCE_LABEL } from "@/lib/labels";
import { clientRows } from "@/lib/queries";
import { requireSession } from "@/lib/session";

export default async function AlertsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const s = await requireSession();
  const status = (await searchParams).status === "resolved" ? "resolved" : "open";
  const alerts = (await listAlerts(s.handle.db, s.t, { status })).sort(
    (a, b) =>
      (status === "open" ? (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) : 0) ||
      b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const clients = new Map((await clientRows(s.handle.db, s.t)).map((c) => [c.id, c]));
  const tz = s.t.settings.timezone ?? s.cfg.TIMEZONE;

  return (
    <>
      <PageHeader
        title="Needs attention"
        description="Questions the bot couldn't answer, and safety events detected in conversations"
        actions={
          <div className="flex rounded-lg bg-slate-100 p-1 text-sm">
            {(["open", "resolved"] as const).map((st) => (
              <Link
                key={st}
                href={st === "open" ? "/alerts" : "/alerts?status=resolved"}
                className={`rounded-md px-3 py-1.5 ${status === st ? "bg-white font-medium shadow-sm" : "text-slate-600"}`}
              >
                {st === "open" ? "Open" : "Handled"}
              </Link>
            ))}
          </div>
        }
      />
      {alerts.length === 0 ? (
        <EmptyState title={status === "open" ? "No open alerts" : "No handled alerts yet"} />
      ) : (
        <div className="space-y-4">
          {alerts.map((a) => {
            const client = clients.get(a.clientId);
            return (
              <Card key={a.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={SEVERITY_TONE[a.severity]}>{SEVERITY_LABEL[a.severity]}</Badge>
                  <span className="font-semibold">{ALERT_TYPE_LABEL[a.type] ?? a.type}</span>
                  <span className="text-sm text-slate-500">· {SOURCE_LABEL[a.source] ?? a.source}</span>
                  <span className="ms-auto text-xs text-slate-500">{formatDateTime(a.createdAt, tz)}</span>
                </div>
                <div className="mt-2 text-sm">
                  Client:{" "}
                  <Link href={`/clients/${a.clientId}`} className="font-medium text-emerald-700 hover:underline">
                    {client?.name ?? "Deleted client"}
                  </Link>
                </div>
                <p className="mt-2 text-sm text-slate-700">{a.summary}</p>
                {a.question && (
                  <blockquote className="mt-3 border-s-4 border-emerald-200 bg-emerald-50/50 px-3 py-2 text-sm text-slate-800">
                    {a.question}
                  </blockquote>
                )}
                {a.status === "resolved" ? (
                  a.resolution && <p className="mt-3 text-sm text-slate-500">Handled: {a.resolution}</p>
                ) : (
                  <>
                    {a.type === "join_request" && client?.access !== "approved" && (
                      <form action={approveClientAction.bind(null, a.clientId)} className="mt-3">
                        <Button size="sm">Approve client</Button>
                      </form>
                    )}
                    <AlertActions alertId={a.id} hasQuestion={Boolean(a.question)} canReply={Boolean(client) && client?.consentStatus === "granted"} />
                  </>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
