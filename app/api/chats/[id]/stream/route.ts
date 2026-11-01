/**
 * GET: the chat's turn as SSE. A running turn replays its full event log,
 * then streams live chunks until [DONE]. No running turn sends
 * {"type":"turn-settled"} + [DONE]. 404 unknown chat.
 */
import { getChat, runningTurn, piTurnResponse, settledTurnResponse } from "@/src/server";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	if (!getChat(id)) return Response.json({ error: "Unknown chat" }, { status: 404 });
	const handle = runningTurn(id);
	if (!handle) return settledTurnResponse();
	return piTurnResponse(handle);
}
