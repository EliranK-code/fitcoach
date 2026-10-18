import { describe, expect, it } from "vitest";
import { buildCsp, usesFacebook } from "../lib/csp";

const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `))?.slice(name.length + 1).split(" ");

describe("content security policy", () => {
  it("allows only nonce'd scripts, and nothing can frame the dashboard", () => {
    const csp = buildCsp({ nonce: "abc123", dev: false, facebook: false });
    expect(directive(csp, "script-src")).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(csp, "frame-src")).toEqual(["'none'"]);
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
    expect(directive(csp, "base-uri")).toEqual(["'self'"]);
    expect(directive(csp, "form-action")).toEqual(["'self'"]);
    expect(directive(csp, "img-src")).toContain("data:"); // the MFA QR code
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("facebook");
  });

  it("opens Facebook only on the settings page, where Embedded Signup lives", () => {
    expect(usesFacebook("/settings")).toBe(true);
    expect(usesFacebook("/clients/1")).toBe(false);
    expect(usesFacebook("/settingsx")).toBe(false);
    const csp = buildCsp({ nonce: "n", dev: false, facebook: true });
    expect(directive(csp, "frame-src")).toEqual(["https://*.facebook.com"]);
    expect(directive(csp, "script-src")).toContain("https://connect.facebook.net");
    expect(directive(csp, "connect-src")).toContain("https://*.facebook.com");
  });

  it("adds eval and the dev-server socket only in development", () => {
    const csp = buildCsp({ nonce: "n", dev: true, facebook: false });
    expect(directive(csp, "script-src")).toContain("'unsafe-eval'");
    expect(directive(csp, "connect-src")).toContain("ws:");
  });
});
