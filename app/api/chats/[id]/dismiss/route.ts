/**
 * POST { input }: dismisses a pending question call by writing its dismissed
 * toolResult. Starts no turn; the next user message carries the dismissal
 * to the agent. Each dismissal completes exactly its own call (by toolCallId).
 * 404 unknown chat; 400 for an input that targets no dangling question call.
 * While a turn runs, the dismissal is parked and applied at settle: 202
 * { ok, parked: true }.
 */
import { ChatInputError, dismissAppends, emit, parseDismissInput } from "@/src/core";
import { getChat, isTurnRunning, parkDismissal, stores } from "@/src/server";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Unknown chat" }, { status: 404 });

	let input;
	try {
		const body = (await req.json().catch(() => null)) as { input?: unknown } | null;
		input = parseDismissInput(body?.input ?? null);
	} catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}

	if (isTurnRunning(id)) {
		parkDismissal(id, input);
		return Response.json({ ok: true, parked: true }, { status: 202 });
	}

	let appends;
	try {
		appends = dismissAppends(chat, input);
	} catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}

	const merged = [...chat.messages, ...appends];
	stores.chatStore.saveMessages(id, merged);
	emit("record-changed", { chatId: id });
	return Response.json({ ok: true });
}
