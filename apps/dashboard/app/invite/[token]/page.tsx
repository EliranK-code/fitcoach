import { LinkPage } from "@/components/link-page";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  return <LinkPage token={(await params).token} expected="invite" />;
}
