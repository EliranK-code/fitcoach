import { inspectLink } from "@fitcoach/core";
import { redeemLinkAction } from "@/lib/actions/auth";
import { services } from "@/lib/services";
import { AuthShell } from "./auth-shell";
import { LinkPasswordForm } from "./link-password-form";
import { Notice } from "./ui";

/** Shared by /invite/[token] and /reset/[token]: the link decides what it is, the URL only routes. */
export async function LinkPage({ token, expected }: { token: string; expected: "invite" | "reset" }) {
  const { handle } = await services();
  const link = await inspectLink(handle.db, token);
  if (!link || link.purpose !== expected) {
    return (
      <AuthShell subtitle="קישור">
        <Notice tone="red">הקישור לא תקף: אולי כבר השתמשו בו או שפג תוקפו. בקשו קישור חדש ממנהל המערכת.</Notice>
      </AuthShell>
    );
  }
  const invite = link.purpose === "invite";
  return (
    <AuthShell subtitle={invite ? `הצטרפות לדשבורד של ${link.coachName}` : "בחירת סיסמה חדשה"}>
      <LinkPasswordForm action={redeemLinkAction.bind(null, token)} email={link.email} submitLabel={invite ? "יצירת משתמש וכניסה" : "שמירה וכניסה"} />
    </AuthShell>
  );
}
