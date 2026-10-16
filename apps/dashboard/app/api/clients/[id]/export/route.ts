import { NextResponse } from "next/server";
import { exportClientData } from "@fitcoach/core";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Right of access: everything stored about a client, as a JSON download. The export is audited. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const data = await exportClientData(s.handle.db, s.t, id, s.actor);
    return new NextResponse(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="client-${id}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
