import Link from "next/link";
import { listCoaches } from "@fitcoach/core";
import { NewCoachForm } from "@/components/admin-forms";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { requireAdmin } from "@/lib/admin-session";

export default async function AdminCoachesPage() {
  const s = await requireAdmin();
  const coaches = await listCoaches(s.handle.db);
  return (
    <>
      <PageHeader title="מאמנים" description="סטטוס, לקוחות ושימוש החודש. פרטי לקוחות לא מוצגים כאן." />
      <div className="space-y-6">
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
                    <th className="py-2 text-end font-medium">טוקנים החודש</th>
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
                      <td className="py-2 text-end">{c.monthTokens.toLocaleString()}</td>
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
