import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "FitCoach · Coach dashboard",
  description: "Manage the coach's bot, clients and knowledge",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the request headers keeps every page dynamic, so each one gets the CSP nonce from proxy.ts
  // (a page prerendered at build time would have scripts without it, and the browser would block them).
  await headers();
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
