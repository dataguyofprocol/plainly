import { compactionInFlight, deleteChatSession, getChat, isTurnRunning, sessionCoverage, sessionCost, stores, type ChatDeleteMode } from "@/src/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({
		...chat,
		messages: chat.messages,
		pricing: sessionCost(chat),
		turnInFlight: isTurnRunning(id),
		compacting: compactionInFlight(id),
		coverage: sessionCoverage(id),
	});
}

/**
 * Rename and archive. The body carries `title` (non-empty after trim),
 * `archived` (boolean), or both. Neither bumps updatedAt.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { title?: unknown; archived?: unknown } | null;
	const hasTitle = body?.title !== undefined;
	const hasArchived = body?.archived !== undefined;
	if (!hasTitle && !hasArchived) {
		return Response.json({ error: "send a title or archived" }, { status: 400 });
	}
	if (hasTitle && (typeof body.title !== "string" || body.title.trim() === "")) {
		return Response.json({ error: "title must be a non-empty string" }, { status: 400 });
	}
	if (hasArchived && typeof body.archived !== "boolean") {
		return Response.json({ error: "archived must be a boolean" }, { status: 400 });
	}
	let record = hasTitle ? stores.chatStore.renameChat(id, (body.title as string).trim()) : getChat(id)!;
	if (hasArchived) record = stores.chatStore.setArchived(id, body.archived as boolean);
	return Response.json({ title: record.title, archived: record.archived === true });
}

/**
 * DELETE /api/chats/[id]?mode=preserve-graph|delete-nodes. The mode is
 * required; there is no default.
 *
 *   preserve-graph  the session record, its jobs, and its extraction
 *                   bookkeeping go; the graph keeps what the session merged.
 *   delete-nodes    every ledger trace of the session goes too, and nodes
 *                   left with no other session are deleted.
 *
 * 409 while a turn or background job is running, 503 while the session's
 * extraction is winding down; both are retryable.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const mode = new URL(req.url).searchParams.get("mode");
	if (mode !== "preserve-graph" && mode !== "delete-nodes") {
		return Response.json(
			{
				error: 'mode is required and must be "preserve-graph" or "delete-nodes"',
				code: "bad_mode",
			},
			{ status: 400 },
		);
	}
	const outcome = await deleteChatSession(id, mode as ChatDeleteMode);
	if (!outcome.ok) {
		return Response.json(
			{
				error: outcome.error,
				code: outcome.code,
				...("jobIds" in outcome ? { jobIds: outcome.jobIds } : {}),
		},
			{ status: outcome.status },
		);
	}
	return Response.json({
		ok: true,
		mode: outcome.mode,
		stats: outcome.stats,
		jobsRemoved: outcome.jobsRemoved,
		graphRevision: outcome.graphRevision,
	});
}

