/**
 * Same globalThis discipline as turn-liveness.ts: Next dev compiles each
 * route as its own module instance.
 */

import type { PiTurnHandle } from "./pi/ui-stream.ts";

interface LhTurnRunsGlobal {
	__lhTurnRuns?: Map<string, PiTurnHandle>;
}

function runs(): Map<string, PiTurnHandle> {
	const g = globalThis as typeof globalThis & LhTurnRunsGlobal;
	return (g.__lhTurnRuns ??= new Map<string, PiTurnHandle>());
}

export function registerTurn(chatId: string, handle: PiTurnHandle): void {
	runs().set(chatId, handle);
}

export function unregisterTurn(chatId: string): void {
	runs().delete(chatId);
}

export function runningTurn(chatId: string): PiTurnHandle | undefined {
	return runs().get(chatId);
}

export function abortTurn(chatId: string): { ok: true } | { ok: false; reason: "not_running" } {
	const handle = runs().get(chatId);
	if (!handle) return { ok: false, reason: "not_running" };
	handle.abort();
	return { ok: true };
}

export function settledTurnResponse(): Response {
	return new Response('data: {"type":"turn-settled"}\n\ndata: [DONE]\n\n', {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
