/**
 * POST /api/activity/time — one active-learning heartbeat (v4 redesign,
 * 2026-10-26). Body {chatId: string, seconds: number}: the client beats
 * every 30s while a lesson/practice page is visible and the learner
 * interacted in the last 2 minutes. The server clamps seconds to 0..60
 * and appends to the month's ledger (server/activity.ts recordTimeBeat);
 * an unknown chat is dropped silently — 204 either way (a beacon reads
 * nothing). A malformed body is the honest 400.
 */
import { recordTimeBeat } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { chatId?: unknown; seconds?: unknown } | null;
	if (!body || typeof body.chatId !== "string" || typeof body.seconds !== "number") {
		return Response.json({ error: "body must be {chatId: string, seconds: number}" }, { status: 400 });
	}
	recordTimeBeat(body.chatId, body.seconds);
	return new Response(null, { status: 204 });
}
