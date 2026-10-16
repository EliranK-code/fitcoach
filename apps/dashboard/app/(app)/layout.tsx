import { listAlerts } from "@fitcoach/core";
import { Nav } from "@/components/nav";
import { logoutAction } from "@/lib/actions/auth";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const s = await requireSession();
  const openAlerts = (await listAlerts(s.handle.db, s.t, { status: "open" })).length;
  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b border-slate-200 bg-white md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:border-b-0 md:border-e">
        <div className="flex h-full flex-col gap-4 p-4">
          <div className="flex items-center gap-2 px-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 font-bold text-white">F</div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{s.t.coachName}</div>
              <div className="text-xs text-slate-500">FitCoach</div>
            </div>
          </div>
          <Nav openAlerts={openAlerts} />
          <form action={logoutAction} className="mt-auto hidden md:block">
            <div className="truncate px-3 pb-2 text-xs text-slate-500" dir="ltr">
              {s.user.email}
            </div>
            <button className="w-full rounded-lg px-3 py-2 text-start text-sm text-slate-600 hover:bg-slate-100">יציאה</button>
          </form>
        </div>
      </aside>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
    </div>
  );
}
