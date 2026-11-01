import { chatStore, extractionStatuses } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const runs = extractionStatuses().map((run) => ({
		id: run.part ? `${run.chatId}#${run.part.i}` : run.chatId,
		chatId: run.chatId,
		title:
			(run.label ?? chatStore.getChat(run.chatId)?.title ?? run.chatId) +
			(run.part ? ` · ${run.part.i}/${run.part.n}` : ""),
		phase: run.phase,
		startedAt: run.startedAt,
		usage: run.usage,
	}));
	return Response.json({ runs });
}
