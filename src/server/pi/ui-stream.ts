import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { SteerMessage } from "../../core/contracts.ts";
import { noteSteerVisible } from "../jobs.ts";
import { ToolCallIdUniquifier } from "./call-ids.ts";
import type { ChatGPTRequestCycle } from "../../agent/chatgpt-request-cycle.ts";

export type TurnWireEvent =
	| AgentEvent
	| { type: "message_update"; message: AgentMessage }
	| { type: "error"; errorText: string };

export interface PiTurnSpec {
	requestCycle?: ChatGPTRequestCycle;
	agent: Agent;
	onError?: (error: unknown) => string;
	onFinish: (messages: AgentMessage[], isAborted: boolean) => void;
	usedToolCallIds?: ReadonlySet<string>;
	updateFlushMs?: number;
}

export interface PiTurnSubscriber {
	push(event: TurnWireEvent): void;
	done(): void;
}

export interface PiTurnHandle {
	subscribe(): ReadableStream<Uint8Array>;
	abort(): void;
}

export function runPiTurn(spec: PiTurnSpec): PiTurnHandle {
	const { agent, onError, onFinish, usedToolCallIds, updateFlushMs = 100, requestCycle } = spec;
	const uniquifier = usedToolCallIds ? new ToolCallIdUniquifier(usedToolCallIds) : undefined;

	let settled = false;
	let sawAbort = false;

	const log: TurnWireEvent[] = [];
	// Live-update slots: coalesce key → log index of the retained update.
	// One assistant message streams at a time (pi's strict per-step
	// start → updates → end ordering), so messages share one slot; parallel
	// tool executions each own theirs (toolCallId). End events free the slot
	// — a later update for the same key starts a fresh run.
	const updateSlots = new Map<string, number>();
	const pending = new Map<string, TurnWireEvent>();
	const subscribers = new Set<PiTurnSubscriber>();

	const coalesceKey = (event: TurnWireEvent): string | null => {
		if (event.type === "message_update") return "message";
		if (event.type === "tool_execution_update") return `tool:${event.toolCallId}`;
		return null;
	};

	const send = (event: TurnWireEvent) => {
		if (settled) return;
		const key = coalesceKey(event);
		if (key !== null) {
			const idx = updateSlots.get(key);
			if (idx !== undefined) log[idx] = event;
			else {
				updateSlots.set(key, log.length);
				log.push(event);
			}
			pending.set(key, event);
			armFlush();
			return;
		}
		if (event.type === "message_end") updateSlots.delete("message");
		if (event.type === "tool_execution_end") updateSlots.delete(`tool:${event.toolCallId}`);
		flushPending();
		log.push(event);
		for (const sub of subscribers) sub.push(event);
	};

	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	const flushPending = () => {
		if (flushTimer !== undefined) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		if (pending.size === 0) return;
		const batch = [...pending.values()];
		pending.clear();
		for (const sub of subscribers) for (const event of batch) sub.push(event);
	};
	const armFlush = () => {
		if (flushTimer !== undefined) return;
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			flushPending();
		}, updateFlushMs);
		(flushTimer as { unref?: () => void }).unref?.();
	};
	const closeAll = () => {
		if (settled) return;
		flushPending();
		settled = true;
		for (const sub of subscribers) sub.done();
		subscribers.clear();
	};
	// 0.87.1 (transcript rework): the Agent seeds a leading SystemMessage
	// from initialState.systemPrompt (prompt + tool declarations) — it is
	// synthesized per turn and must NEVER persist (the record would bloat
	// with tool declarations AND replay would see messages[0] === system,
	// suppressing the fresh per-turn re-seed). Our app mints no system
	// messages of its own (the prompt is composed per turn), so dropping
	// the role wholesale is exact; revisit if prompt-updates ever land.
	const settleWith = () => {
		const settled_ = [...agent.state.messages].filter((m) => (m as { role?: string }).role !== "system");
		onFinish((uniquifier?.remapSettled(settled_) as AgentMessage[]) ?? settled_, sawAbort);
	};

	const handle = (event: AgentEvent) => {
		const uniqued = uniquifier ? uniquifier.event(event) : event;
		// WIRE DIET: slim the one event pi double-stuffs — our views read
		// `message`, never `assistantMessageEvent` (same full partial twice).
		const wire: TurnWireEvent =
			uniqued.type === "message_update"
				? { type: "message_update", message: uniqued.message }
				: uniqued;
		send(wire);
		if (event.type === "message_end") {
			const m = event.message as { role?: string; stopReason?: string } | undefined;
			if (m?.role === "assistant" && m.stopReason === "aborted") sawAbort = true;
			if (m?.role === "custom") noteSteerVisible(event.message as SteerMessage);
		}
		if (event.type === "agent_end") {
			closeAll();
			settleWith();
		}
	};
	requestCycle?.bindRelease(handle);
	agent.subscribe((event) => {
		if (!requestCycle?.hold(event)) handle(event);
	});

	void (async () => {
		try {
			do {
				await agent.continue();
				if (!requestCycle) break;
				const denied = requestCycle.deniedBeforeDispatch;
				const outcome = requestCycle.finishNativeCycle();
				if (denied) agent.state.messages = outcome.messages;
				if (outcome.action !== "resumeForeground") {
					handle({ type: "agent_end", messages: [...agent.state.messages] });
					break;
				}
			} while (!sawAbort);
		} catch (err) {
			if (settled) return;
			console.error("[turn] agent loop failed:", err);
			send({ type: "error", errorText: onError?.(err) ?? "An error occurred." });
			closeAll();
			settleWith();
		}
	})();

	return {
		subscribe() {
			let sub: PiTurnSubscriber | undefined;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder();
					let closed = false;
					sub = {
						push(event) {
							if (closed) return;
							try {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
							} catch {
								closed = true;
							}
						},
						done() {
							if (closed) return;
							closed = true;
							try {
								controller.enqueue(encoder.encode("data: [DONE]\n\n"));
								controller.close();
							} catch {
								/* already cancelled */
							}
						},
					};
					subscribers.add(sub);
					for (const event of log) sub.push(event);
					if (settled) sub.done();
				},
				cancel() {
					if (sub) subscribers.delete(sub);
				},
			});
			return stream;
		},
		abort() {
			if (settled) return;
			sawAbort = true;
			requestCycle?.abort();
			agent.abort();
		},
	};
}

export function piTurnResponse(handle: PiTurnHandle): Response {
	return new Response(handle.subscribe(), {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
