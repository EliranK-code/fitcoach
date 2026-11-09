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
        title="Playground"
        description="Test the bot before it talks to real clients: the same engine, the same knowledge, the same safety rules"
      />
      {!s.cfg.ANTHROPIC_API_KEY && (
        <div className="mb-4">
          <Notice tone="yellow">
            ANTHROPIC_API_KEY is missing in .env. Without it only the consent notice works, and the bot can't answer.
          </Notice>
        </div>
      )}
      <Card>
        <Playground history={history} />
      </Card>
      <p className="mt-3 text-xs text-slate-500">
        The conversation here is saved as a separate test client: it doesn't appear in the client list or the stats, but alerts it opens do appear in the queue. "Start over" deletes
        the test client.
      </p>
    </>
  );
}
