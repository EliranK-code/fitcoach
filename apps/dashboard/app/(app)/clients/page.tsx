import Link from "next/link";
import { clientAccessMode } from "@fitcoach/core";
import { AddClientForm } from "@/components/add-client";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { CHANNEL_LABEL, CONSENT_LABEL, formatRelative, GOAL_LABEL } from "@/lib/labels";
import { clientRows } from "@/lib/queries";
import { requireSession } from "@/lib/session";

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const s = await requireSession();
  const q = ((await searchParams).q ?? "").trim().toLowerCase();
  const rows = (await clientRows(s.handle.db, s.t)).filter(
    (r) => !q || r.name.toLowerCase().includes(q) || r.phone.includes(q),
  );
  const approvedOnly = clientAccessMode(s.t.settings) === "approved_only";

  return (
    <>
      <PageHeader
        title="Clients"
        description={approvedOnly ? "The bot answers only numbers you added or approved" : "Everyone who wrote to your bot"}
        actions={
          <form className="w-64">
            <input
              name="q"
              defaultValue={q}
              placeholder="Search by name or phone"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </form>
        }
      />
      <div className="mb-6">
        <Card title="Add a client by WhatsApp number">
          <AddClientForm />
          <p className="mt-2 text-xs text-slate-500">When the client writes to the bot's number, the bot sends the consent notice and gets started.</p>
        </Card>
      </div>
      {rows.length === 0 ? (
        <EmptyState title={q ? "No clients found" : "No clients yet"}>
          {!q && "Add a client by phone number in the form above. You can try the bot in the Playground."}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-start text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3 text-start font-medium">Client</th>
                <th className="px-4 py-3 text-start font-medium">Goal</th>
                <th className="px-4 py-3 text-start font-medium">Channel</th>
                <th className="px-4 py-3 text-start font-medium">Status</th>
                <th className="px-4 py-3 text-start font-medium">Last message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link href={`/clients/${r.id}`} className="font-medium text-slate-900 hover:text-emerald-700">
                      {r.name}
                    </Link>
                    {r.name !== r.phone && (
                      <div className="text-xs text-slate-500" dir="ltr">
                        {r.phone}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{r.goal ? GOAL_LABEL[r.goal] : "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {r.access === "pending" && <Badge tone="orange">Join request</Badge>}
                      {r.access === "revoked" && <Badge tone="gray">No bot access</Badge>}
                      {r.access === "approved" && r.consentStatus !== "granted" && <Badge tone="yellow">{CONSENT_LABEL[r.consentStatus]}</Badge>}
                      {r.botPaused && <Badge tone="purple">Bot paused</Badge>}
                      {r.flags.minor && <Badge tone="orange">Minor</Badge>}
                      {r.flags.eatingDisorderRisk && <Badge tone="red">Eating-disorder risk</Badge>}
                      {r.openAlerts > 0 && <Badge tone="red">{r.openAlerts} {r.openAlerts === 1 ? "alert" : "alerts"}</Badge>}
                      {r.access === "approved" &&
                        r.consentStatus === "granted" &&
                        !r.botPaused &&
                        !r.openAlerts &&
                        !r.flags.minor &&
                        !r.flags.eatingDisorderRisk && <Badge tone="green">OK</Badge>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{r.lastInboundAt ? formatRelative(r.lastInboundAt) : "hasn't written yet"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
