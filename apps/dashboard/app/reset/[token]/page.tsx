import { LinkPage } from "@/components/link-page";

export const dynamic = "force-dynamic";

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  return <LinkPage token={(await params).token} expected="reset" />;
}
