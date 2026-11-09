import { budgetStatus, formatUsd, type MonthUsage } from "@fitcoach/core";
import { USAGE_KIND_LABEL } from "@/lib/labels";
import { Notice } from "./ui";

const BAR_TONE = { none: "bg-slate-300", ok: "bg-emerald-500", warn: "bg-amber-500", over: "bg-red-500" } as const;

/** This month's usage and estimated cost, with the soft budget and the hard cap when set. Used by the coach and the admin panel. */
export function UsageSummary({ usage, budgetUsd, capUsd }: { usage: MonthUsage; budgetUsd?: number | null; capUsd?: number | null }) {
  const budget = budgetStatus(usage.costMicros, budgetUsd);
  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-2xl font-bold" dir="ltr">
            {formatUsd(usage.costMicros)}
          </span>
          <span className="text-xs text-slate-500">
            {budget.percent === null ? "Estimated cost this month" : `${budget.percent}% of a $${budgetUsd} monthly budget`}
          </span>
        </div>
        {budget.percent !== null && (
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
            <div className={`h-full rounded-full ${BAR_TONE[budget.level]}`} style={{ width: `${Math.min(100, budget.percent)}%` }} />
          </div>
        )}
        {capUsd ? (
          <p className="mt-2 text-xs text-slate-500">
            Hard cap: <span dir="ltr">${capUsd}</span> a month. When it's reached the bot stops answering clients, and their messages are kept in the conversation.
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-2 text-center text-xs text-slate-500">
        <div className="rounded-lg bg-slate-50 p-2">
          <div className="text-base font-semibold text-slate-800">{usage.messagesIn.toLocaleString()}</div>
          Incoming messages
        </div>
        <div className="rounded-lg bg-slate-50 p-2">
          <div className="text-base font-semibold text-slate-800">{usage.messagesOut.toLocaleString()}</div>
          Outgoing messages
        </div>
        <div className="rounded-lg bg-slate-50 p-2">
          <div className="text-base font-semibold text-slate-800">{usage.templates.toLocaleString()}</div>
          Templates
        </div>
      </div>
      {usage.byKind.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500">
            <tr>
              <th className="pb-2 text-start font-medium">Type</th>
              <th className="pb-2 text-end font-medium">Count</th>
              <th className="pb-2 text-end font-medium">Tokens</th>
              <th className="pb-2 text-end font-medium">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {usage.byKind.map((k) => (
              <tr key={k.kind}>
                <td className="py-1.5">{USAGE_KIND_LABEL[k.kind] ?? k.kind}</td>
                <td className="py-1.5 text-end">{(k.quantity || k.events).toLocaleString()}</td>
                <td className="py-1.5 text-end">{k.tokens ? k.tokens.toLocaleString() : "-"}</td>
                <td className="py-1.5 text-end" dir="ltr">
                  {formatUsd(k.costMicros)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-xs text-slate-500">
        Estimated from Anthropic and OpenAI pricing. Messages inside the 24-hour window are free on WhatsApp; templates are not.
      </p>
    </div>
  );
}

/** Shown to the coach at 80% and 100% of the soft budget. Nothing stops working. */
export function BudgetNotice({ usage, budgetUsd }: { usage: MonthUsage; budgetUsd?: number | null }) {
  const budget = budgetStatus(usage.costMicros, budgetUsd);
  if (budget.level !== "warn" && budget.level !== "over") return null;
  return (
    <div className="mb-6">
      <Notice tone={budget.level === "over" ? "red" : "yellow"}>
        Usage this month reached {budget.percent}% of the budget ({formatUsd(usage.costMicros)} of ${budgetUsd}). The bot keeps working as usual, and the administrator sees this
        in the admin panel.
      </Notice>
    </div>
  );
}
