/**
 * POST /api/activity/abort. Body {kind: "job"|"extraction"|"turn", id}: id is
 * the jobId for a job and the chatId for an extraction or a turn.
 * job: not_found -> 404, not_running -> 409, aborted -> 200.
 * turn: not_running -> 409, aborted -> 200.
 * extraction: idempotent, always 200.
 */
import { abortExtraction, abortJob, abortTurn } from "@/src/server";

export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const { kind, id } = (body ?? {}) as { kind?: string; id?: string };
	if ((kind !== "job" && kind !== "extraction" && kind !== "turn") || typeof id !== "string" || id === "") {
		return Response.json({ error: 'Body must be {kind: "job"|"extraction"|"turn", id: string}' }, { status: 400 });
	}
	if (!/^[A-Za-z0-9:_-]+$/.test(id)) {
		return Response.json({ error: "Invalid id" }, { status: 400 });
	}

	if (kind === "job") {
		const outcome = abortJob(id);
		if (!outcome.ok) {
			const status = outcome.reason === "not_found" ? 404 : 409;
			return Response.json({ ok: false, reason: outcome.reason }, { status });
		}
		return Response.json({ ok: true });
	}
	if (kind === "turn") {
		const outcome = abortTurn(id);
		if (!outcome.ok) return Response.json({ ok: false, reason: outcome.reason }, { status: 409 });
		return Response.json({ ok: true });
	}
	abortExtraction(id);
	return Response.json({ ok: true });
}
