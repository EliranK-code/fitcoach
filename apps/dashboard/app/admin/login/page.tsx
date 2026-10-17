import { redirect } from "next/navigation";
import { AdminLoginForm } from "@/components/admin-forms";
import { AuthShell } from "@/components/auth-shell";
import { getAdmin } from "@/lib/admin-session";

export const dynamic = "force-dynamic";

export default async function AdminLoginPage() {
  const s = await getAdmin();
  if (s?.mfaVerified) redirect("/admin");
  return (
    <AuthShell admin subtitle="כניסת מנהלי הפלטפורמה" footer="משתמשי ניהול נוצרים רק בטרמינל: npm run admin -- superadmin:create">
      <AdminLoginForm />
    </AuthShell>
  );
}
