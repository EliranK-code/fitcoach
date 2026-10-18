import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { getSession } from "@/lib/session";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getSession()) redirect("/");
  return (
    <AuthShell
      subtitle="כניסה לדשבורד המאמן"
      footer={
        <>
          אין לכם משתמש? בקשו קישור הזמנה ממנהל המערכת.
          {/* Admins have their own account and sign-in page, even with the same email. */}
          <Link href="/admin/login" className="mt-2 block text-slate-600 underline hover:text-slate-900">
            כניסת מנהלי מערכת
          </Link>
        </>
      }
    >
      <LoginForm />
    </AuthShell>
  );
}
