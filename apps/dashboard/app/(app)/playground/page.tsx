import { Card, Notice, PageHeader } from "@/components/ui";
import { Playground } from "@/components/playground";
import { playgroundHistory } from "@/lib/actions/playground";
import { requireSession } from "@/lib/session";

export default async function PlaygroundPage() {
  const s = await requireSession();
  const history = await playgroundHistory();
  return (
    <>
      <PageHeader
        title="מגרש משחקים"
        description="בדקו את הבוט לפני שהוא מדבר עם לקוחות אמיתיים: אותו מנוע, אותו ידע, אותם כללי בטיחות"
      />
      {!s.cfg.ANTHROPIC_API_KEY && (
        <div className="mb-4">
          <Notice tone="yellow">
            חסר ANTHROPIC_API_KEY בקובץ .env. בלי המפתח עובדת רק הודעת ההסכמה, והבוט לא יוכל לענות.
          </Notice>
        </div>
      )}
      <Card>
        <Playground history={history} />
      </Card>
      <p className="mt-3 text-xs text-slate-500">
        השיחה כאן נשמרת כלקוח בדיקה נפרד: היא לא מופיעה ברשימת הלקוחות ובסטטיסטיקות, אבל התראות שהיא פותחת כן מופיעות בתור. "התחל מחדש" מוחק את
        לקוח הבדיקה.
      </p>
    </>
  );
}
