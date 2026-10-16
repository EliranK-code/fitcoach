import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getSession()) redirect("/");
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-600 text-xl font-bold text-white">F</div>
          <h1 className="text-xl font-bold">FitCoach</h1>
          <p className="mt-1 text-sm text-slate-500">כניסה לדשבורד המאמן</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <LoginForm />
        </div>
        <p className="mt-4 text-center text-xs text-slate-500">
          אין לכם משתמש? יוצרים אחד בטרמינל: <code dir="ltr">npm run admin -- user:create --email ...</code>
        </p>
      </div>
    </main>
  );
}
