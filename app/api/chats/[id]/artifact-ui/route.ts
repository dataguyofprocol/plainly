/**
 * POST: persists the invert switch of a demo/figure steer message
 * (details.ui.inverted). Starts no turn and emits no event.
 * 404 unknown chat; 400 for a body that isn't
 * { input: { messageId, inverted } } or targets no demo/visual steer.
 */
import { setSteerUiInverted, type SteerDetails } from "@/src/core";
import { getChat, stores } from "@/src/server";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Unknown chat" }, { status: 404 });

	const body = (await req.json().catch(() => null)) as { input?: unknown } | null;
	const input = body?.input as { messageId?: unknown; inverted?: unknown } | null | undefined;
	if (
		!input ||
		typeof input !== "object" ||
		typeof input.messageId !== "string" ||
		typeof input.inverted !== "boolean"
	) {
		return Response.json({ error: "input must be { messageId: string, inverted: boolean }" }, { status: 400 });
	}

	const target = chat.messages.find((m) => m.id === input.messageId);
	const details = target ? ((target as { details?: unknown }).details as Partial<SteerDetails> | undefined) : undefined;
	if (!details || (details.kind !== "demo" && details.kind !== "visual")) {
		return Response.json({ error: "No demo/figure steer with that message id" }, { status: 400 });
	}

	const messages = setSteerUiInverted(chat.messages, input.messageId, input.inverted);
	stores.chatStore.saveMessages(id, messages);
	return Response.json({ ok: true });
}
