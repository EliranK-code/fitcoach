import { handleWebhookGet, handleWebhookPost, readBodyWithLimit } from "@fitcoach/core";
import { services } from "@/lib/services";

// The WhatsApp webhook, served by the dashboard process (same code as the standalone server). The
// worker that answers queued messages runs in this process too (see lib/services.ts).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { cfg } = await services();
  const res = handleWebhookGet(Object.fromEntries(new URL(req.url).searchParams), cfg);
  return new Response(res.body ?? "", { status: res.status, headers: { "Content-Type": "text/plain" } });
}

export async function POST(req: Request) {
  // The signature covers the exact bytes Meta sent, so read the raw body before any parsing (with a size cap,
  // since anyone can post here before the signature is checked).
  const raw = await readBodyWithLimit(req);
  if (!raw) return new Response("", { status: 413 });
  const { cfg, handle } = await services();
  const res = await handleWebhookPost(handle.db, cfg, raw, req.headers.get("x-hub-signature-256") ?? undefined);
  return new Response(res.body ?? "", { status: res.status });
}
