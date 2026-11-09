import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { CodeForm } from "@/components/code-form";
import { verifyLoginCodeAction } from "@/lib/actions/auth";
import { getSession, SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function VerifyPage() {
  if (await getSession()) redirect("/");
  if (!(await cookies()).get(SESSION_COOKIE)) redirect("/login");
  return (
    <AuthShell subtitle="Two-step verification" footer="Lost your phone? The administrator can turn off two-step verification.">
      <CodeForm action={verifyLoginCodeAction} submitLabel="Sign in" />
    </AuthShell>
  );
}
