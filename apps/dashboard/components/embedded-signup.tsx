"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { FormState } from "@/lib/actions/auth";
import { completeSignupAction } from "@/lib/actions/settings";
import { Button, Field, Input, Notice } from "./ui";

// The browser half of Meta's Embedded Signup: Facebook's popup returns a one-time code (FB.login callback)
// and, separately, the WABA and phone number the coach picked (a postMessage from facebook.com). Both go to
// the server, which does the rest. In dry run a simulated popup stands in for Meta.

interface FacebookSdk {
  init(opts: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(cb: (res: { authResponse?: { code?: string } }) => void, opts: Record<string, unknown>): void;
}
declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

function loadSdk(appId: string, version: string): Promise<FacebookSdk> {
  if (window.FB) return Promise.resolve(window.FB);
  return new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB!);
    };
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => reject(new Error("sdk"));
    document.body.appendChild(script);
  });
}

const FACEBOOK_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?facebook\.com$/;

export function EmbeddedSignup(props: { mode: "live" | "mock"; appId?: string; configId?: string; graphVersion: string }) {
  const [state, setState] = useState<FormState>({});
  const [pending, startTransition] = useTransition();
  const [simulating, setSimulating] = useState(false);
  const session = useRef<{ code?: string; wabaId?: string; phoneNumberId?: string }>({});

  const submitWhenReady = () => {
    const { code, wabaId, phoneNumberId } = session.current;
    if (!code || !wabaId || !phoneNumberId) return;
    session.current = {};
    startTransition(async () => setState(await completeSignupAction({ code, wabaId, phoneNumberId })));
  };

  useEffect(() => {
    if (props.mode !== "live") return;
    const onMessage = (event: MessageEvent) => {
      if (!FACEBOOK_ORIGIN.test(event.origin) || typeof event.data !== "string") return;
      let data: { type?: string; event?: string; data?: { phone_number_id?: string; waba_id?: string } };
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data.type !== "WA_EMBEDDED_SIGNUP") return;
      if (data.event === "CANCEL") setState({ error: "The connection was cancelled before it finished." });
      if (data.event === "FINISH" && data.data?.phone_number_id && data.data.waba_id) {
        session.current = { ...session.current, phoneNumberId: data.data.phone_number_id, wabaId: data.data.waba_id };
        submitWhenReady();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mode]);

  const startLive = async () => {
    setState({});
    let fb: FacebookSdk;
    try {
      fb = await loadSdk(props.appId!, props.graphVersion);
    } catch {
      return setState({ error: "Couldn't load Facebook. Check that an ad blocker isn't blocking connect.facebook.net." });
    }
    fb.login(
      (res) => {
        if (!res.authResponse?.code) return setState({ error: "The Facebook connection wasn't completed." });
        session.current = { ...session.current, code: res.authResponse.code };
        submitWhenReady();
      },
      {
        config_id: props.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
      },
    );
  };

  return (
    <div className="space-y-3">
      {state.error && <Notice tone="red">{state.error}</Notice>}
      {state.ok && <Notice tone="green">{state.ok}</Notice>}
      {props.mode === "live" ? (
        <>
          <p className="text-sm text-slate-600">
            The connection happens in a Facebook window: you pick or create a WhatsApp Business account and a number, and approve. The number must be free (not active in the WhatsApp
            Business app on a phone).
          </p>
          <Button size="sm" onClick={startLive} disabled={pending}>
            {pending ? "Connecting…" : "Connect a WhatsApp number"}
          </Button>
        </>
      ) : !simulating ? (
        <>
          <Notice tone="yellow">Simulation mode (WHATSAPP_DRY_RUN): a mock form opens instead of the Facebook window, and messages to the number are only logged.</Notice>
          <Button size="sm" onClick={() => setSimulating(true)}>
            Connect a WhatsApp number (simulation)
          </Button>
        </>
      ) : (
        <form
          className="space-y-3 rounded-lg border border-dashed border-slate-300 p-3"
          action={(form) => {
            const id = String(form.get("phoneNumberId") ?? "").trim();
            const display = String(form.get("displayPhone") ?? "").trim();
            startTransition(async () => {
              const res = await completeSignupAction({ code: `mock:${id}:${display}`, wabaId: "mock-waba", phoneNumberId: id });
              setState(res);
              if (res.ok) setSimulating(false);
            });
          }}
        >
          <div className="text-xs font-medium text-slate-500">Mock Meta window Meta</div>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Number id (phone_number_id)">
              <Input name="phoneNumberId" required dir="ltr" defaultValue={`sim-${Math.floor(Math.random() * 1e9)}`} />
            </Field>
            <Field label="Display number">
              <Input name="displayPhone" dir="ltr" defaultValue="+1 555-000-0000" />
            </Field>
          </div>
          <Button size="sm" disabled={pending}>
            {pending ? "Connecting…" : "Confirm"}
          </Button>
        </form>
      )}
    </div>
  );
}
