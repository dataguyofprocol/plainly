/**
 * POST /api/graph/coverage/extract {chatId}: starts extraction over one
 * session's uncovered content, 202. 409 while a run is already in flight.
 */
import { extraction, extractionStatuses } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const chatId = (body as { chatId?: unknown }).chatId;
	if (typeof chatId !== "string" || chatId === "") {
		return Response.json({ error: 'Body must be {chatId: string}' }, { status: 400 });
	}
	if (extractionStatuses().some((run) => run.kind === "chat" && run.chatId === chatId)) {
		return Response.json({ error: "An extraction run is already in flight for this session" }, { status: 409 });
	}
	void extraction.runExtraction(chatId).catch((err: unknown) => {
		console.error(`[chat ${chatId}] manual extraction failed:`, err);
	});
	return Response.json({ started: true }, { status: 202 });
}