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
      subtitle="Coach dashboard sign-in"
      footer={
        <>
          No user yet? Ask the administrator for an invite link.
          {/* Admins have their own account and sign-in page, even with the same email. */}
          <Link href="/admin/login" className="mt-2 block text-slate-600 underline hover:text-slate-900">
            Platform admin sign-in
          </Link>
        </>
      }
    >
      <LoginForm />
    </AuthShell>
  );
}
