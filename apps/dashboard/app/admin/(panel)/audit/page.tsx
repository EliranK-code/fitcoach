import { listPlatformAudit } from "@fitcoach/core";
import { Card, PageHeader } from "@/components/ui";
import { requireAdmin } from "@/lib/admin-session";
import { formatDateTime } from "@/lib/labels";

const ACTIONS: Record<string, string> = {
  admin_created: "אדמין נוצר",
  admin_reset: "איפוס אדמין",
  admin_deleted: "אדמין נמחק",
  admin_login: "כניסת אדמין",
  coach_created: "מאמן נוצר",
  coach_suspended: "מאמן הושעה",
  coach_resumed: "השעיה בוטלה",
  coach_deleted: "מאמן נמחק",
  invite_created: "קישור הזמנה",
  reset_link_created: "קישור איפוס סיסמה",
  user_mfa_reset: "ביטול אימות דו-שלבי",
  number_assigned: "חיבור מספר",
};

export default async function AdminAuditPage() {
  const s = await requireAdmin();
  const rows = await listPlatformAudit(s.handle.db, { limit: 200 });
  return (
    <>
      <PageHeader title="יומן פעולות" description="כל פעולה של אדמין או של ה-CLI על מאמנים. הרשומות נשמרות גם אחרי מחיקת מאמן." />
      <Card>
        <ul className="divide-y divide-slate-100 text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap gap-x-4 gap-y-1 py-2">
              <span className="w-32 shrink-0 text-slate-500">{formatDateTime(r.createdAt, s.cfg.TIMEZONE)}</span>
              <span className="font-medium">{ACTIONS[r.action] ?? r.action}</span>
              {r.coachSlug && (
                <span dir="ltr" className="font-mono text-slate-600">
                  {r.coachSlug}
                </span>
              )}
              {typeof (r.meta as { email?: string }).email === "string" && (
                <span dir="ltr" className="text-slate-600">
                  {(r.meta as { email: string }).email}
                </span>
              )}
              <span dir="ltr" className="ms-auto text-xs text-slate-500">
                {r.actor}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
