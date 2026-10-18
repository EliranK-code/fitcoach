// The dashboard's Content Security Policy, built per request by proxy.ts with a fresh nonce. Next.js reads the
// nonce from the request's CSP header and puts it on its own scripts; 'strict-dynamic' then trusts the scripts
// those load (the Facebook SDK is one). Nothing else runs: no inline scripts, no other origins.

/** Pages where Meta's Embedded Signup can render: only they may talk to Facebook. */
export const FACEBOOK_PATHS = ["/settings"];

const FACEBOOK = "https://*.facebook.com";

export function usesFacebook(pathname: string): boolean {
  return FACEBOOK_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function buildCsp(opts: { nonce: string; dev: boolean; facebook: boolean }): string {
  const fb = (...sources: string[]) => (opts.facebook ? sources : []);
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // 'unsafe-eval' only in development: React uses eval there for its debugging tools, never in production.
    "script-src": ["'self'", `'nonce-${opts.nonce}'`, "'strict-dynamic'", ...fb("https://connect.facebook.net"), ...(opts.dev ? ["'unsafe-eval'"] : [])],
    // Inline style attributes (the usage bars) need 'unsafe-inline'; styles can't run code.
    "style-src": ["'self'", "'unsafe-inline'"],
    // data: for the MFA QR code.
    "img-src": ["'self'", "data:", "blob:", ...fb(FACEBOOK, "https://*.fbcdn.net")],
    "font-src": ["'self'"],
    "connect-src": ["'self'", ...fb(FACEBOOK), ...(opts.dev ? ["ws:"] : [])],
    "frame-src": opts.facebook ? [FACEBOOK] : ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}
