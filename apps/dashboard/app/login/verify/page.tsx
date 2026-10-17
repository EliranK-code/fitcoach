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
    <AuthShell subtitle="אימות דו-שלבי" footer="איבדתם את הטלפון? מנהל המערכת יכול לבטל את האימות הדו-שלבי.">
      <CodeForm action={verifyLoginCodeAction} submitLabel="כניסה" />
    </AuthShell>
  );
}
