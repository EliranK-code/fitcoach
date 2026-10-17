import { buildKnowledgePrompt, getKnowledge, listDocuments, listKnowledgeVersions } from "@fitcoach/core";
import { DocumentUpload } from "@/components/document-upload";
import { KnowledgeForm } from "@/components/knowledge-form";
import { Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { deleteDocumentAction } from "@/lib/actions/knowledge";
import { formatDateTime } from "@/lib/labels";
import { requireSession } from "@/lib/session";

export default async function KnowledgePage() {
  const s = await requireSession();
  const db = s.handle.db;
  const knowledge = await getKnowledge(db, s.t);
  if (!knowledge) {
    return <EmptyState title="עוד אין בסיס ידע">טוענים את מאמן הדמו עם npm run seed, או מייבאים מאמן עם coach:import.</EmptyState>;
  }
  const docs = await listDocuments(db, s.t);
  const versions = await listKnowledgeVersions(db, s.t, 10);
  const prompt = await buildKnowledgePrompt(db, s.t, s.cfg.KNOWLEDGE_INLINE_MAX_TOKENS);
  const tz = s.t.settings.timezone ?? s.cfg.TIMEZONE;

  return (
    <>
      <PageHeader
        title="בסיס הידע"
        description={`הבוט עונה רק לפי מה שכאן. גרסה נוכחית: ${knowledge.version}`}
      />
      {s.t.settings.starterKnowledge && (
        <div className="mb-6">
          <Notice tone="yellow">
            זו תבנית התחלתית. מלאו את הפרטים על השיטה שלך ולחצו על "שמור ופרסם גרסה חדשה". אחרי הפרסום הראשון אפשר לחבר מספר וואטסאפ.
          </Notice>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <KnowledgeForm initial={knowledge.data} />
        </div>
        <div className="space-y-6">
          <Card title="מסמכים">
            {docs.length === 0 ? (
              <p className="mb-4 text-sm text-slate-500">עוד אין מסמכים.</p>
            ) : (
              <ul className="mb-4 divide-y divide-slate-100 text-sm">
                {docs.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{d.title}</div>
                      <div className="text-xs text-slate-500">כ-{d.tokenEstimate.toLocaleString("he-IL")} טוקנים</div>
                    </div>
                    <form action={deleteDocumentAction.bind(null, d.id)}>
                      <button className="text-xs text-red-600 hover:underline">הסרה</button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            <DocumentUpload />
            <p className="mt-4 text-xs text-slate-500">
              {prompt.ragMode
                ? "בסיס הידע גדול: הבוט מחפש במסמכים לפי הצורך (RAG)."
                : "כל המסמכים נכנסים להנחיות של הבוט בכל שיחה."}
            </p>
          </Card>

          <Card title="היסטוריית גרסאות">
            <ul className="space-y-1.5 text-sm">
              {versions.map((v) => (
                <li key={v.version} className="flex justify-between">
                  <span className={v.version === knowledge.version ? "font-semibold" : ""}>גרסה {v.version}</span>
                  <span className="text-slate-500">{formatDateTime(v.createdAt, tz)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
