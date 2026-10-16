import Link from "next/link";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { CHANNEL_LABEL, CONSENT_LABEL, formatRelative, GOAL_LABEL } from "@/lib/labels";
import { clientRows } from "@/lib/queries";
import { requireSession } from "@/lib/session";

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const s = await requireSession();
  const q = ((await searchParams).q ?? "").trim().toLowerCase();
  const rows = (await clientRows(s.handle.db, s.t)).filter(
    (r) => !q || r.name.toLowerCase().includes(q) || r.phone.includes(q),
  );

  return (
    <>
      <PageHeader
        title="לקוחות"
        description="כל מי שכתב לבוט שלך"
        actions={
          <form className="w-64">
            <input
              name="q"
              defaultValue={q}
              placeholder="חיפוש לפי שם או טלפון"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </form>
        }
      />
      {rows.length === 0 ? (
        <EmptyState title={q ? "לא נמצאו לקוחות" : "עוד אין לקוחות"}>
          {!q && "לקוחות מופיעים כאן אחרי ההודעה הראשונה שלהם. אפשר לנסות את הבוט במגרש המשחקים."}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-start text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3 text-start font-medium">לקוח</th>
                <th className="px-4 py-3 text-start font-medium">מטרה</th>
                <th className="px-4 py-3 text-start font-medium">ערוץ</th>
                <th className="px-4 py-3 text-start font-medium">מצב</th>
                <th className="px-4 py-3 text-start font-medium">הודעה אחרונה</th>
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
                      <div className="text-xs text-slate-500" dir="ltr" style={{ textAlign: "right" }}>
                        {r.phone}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{r.goal ? GOAL_LABEL[r.goal] : "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {r.consentStatus !== "granted" && <Badge tone="yellow">{CONSENT_LABEL[r.consentStatus]}</Badge>}
                      {r.botPaused && <Badge tone="purple">הבוט מושהה</Badge>}
                      {r.flags.minor && <Badge tone="orange">קטין/ה</Badge>}
                      {r.flags.eatingDisorderRisk && <Badge tone="red">סיכון הפרעת אכילה</Badge>}
                      {r.openAlerts > 0 && <Badge tone="red">{r.openAlerts} התראות</Badge>}
                      {r.consentStatus === "granted" && !r.botPaused && !r.openAlerts && !r.flags.minor && !r.flags.eatingDisorderRisk && (
                        <Badge tone="green">תקין</Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{formatRelative(r.lastInboundAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
