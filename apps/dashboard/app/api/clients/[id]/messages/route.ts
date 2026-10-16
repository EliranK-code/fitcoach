import { NextResponse } from "next/server";
import { getClient, listChatMessages } from "@fitcoach/core";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Live conversation view: the client component polls this while the client page is open. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const client = await getClient(s.handle.db, s.t, id);
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  const messages = await listChatMessages(s.handle.db, s.t, id, 200);
  return NextResponse.json(
    { messages, botPaused: client.botPaused },
    { headers: { "Cache-Control": "no-store" } },
  );
}
