import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminLoginForm } from "@/components/admin-forms";
import { AuthShell } from "@/components/auth-shell";
import { getAdmin } from "@/lib/admin-session";

export const dynamic = "force-dynamic";

export default async function AdminLoginPage() {
  const s = await getAdmin();
  if (s?.mfaVerified) redirect("/admin");
  return (
    <AuthShell
      admin
      subtitle="Platform admin sign-in"
      footer={
        <>
          Admin users are created only in the terminal: <span dir="ltr">npm run admin -- superadmin:create</span>
          <Link href="/login" className="mt-2 block text-slate-600 underline hover:text-slate-900">
            Coach sign-in
          </Link>
        </>
      }
    >
      <AdminLoginForm />
    </AuthShell>
  );
}
