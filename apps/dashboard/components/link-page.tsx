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
      <AuthShell subtitle="Link">
        <Notice tone="red">This link isn't valid: it may have been used already or expired. Ask the administrator for a new link.</Notice>
      </AuthShell>
    );
  }
  const invite = link.purpose === "invite";
  return (
    <AuthShell subtitle={invite ? `Join ${link.coachName}'s dashboard` : "Choose a new password"}>
      <LinkPasswordForm action={redeemLinkAction.bind(null, token)} email={link.email} submitLabel={invite ? "Create user and sign in" : "Save and sign in"} />
    </AuthShell>
  );
}
