import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { getSession } from "@/lib/session";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getSession()) redirect("/");
  return (
    <AuthShell subtitle="כניסה לדשבורד המאמן" footer="אין לכם משתמש? בקשו קישור הזמנה ממנהל המערכת.">
      <LoginForm />
    </AuthShell>
  );
}
