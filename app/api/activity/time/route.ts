/**
 * POST /api/activity/time. One active-learning heartbeat, body
 * {chatId: string, seconds: number}. Seconds clamp to 0..60 and an unknown
 * chat is dropped: 204 either way. A malformed body is 400.
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
