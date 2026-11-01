import { KnowledgeView } from "@/components/knowledge-view";
import { readSettingsRecord } from "@/src/server";
import { resolveSettings, slotsConfigured } from "@/src/core";

export const dynamic = "force-dynamic";

export default async function KnowledgePage({ searchParams }: { searchParams: Promise<{ idea?: string }> }) {
	const { idea } = await searchParams;
	const record = readSettingsRecord();
	const rendering = resolveSettings(record ?? null).graph.rendering;
	return <KnowledgeView initialConfigured={slotsConfigured(record?.models)} rendering={rendering} focusIdeaId={idea} />;
}
