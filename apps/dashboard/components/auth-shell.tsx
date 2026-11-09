import type { ReactNode } from "react";

/** The centered card used by the login, two-step, invitation and reset pages (and the admin login). */
export function AuthShell({ subtitle, footer, children, admin }: { subtitle: string; footer?: ReactNode; children: ReactNode; admin?: boolean }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div
            className={`mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl text-xl font-bold text-white ${admin ? "bg-slate-800" : "bg-emerald-600"}`}
          >
            F
          </div>
          <h1 className="text-xl font-bold">{admin ? "FitCoach · Admin" : "FitCoach"}</h1>
          <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">{children}</div>
        {footer && <p className="mt-4 text-center text-xs text-slate-500">{footer}</p>}
      </div>
    </main>
  );
}
