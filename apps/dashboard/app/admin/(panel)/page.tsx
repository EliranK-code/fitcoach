import Link from "next/link";
import { budgetStatus, formatUsd, listCoaches, platformDaySpendMicros } from "@fitcoach/core";
import { NewCoachForm } from "@/components/admin-forms";
import { Badge, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { requireAdmin } from "@/lib/admin-session";

function BudgetBadge({ costMicros, budgetUsd }: { costMicros: number; budgetUsd: number | null }) {
  const { level, percent } = budgetStatus(costMicros, budgetUsd);
  if (percent === null) return null;
  return (
    <span className="ms-2">
      <Badge tone={level === "over" ? "red" : level === "warn" ? "yellow" : "gray"}>{percent}%</Badge>
    </span>
  );
}

export default async function AdminCoachesPage() {
  const s = await requireAdmin();
  const coaches = await listCoaches(s.handle.db);
  const daySpend = await platformDaySpendMicros(s.handle.db);
  const dayCap = s.cfg.PLATFORM_DAILY_CAP_USD;
  const dayCapReached = dayCap > 0 && daySpend >= dayCap * 1_000_000;
  return (
    <>
      <PageHeader title="מאמנים" description="סטטוס, לקוחות ועלות משוערת החודש (אחוז מהתקציב, אם הוגדר). פרטי לקוחות לא מוצגים כאן." />
      <div className="space-y-6">
        <Notice tone={dayCapReached ? "red" : undefined}>
          הוצאה היום בכל הפלטפורמה (לפי UTC): <span dir="ltr">{formatUsd(daySpend)}</span>
          {dayCap > 0 ? (
            <>
              {" "}
              מתוך תקרה יומית של <span dir="ltr">${dayCap}</span>.
              {dayCapReached && " התקרה הושגה: כל הבוטים מפסיקים לענות עד מחר. אפשר להעלות אותה ב-PLATFORM_DAILY_CAP_USD."}
            </>
          ) : (
            ". אין תקרה יומית (PLATFORM_DAILY_CAP_USD=0)."
          )}
        </Notice>
        <Card>
          {coaches.length === 0 ? (
            <EmptyState title="עוד אין מאמנים">יוצרים מאמן ראשון בטופס למטה.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-start text-xs text-slate-500">
                  <tr className="border-b border-slate-200">
                    <th className="py-2 text-start font-medium">מאמן</th>
                    <th className="py-2 text-start font-medium">סטטוס</th>
                    <th className="py-2 text-start font-medium">בסיס ידע</th>
                    <th className="py-2 text-end font-medium">מספרים</th>
                    <th className="py-2 text-end font-medium">לקוחות</th>
                    <th className="py-2 text-end font-medium">עלות החודש</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {coaches.map((c) => (
                    <tr key={c.id}>
                      <td className="py-2">
                        <Link href={`/admin/coaches/${c.slug}`} className="font-medium text-emerald-700 hover:underline">
                          {c.name}
                        </Link>
                        <div className="text-xs text-slate-500" dir="ltr">
                          {c.slug}
                        </div>
                      </td>
                      <td className="py-2">{c.status === "suspended" ? <Badge tone="yellow">מושהה</Badge> : <Badge tone="green">פעיל</Badge>}</td>
                      <td className="py-2">{c.starterKnowledge ? <Badge tone="orange">ממתין למילוי</Badge> : <Badge>מוכן</Badge>}</td>
                      <td className="py-2 text-end">{c.numbers}</td>
                      <td className="py-2 text-end">{c.clients}</td>
                      <td className="py-2 text-end">
                        <span dir="ltr">{formatUsd(c.monthCostMicros)}</span>
                        <BudgetBadge costMicros={c.monthCostMicros} budgetUsd={c.budgetUsd} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="מאמן חדש">
          <p className="mb-4 text-sm text-slate-500">
            המאמן נוצר עם תבנית ידע ריקה. אחרי היצירה שולחים לו קישור הזמנה, והוא ממלא את בסיס הידע בעצמו. אפשר לחבר מספר וואטסאפ רק אחרי שהוא מפרסם את הידע.
          </p>
          <NewCoachForm />
        </Card>
      </div>
    </>
  );
}
