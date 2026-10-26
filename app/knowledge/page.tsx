import { KnowledgeView } from "@/components/knowledge-view";
import { readSettingsRecord } from "@/src/server";
import { resolveSettings, slotsConfigured } from "@/src/core";

// The knowledge graph's own page (v4 redesign, 2026-10-26): the graph left
// the home route — "/" is the dashboard. Dynamic for the same reasons the
// graph page always was: the configured state is server-rendered into the
// first frame and every navigation re-reads the settings record.
export const dynamic = "force-dynamic";

export default async function KnowledgePage({ searchParams }: { searchParams: Promise<{ idea?: string }> }) {
	const { idea } = await searchParams;
	const record = readSettingsRecord();
	const rendering = resolveSettings(record ?? null).graph.rendering;
	return <KnowledgeView initialConfigured={slotsConfigured(record?.models)} rendering={rendering} focusIdeaId={idea} />;
}
