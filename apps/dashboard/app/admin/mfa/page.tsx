import { redirect } from "next/navigation";
import { adminTotpSetup } from "@fitcoach/core";
import { AuthShell } from "@/components/auth-shell";
import { CodeForm } from "@/components/code-form";
import { adminVerifyAction } from "@/lib/actions/admin";
import { getAdmin } from "@/lib/admin-session";
import { qrDataUrl } from "@/lib/qr";

export const dynamic = "force-dynamic";

/** The mandatory second step: first-time TOTP setup (QR code), or the code at every login. */
export default async function AdminMfaPage() {
  const s = await getAdmin();
  if (!s) redirect("/admin/login");
  if (s.mfaVerified) redirect("/admin");

  if (s.admin.totpEnabledAt) {
    return (
      <AuthShell admin subtitle="אימות דו-שלבי">
        <CodeForm action={adminVerifyAction} submitLabel="כניסה" />
      </AuthShell>
    );
  }
  const { secret, uri } = await adminTotpSetup(s.handle.db, s.admin);
  return (
    <AuthShell admin subtitle="הגדרת אימות דו-שלבי (חובה למנהלים)">
      <div className="space-y-4">
        <ol className="list-decimal space-y-1 ps-5 text-sm text-slate-600">
          <li>סרקו את הקוד באפליקציית אימות (Google Authenticator, Microsoft Authenticator וכו').</li>
          <li>הזינו את הקוד בן 6 הספרות שמופיע בה.</li>
        </ol>
        {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL */}
        <img src={await qrDataUrl(uri)} alt="קוד QR להגדרת אפליקציית האימות" width={180} height={180} className="mx-auto rounded-lg border border-slate-200" />
        <p className="text-xs text-slate-500">
          אי אפשר לסרוק? מקלידים באפליקציה את המפתח:{" "}
          <code dir="ltr" className="break-all rounded bg-slate-100 px-1 py-0.5">
            {secret}
          </code>
        </p>
        <CodeForm action={adminVerifyAction} submitLabel="אישור והמשך" />
      </div>
    </AuthShell>
  );
}
