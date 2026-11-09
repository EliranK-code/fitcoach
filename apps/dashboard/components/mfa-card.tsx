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
          <Badge tone="green">On</Badge> Every sign-in asks for a code from your authenticator app. To turn it off, enter a current code.
        </p>
        <CodeForm action={disableMfaAction} submitLabel="Turn off two-step verification" variant="secondary" />
      </div>
    );
  }
  if (!setup) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          An extra layer of protection: besides the password, every sign-in asks for a code from an app such as Google Authenticator or Microsoft Authenticator. Recommended, because the dashboard holds clients' health information.
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
          Turn on
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-1 ps-5 text-sm text-slate-600">
        <li>Scan the code with your authenticator app.</li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>
      {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL */}
      <img src={setup.qr} alt="QR code for setting up the authenticator app" width={180} height={180} className="rounded-lg border border-slate-200" />
      <p className="text-xs text-slate-500">
        Can't scan? Type this key into the app:{" "}
        <code dir="ltr" className="break-all rounded bg-slate-100 px-1 py-0.5">
          {setup.secret}
        </code>
      </p>
      <CodeForm action={confirmMfaAction} submitLabel="Confirm and turn on" />
    </div>
  );
}
