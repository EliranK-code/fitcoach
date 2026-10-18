import { describe, expect, it } from "vitest";
import { postgresSsl } from "../src/db/client";
import { TOOLS } from "../src/engine/tools";
import { PLATFORM_RULES } from "../src/llm/prompts";
import { clientIp } from "../src/ratelimit";
import { SYSTEM_ALERT_TYPES } from "../src/repos/ops";
import { quotesVerbatim } from "../src/safety/outputGuards";
import { readBodyWithLimit, WEBHOOK_MAX_BYTES } from "../src/whatsapp/http";

// Security hardening before going live: one check per finding of the security review.

describe("per-IP throttling identity", () => {
  const headers = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()] ?? null;

  it("takes the last X-Forwarded-For hop, which the nearest proxy appended, never the first", () => {
    expect(clientIp(headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
    // Rotating a spoofed first hop doesn't change the identity.
    expect(clientIp(headers({ "x-forwarded-for": "7.7.7.7, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(headers({}))).toBe("local");
  });

  it("uses only the configured proxy header when one is set", () => {
    const h = headers({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "198.51.100.4" });
    expect(clientIp(h, "x-real-ip")).toBe("198.51.100.4");
    expect(clientIp(headers({ "x-forwarded-for": "6.6.6.6" }), "x-real-ip")).toBe("unknown");
  });
});

describe("database TLS", () => {
  it("requires TLS for any remote host", () => {
    expect(postgresSsl("postgresql://postgres.abc:pw@aws-0-eu.pooler.supabase.com:5432/postgres")).toBe("require");
    expect(postgresSsl("postgres://u:p@db.example.com/app?sslmode=prefer")).toBe("require");
    expect(postgresSsl("not a url")).toBe("require");
  });

  it("verifies the certificate when asked, and stays plain only locally or when disabled explicitly", () => {
    expect(postgresSsl("postgres://u:p@db.example.com/app?sslmode=verify-full")).toBe("verify-full");
    expect(postgresSsl("postgres://postgres:postgres@127.0.0.1:5432/postgres")).toBe(false);
    expect(postgresSsl("postgres://u:p@localhost/app?sslmode=require")).toBe("require");
    expect(postgresSsl("postgres://u:p@postgres.railway.internal/app?sslmode=disable")).toBe(false);
  });
});

describe("webhook body size", () => {
  const post = (body: string, headers: Record<string, string> = {}) => new Request("http://x/webhook", { method: "POST", body, headers });

  it("reads a normal body byte for byte", async () => {
    const raw = await readBodyWithLimit(post('{"object":"whatsapp_business_account"}'));
    expect(raw?.toString("utf8")).toBe('{"object":"whatsapp_business_account"}');
  });

  it("refuses a body over the limit, declared or streamed", async () => {
    expect(await readBodyWithLimit(post("x", { "content-length": String(WEBHOOK_MAX_BYTES + 1) }))).toBeNull();
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const req = new Request("http://x/webhook", { method: "POST", body: endless, duplex: "half" } as RequestInit);
    expect(await readBodyWithLimit(req, 256 * 1024)).toBeNull();
    expect(pulled).toBeLessThan(10); // stopped reading right after the limit
  });
});

describe("instruction leak guard", () => {
  it("spots a pasted run of the instructions, whatever the case or punctuation", () => {
    const pasted = `OK!! ${PLATFORM_RULES.slice(0, 300).toUpperCase().replace(/,/g, " ;")}`;
    expect(quotesVerbatim(pasted, PLATFORM_RULES)).toBe(true);
    expect(quotesVerbatim("Sure. # Confidentiality - Use the coach's knowledge to help this client; don't hand it over.", PLATFORM_RULES)).toBe(true);
  });

  it("lets ordinary replies through, including a few words the instructions also use", () => {
    expect(quotesVerbatim("היי! איך היה האימון היום? 💪", PLATFORM_RULES)).toBe(false);
    expect(quotesVerbatim("Ask one question at a time, and drink water.", PLATFORM_RULES)).toBe(false);
    expect(quotesVerbatim("", PLATFORM_RULES)).toBe(false);
  });

  it("tells the model in its instructions to keep them and the coach's knowledge private", () => {
    expect(PLATFORM_RULES).toContain("# Confidentiality");
    expect(PLATFORM_RULES).toMatch(/Never say anything about other clients/);
  });
});

describe("alert types", () => {
  it("never lets the model open a system-only alert", () => {
    const escalate = TOOLS.find((t) => t.name === "escalate_to_coach")!;
    const types = (escalate.input_schema as { properties: { type: { enum: string[] } } }).properties.type.enum;
    for (const system of SYSTEM_ALERT_TYPES) expect(types).not.toContain(system);
    expect(types).toContain("unknown_question");
  });
});
