/**
 * Lives on globalThis, NOT a module-level Map: Next.js gives the dismiss
 * route and the chat-handler entry separate module instances.
 */

import { ChatInputError, dismissAppends, emit } from "../core";
import type { ChatStore } from "../core/ports.ts";

export type ParkedDismissal = unknown;

interface LhGlobal {
	__lhParkedDismissals?: Map<string, ParkedDismissal>;
}

function registry(): Map<string, ParkedDismissal> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhParkedDismissals ??= new Map<string, ParkedDismissal>());
}

export function parkDismissal(chatId: string, input: ParkedDismissal): void {
	registry().set(chatId, input);
}

export function takeParkedDismissal(chatId: string): ParkedDismissal | null {
	const parked = registry().get(chatId);
	if (parked === undefined) return null;
	registry().delete(chatId);
	return parked;
}

export function applyParkedDismissal(chatStore: ChatStore, chatId: string): void {
	const input = takeParkedDismissal(chatId);
	if (input === null) return;
	const record = chatStore.getChat(chatId);
	if (!record) return;
	try {
		const appends = dismissAppends(record, input as Parameters<typeof dismissAppends>[1]);
		chatStore.saveMessages(chatId, [...record.messages, ...appends]);
		emit("record-changed", { chatId });
	} catch (err) {
		if (err instanceof ChatInputError) return;
		throw err;
	}
}
