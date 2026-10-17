import Link from "next/link";
import { adminLogoutAction } from "@/lib/actions/admin";
import { requireAdmin } from "@/lib/admin-session";

export const dynamic = "force-dynamic";

/** The platform admin panel. It shows coaches and aggregates only: no client data is reachable from here. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const s = await requireAdmin();
  return (
    <div className="min-h-screen">
      <header className="bg-slate-900 text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white font-bold text-slate-900">F</div>
            <span className="text-sm font-semibold">FitCoach · ניהול</span>
          </div>
          <nav className="flex gap-1 text-sm">
            <Link href="/admin" className="rounded-md px-3 py-1.5 hover:bg-white/10">
              מאמנים
            </Link>
            <Link href="/admin/audit" className="rounded-md px-3 py-1.5 hover:bg-white/10">
              יומן פעולות
            </Link>
          </nav>
          <form action={adminLogoutAction} className="ms-auto flex items-center gap-3 text-xs text-slate-300">
            <span dir="ltr">{s.admin.email}</span>
            <button className="rounded-md px-3 py-1.5 text-sm text-white hover:bg-white/10">יציאה</button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
