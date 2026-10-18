import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, usesFacebook } from "./lib/csp";

// A fresh CSP nonce for every page request. Next.js takes the nonce from the request header and adds it to
// its scripts, so every page must render dynamically (the root layout reads the headers to make sure).

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const csp = buildCsp({ nonce, dev: process.env.NODE_ENV === "development", facebook: usesFacebook(request.nextUrl.pathname) });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: API routes return JSON and static files carry no scripts of their own.
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
