/**
 * Lives on globalThis, NOT a module-level Map: Next dev compiles each route
 * as its own entry, so a module-level singleton is a different instance per route.
 */

import { emit } from "../core/events.ts";

interface LhGlobal {
	__lhTurnRegistry?: Map<string, number>;
}

function registry(): Map<string, number> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhTurnRegistry ??= new Map<string, number>());
}

const inFlight = registry();
const MAX_TURN_MS = 30 * 60_000;

/**
 * Mark a turn as starting. Returns false if one is already running for the
 * chat — the caller rejects the request (only one turn may own a chat).
 * Announces "turn-started" AFTER the registry write: a listener that reads
 * isTurnRunning or fetches the record sees consistent truth. The rejected
 * double-begin (the 409 path) stays silent — no turn began.
 */
export function beginTurn(chatId: string): boolean {
	if (isTurnRunning(chatId)) return false;
	inFlight.set(chatId, Date.now());
	emit("turn-started", { chatId });
	return true;
}

export function endTurn(chatId: string): void {
	if (inFlight.delete(chatId)) emit("turn-settled", { chatId });
}

export function isTurnRunning(chatId: string): boolean {
	const since = inFlight.get(chatId);
	if (since === undefined) return false;
	if (Date.now() - since > MAX_TURN_MS) {
		inFlight.delete(chatId);
		return false;
	}
	return true;
}
