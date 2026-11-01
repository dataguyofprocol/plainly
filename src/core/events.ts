export interface ServerEvents {
	"turn-started": { chatId: string };
	/** Emitted after persistTurn, so a fetch on receipt reads a durable record. */
	"turn-settled": { chatId: string };
	/** chatId when known. */
	"jobs-changed": { chatId?: string };
	/** An extraction run changed phase. */
	"activity-changed": Record<string, never>;
	/** The session list changed (create, delete, title). */
	"chats-changed": Record<string, never>;
	/** A chat's record changed without a turn. */
	"record-changed": { chatId: string };
	/** While running, the server refuses model interaction for the chat. */
	"compaction-changed": { chatId: string; running: boolean };
}

export type ServerEventType = keyof ServerEvents;

export const SERVER_EVENT_TYPES = [
	"turn-started",
	"turn-settled",
	"jobs-changed",
	"activity-changed",
	"chats-changed",
	"record-changed",
	"compaction-changed",
] as const satisfies readonly ServerEventType[];

export type ServerEvent<K extends ServerEventType = ServerEventType> = {
	type: K;
} & ServerEvents[K];

export type ServerEventListener = (event: ServerEvent) => void;

interface LhEventsGlobal {
	__lhEventBus?: Set<ServerEventListener>;
}

/** On globalThis because Next dev compiles each route as its own module
 *  instance; a module-level set would not be shared. */
function listeners(): Set<ServerEventListener> {
	const g = globalThis as typeof globalThis & LhEventsGlobal;
	return (g.__lhEventBus ??= new Set());
}

export function subscribe(listener: ServerEventListener): () => void {
	const set = listeners();
	set.add(listener);
	return () => set.delete(listener);
}

/** A throwing listener is logged and never breaks the others or the emitter. */
export function emit<K extends ServerEventType>(type: K, payload: ServerEvents[K]): void {
	for (const listener of [...listeners()]) {
		try {
			listener({ type, ...payload } as ServerEvent);
		} catch (err) {
			console.error(`[events] listener failed on ${type}:`, err);
		}
	}
}
