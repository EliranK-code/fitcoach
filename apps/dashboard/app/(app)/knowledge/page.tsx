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
    return <EmptyState title="No knowledge base yet">Load the demo coach with npm run seed, or import a coach with coach:import.</EmptyState>;
  }
  const docs = await listDocuments(db, s.t);
  const versions = await listKnowledgeVersions(db, s.t, 10);
  const prompt = await buildKnowledgePrompt(db, s.t, s.cfg.KNOWLEDGE_INLINE_MAX_TOKENS);
  const tz = s.t.settings.timezone ?? s.cfg.TIMEZONE;

  return (
    <>
      <PageHeader
        title="Knowledge base"
        description={`The bot answers only from what's here. Current version: ${knowledge.version}`}
      />
      {s.t.settings.starterKnowledge && (
        <div className="mb-6">
          <Notice tone="yellow">
            This is a starter template. Fill in the details of your method and click "Save and publish a new version". After the first publish you can connect a WhatsApp number.
          </Notice>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <KnowledgeForm initial={knowledge.data} />
        </div>
        <div className="space-y-6">
          <Card title="Documents">
            {docs.length === 0 ? (
              <p className="mb-4 text-sm text-slate-500">No documents yet.</p>
            ) : (
              <ul className="mb-4 divide-y divide-slate-100 text-sm">
                {docs.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{d.title}</div>
                      <div className="text-xs text-slate-500">~{d.tokenEstimate.toLocaleString("en-US")} tokens</div>
                    </div>
                    <form action={deleteDocumentAction.bind(null, d.id)}>
                      <button className="text-xs text-red-600 hover:underline">Remove</button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            <DocumentUpload />
            <p className="mt-4 text-xs text-slate-500">
              {prompt.ragMode
                ? "The knowledge base is large: the bot searches the documents as needed (RAG)."
                : "All documents go into the bot's instructions in every conversation."}
            </p>
          </Card>

          <Card title="Version history">
            <ul className="space-y-1.5 text-sm">
              {versions.map((v) => (
                <li key={v.version} className="flex justify-between">
                  <span className={v.version === knowledge.version ? "font-semibold" : ""}>Version {v.version}</span>
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
