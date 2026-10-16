import type { NextConfig } from "next";

const config: NextConfig = {
  // The core package ships TypeScript sources; Next compiles them with the app.
  transpilePackages: ["@fitcoach/core"],
  // Native/WASM and Node-only libraries stay out of the bundle and load from node_modules at runtime.
  serverExternalPackages: [
    "@electric-sql/pglite",
    "@electric-sql/pglite-pgvector",
    "postgres",
    "pino",
    "unpdf",
    "mammoth",
    "sharp",
  ],
  // Type checking runs separately (npm run typecheck): TypeScript 7 is the native compiler.
  typescript: { ignoreBuildErrors: true },
  poweredByHeader: false,
  // Knowledge documents (PDF, Word, menu photos) are uploaded through a server action.
  experimental: { serverActions: { bodySizeLimit: "10mb" } },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default config;
