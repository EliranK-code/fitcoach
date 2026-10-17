"use client";

import { useState, useTransition } from "react";
import { confirmMfaAction, disableMfaAction, startMfaSetupAction } from "@/lib/actions/mfa";
import { CodeForm } from "./code-form";
import { Badge, Button, Notice } from "./ui";

/** Optional two-step login for the signed-in coach user: set up with a QR code, or turn off with a current code. */
export function MfaCard({ enabled }: { enabled: boolean }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (enabled) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          <Badge tone="green">פעיל</Badge> כל כניסה מבקשת קוד מאפליקציית האימות. כדי לבטל, הזינו קוד נוכחי.
        </p>
        <CodeForm action={disableMfaAction} submitLabel="ביטול האימות הדו-שלבי" variant="secondary" />
      </div>
    );
  }
  if (!setup) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          שכבת הגנה נוספת: מלבד הסיסמה, כל כניסה תבקש קוד מאפליקציה כמו Google Authenticator או Microsoft Authenticator. מומלץ, כי בדשבורד יש מידע בריאותי של לקוחות.
        </p>
        {error && <Notice tone="red">{error}</Notice>}
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const res = await startMfaSetupAction();
              if ("error" in res) setError(res.error);
              else setSetup(res);
            })
          }
        >
          הפעלה
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-1 ps-5 text-sm text-slate-600">
        <li>סרקו את הקוד באפליקציית האימות.</li>
        <li>הזינו את הקוד בן 6 הספרות שמופיע בה.</li>
      </ol>
      {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL */}
      <img src={setup.qr} alt="קוד QR להגדרת אפליקציית האימות" width={180} height={180} className="rounded-lg border border-slate-200" />
      <p className="text-xs text-slate-500">
        אי אפשר לסרוק? הקלידו באפליקציה את המפתח:{" "}
        <code dir="ltr" className="break-all rounded bg-slate-100 px-1 py-0.5">
          {setup.secret}
        </code>
      </p>
      <CodeForm action={confirmMfaAction} submitLabel="אישור והפעלה" />
    </div>
  );
}
