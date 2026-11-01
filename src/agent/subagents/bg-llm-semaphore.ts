const PERMIT_COUNT = 3;

export interface LlmSlots {
	active: number;
	queue: { resolve: () => void; dead: boolean }[];
}

interface LhLlmSemaphoreGlobal {
	__lhLlmSlots?: LlmSlots;
}

/** The process's single permit pool (globalThis — Next dev compiles each
 *  route entry as its own module instance; a module-level object would
 *  split the pool per route. One process, one truth). */
export function bgLlmSlots(): LlmSlots {
	const g = globalThis as typeof globalThis & LhLlmSemaphoreGlobal;
	return (g.__lhLlmSlots ??= { active: 0, queue: [] });
}

/** Run `critical` under one permit of the shared pool. `signal` (the
 *  caller's row/abort controller) kills a queued ticket: it marks itself
 *  dead and rejects AbortError — the handoff skips it. */
export async function withBgLlmSlot<T>(
	signal: AbortSignal | undefined,
	critical: () => Promise<T>,
): Promise<T> {
	const slots = bgLlmSlots();
	let freshTake = true;
	if (slots.active >= PERMIT_COUNT) {
		freshTake = false;
		await new Promise<void>((resolve, reject) => {
			const ticket: { resolve: () => void; dead: boolean } = { resolve, dead: false };
			slots.queue.push(ticket);
			if (!signal) return;
			const die = () => {
				ticket.dead = true;
				const err = new Error("background LLM job aborted while queued for a permit");
				err.name = "AbortError";
				reject(err);
			};
			if (signal.aborted) die();
			else signal.addEventListener("abort", die, { once: true });
		});
	}
	if (freshTake) slots.active++;
	try {
		return await critical();
	} finally {
		for (;;) {
			const next = slots.queue.shift();
			if (!next) {
				slots.active--;
				break;
			}
			if (next.dead) continue;
			next.resolve();
			break;
		}
	}
}
