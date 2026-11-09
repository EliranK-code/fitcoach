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
      <AuthShell admin subtitle="Two-step verification">
        <CodeForm action={adminVerifyAction} submitLabel="Sign in" />
      </AuthShell>
    );
  }
  const { secret, uri } = await adminTotpSetup(s.handle.db, s.admin);
  return (
    <AuthShell admin subtitle="Set up two-step verification (required for admins)">
      <div className="space-y-4">
        <ol className="list-decimal space-y-1 ps-5 text-sm text-slate-600">
          <li>Scan the code with an authenticator app (Google Authenticator, Microsoft Authenticator, etc.).</li>
          <li>Enter the 6-digit code it shows.</li>
        </ol>
        {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL */}
        <img src={await qrDataUrl(uri)} alt="QR code for setting up the authenticator app" width={180} height={180} className="mx-auto rounded-lg border border-slate-200" />
        <p className="text-xs text-slate-500">
          Can't scan? Type this key into the app:{" "}
          <code dir="ltr" className="break-all rounded bg-slate-100 px-1 py-0.5">
            {secret}
          </code>
        </p>
        <CodeForm action={adminVerifyAction} submitLabel="Confirm and continue" />
      </div>
    </AuthShell>
  );
}
