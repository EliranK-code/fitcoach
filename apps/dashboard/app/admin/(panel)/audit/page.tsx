import { listPlatformAudit } from "@fitcoach/core";
import { Card, PageHeader } from "@/components/ui";
import { requireAdmin } from "@/lib/admin-session";
import { formatDateTime } from "@/lib/labels";

const ACTIONS: Record<string, string> = {
  admin_created: "Admin created",
  admin_reset: "Admin reset",
  admin_deleted: "Admin deleted",
  admin_login: "Admin sign-in",
  coach_created: "Coach created",
  coach_suspended: "Coach suspended",
  coach_resumed: "Suspension lifted",
  coach_deleted: "Coach deleted",
  invite_created: "Invite link",
  reset_link_created: "Password reset link",
  user_mfa_reset: "Two-step verification turned off",
  number_assigned: "Number connected",
  budget_set: "Monthly budget",
  number_disconnected: "Number disconnected",
  number_connected_by_coach: "Coach connected a number",
};

export default async function AdminAuditPage() {
  const s = await requireAdmin();
  const rows = await listPlatformAudit(s.handle.db, { limit: 200 });
  return (
    <>
      <PageHeader title="Audit log" description="Every admin or CLI action on coaches. Entries are kept even after a coach is deleted." />
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
