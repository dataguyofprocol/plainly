import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	needsContinuation,
	measuredContextTokens,
	newAnswerResult,
	newNextMessage,
	newProblemDismissedMarker,
	newThinkingMessage,
	newUserMessage,
	projectView,
	type ChatInput,
	type LhMarkerMessage,
	type LhMessage,
	type LhViewMessage,
	type LiveExecution,
	type QuestionAnswerData,
} from "../src/core";

export type SessionStatus = "ready" | "submitted" | "streaming" | "error";

export const TURN_POLL_MS = 500;
export const TURN_WAIT_MAX_MS = 30_000;

export interface SessionModelDeps {
	fetch?: typeof globalThis.fetch;
	pollMs?: number;
	waitMaxMs?: number;
}

let localSeq = 0;
function localId(): string {
	return `c_${Date.now().toString(36)}_${(localSeq++).toString(36)}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(new DOMException("Aborted", "AbortError"));
			},
			{ once: true },
		);
	});
}

async function turnInFlight(model: SessionModel): Promise<boolean | null> {
	try {
		const res = await model.fetch(`/api/jobs?chatId=${encodeURIComponent(model.chatId)}`);
		if (!res.ok) return null;
		return ((await res.json()) as { turnInFlight?: boolean }).turnInFlight === true;
	} catch {
		return null;
	}
}

async function* sseEvents(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		buf += decoder.decode(value, { stream: true });
		for (;;) {
			const end = buf.indexOf("\n\n");
			if (end === -1) break;
			const event = buf.slice(0, end);
			buf = buf.slice(end + 2);
			const dataLine = event.split("\n").find((l) => l.startsWith("data: "));
			if (!dataLine) continue;
			const data = dataLine.slice("data: ".length);
			if (data === "[DONE]") return;
			yield JSON.parse(data) as Record<string, unknown>;
		}
	}
}

export function pendingCallTool(messages: readonly LhMessage[], toolCallId: string): string | null {
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<{ type?: string; id?: string; name?: string }>) {
			if (block.type === "toolCall" && block.id === toolCallId) return block.name ?? null;
		}
	}
	return null;
}

export function absorbed(m: LhMessage, record: readonly LhMessage[]): boolean {
	if (typeof m.id !== "string" || !m.id.startsWith("c_")) return false;
	const role = (m as { role?: string }).role;
	if (role === "user") {
		const content = (m as { content?: unknown }).content;
		return record.some(
			(r) => (r as { role?: string }).role === "user" && (r as { content?: unknown }).content === content,
		);
	}
	if (role === "toolResult") {
		const toolCallId = (m as ToolResultMessage).toolCallId;
		return record.some(
			(r) =>
				(r as { role?: string }).role === "toolResult" &&
				(r as ToolResultMessage).toolCallId === toolCallId,
		);
	}
	if (role === "custom") {
		const marker = m as LhMarkerMessage;
		return record.some(
			(r) =>
				(r as { role?: string }).role === "custom" &&
				(r as LhMarkerMessage).customType === marker.customType &&
				sameDetails((r as LhMarkerMessage).details, marker.details),
		);
	}
	return false;
}

function sameDetails(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export interface SessionState {
	messages: LhViewMessage[];
	nativeMessages: LhMessage[];
	contextTokens: number | null;
	status: SessionStatus;
	error: { message: string } | null;
	steerQueue: SteerQueueItem[];
}

export interface SteerQueueItem {
	id: string;
	text: string;
}

export function visibleQueuedSteers(
	queue: readonly SteerQueueItem[],
	messages: readonly LhMessage[],
): SteerQueueItem[] {
	const ids = new Set(messages.map((m) => (m as { id?: string }).id));
	return queue.filter((s) => !ids.has(s.id));
}

export interface SessionModelOptions extends SessionModelDeps {
	chatId: string;
	initialMessages: LhMessage[];
	onChange?: () => void;
	onReattachSettled?: () => void;
}

export class SessionModel {
	readonly chatId: string;
	fetch: typeof globalThis.fetch;
	private steerQueueValue: SteerQueueItem[] = [];
	private readonly pollMs: number;
	private readonly waitMaxMs: number;
	private onReattachSettled?: () => void;
	onChange?: () => void;

	private base: LhMessage[];
	private tail: LhMessage[] = [];
	private executions = new Map<string, LiveExecution>();
	private streamingIds = new Set<string>();
	private incompleteUsageIds = new Set<string>();
	private streamingMessageId: string | null = null;
	private statusValue: SessionStatus = "ready";
	private errorValue: { message: string } | null = null;
	private liveFailureId: string | null = null;
	private consumeAbort: AbortController | null = null;
	readyRef = true;

	constructor(opts: SessionModelOptions) {
		this.chatId = opts.chatId;
		this.base = opts.initialMessages;
		// BOUND: the browser's native fetch is a Window method — storing it
		// unbound makes every call throw "Illegal invocation" in the browser
		// (Node's undici doesn't care, so the tests never saw it). Always go
		// through a receiver-preserving wrapper.
		this.fetch = opts.fetch ?? ((...args) => globalThis.fetch(...args));
		this.pollMs = opts.pollMs ?? TURN_POLL_MS;
		this.waitMaxMs = opts.waitMaxMs ?? TURN_WAIT_MAX_MS;
		this.onChange = opts.onChange;
		this.onReattachSettled = opts.onReattachSettled;
	}

	setReattachSettled(fn: () => void): void {
		this.onReattachSettled = fn;
	}

	getState(): SessionState {
		const live =
			this.statusValue === "submitted" || this.statusValue === "streaming"
				? { executions: this.executions, inFlight: true, streamingIds: this.streamingIds }
				: undefined;
		const messages = [...this.base, ...this.tail];
		const latest = messages.at(-1);
		const providerError =
			latest?.role === "assistant" && latest.stopReason === "error" &&
			!this.incompleteUsageIds.has(latest.id) && (!live || latest.id === this.liveFailureId)
				? { message: latest.errorMessage ?? "An error occurred." }
				: null;
		return {
			messages: projectView(messages, live),
			nativeMessages: messages,
			contextTokens: measuredContextTokens(messages, this.incompleteUsageIds),
			status: this.statusValue,
			error: this.errorValue ?? providerError,
			steerQueue: this.steerQueueValue,
		};
	}

	get status(): SessionStatus {
		return this.statusValue;
	}

	private mutate(fn: () => void): void {
		fn();
		this.onChange?.();
	}

	private setStatus(status: SessionStatus): void {
		if (status === "submitted") this.liveFailureId = null;
		this.statusValue = status;
		this.readyRef = status === "ready";
		this.onChange?.();
	}

	private setError(message: string | null): void {
		this.errorValue = message === null ? null : { message };
		this.onChange?.();
	}

	async postInputEvent(input: ChatInput, signal?: AbortSignal): Promise<Response> {
		const body = JSON.stringify({ chatId: this.chatId, input });
		const init: RequestInit = {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			signal,
		};
		let response = await this.fetch("/api/chat", init);
		let waited = 0;
		while (response.status === 409) {
			await response.body?.cancel().catch(() => {});
			if (signal?.aborted || waited >= this.waitMaxMs) return response;
			await delay(this.pollMs, signal);
			waited += this.pollMs;
			if (signal?.aborted) return response;
			if ((await turnInFlight(this)) !== false) continue;
			response = await this.fetch("/api/chat", init);
		}
		return response;
	}

	applyWireEvent(event: Record<string, unknown>): boolean {
		if (event.type === "error") {
			this.setError(String(event.errorText ?? "An error occurred."));
			return false;
		}
		const agent = event as unknown as AgentEvent;
		switch (agent.type) {
			case "message_start":
			case "message_update":
			case "message_end": {
				const message = agent.message as LhMessage & {
					role?: string;
					id?: string;
				};
				if ((message as { role?: string }).role !== "assistant") {
					// Wave C: markers injected mid-run (pi's follow-up delivery)
					// arrive as custom-role message_start/message_end events -
					// UPSERT by id (markers always carry steer_<id> ids; id-less
					// non-assistant events never occur - injected messages emit
					// start+end only, no streaming partials). Without this the
					// live stream dropped the marker until the settle sync.
					const mid = message.id;
					if (mid === undefined) return false;
					this.mutate(() => {
						const idx = this.tail.findIndex((m) => m.id === mid);
						this.tail =
							idx === -1 ? [...this.tail, message as LhMessage] : this.tail.with(idx, message as LhMessage);
					});
					return true;
				}
				// pi streams AssistantMessages with NO id; the id exists only once
				// persistTurn stamps the record. pi orders start → updates → end strictly
				// per step, so the in-flight message is tracked by slot: message_start
				// mints the id, updates and the end replace that same tail entry. An
				// explicit message.id still wins.
				const id = message.id ?? this.streamingMessageId ?? localId();
				const withId = { ...message, id } as LhMessage;
				if (agent.type === "message_end") {
					this.incompleteUsageIds.delete(id);
					if (message.role === "assistant" && message.stopReason === "error") {
						this.liveFailureId = id;
						this.errorValue = null;
					}
				} else this.incompleteUsageIds.add(id);
				if (agent.type === "message_start") {
					this.streamingMessageId = id;
					this.streamingIds.add(id);
					this.mutate(() => {
						this.tail = [...this.tail, withId];
					});
				} else {
					this.mutate(() => {
						const idx = this.tail.findIndex((m) => m.id === id);
						this.tail = idx === -1 ? [...this.tail, withId] : this.tail.with(idx, withId);
					});
				}
				if (agent.type === "message_end") {
					this.streamingMessageId = null;
				}
				return true;
			}
			case "tool_execution_end": {
				const result = agent.result as
					| { content?: Array<{ type?: string; text?: string }>; details?: unknown }
					| null;
				const text = result?.content?.find((c) => c.type === "text")?.text ?? "The tool call failed.";
				this.mutate(() => {
					this.executions = new Map(this.executions).set(agent.toolCallId, {
						isError: agent.isError,
						output: result?.details,
						errorText: text,
					});
				});
				return true;
			}
			case "turn_end": {
				this.mutate(() => {
					this.tail = [
						...this.tail,
						...(agent.toolResults as ToolResultMessage[]).map(
							(r) => ({ ...r, id: localId() }) as unknown as LhMessage,
						),
					];
				});
				return true;
			}
			default:
				return false;
		}
	}

	async consumeStream(res: Response, controller = this.consumeAbort): Promise<void> {
		if (!res.body) throw new Error("The turn stream body is empty.");
		const reader = res.body.getReader();
		let sawEvent = false;
		try {
			for await (const event of sseEvents(reader)) {
				if (this.consumeAbort !== controller) return;
				if (event.type === "turn-settled") {
					await reader.cancel().catch(() => {});
					if (this.consumeAbort === controller) this.onReattachSettled?.();
					return;
				}
				const acted = this.applyWireEvent(event);
				if (!sawEvent && acted) {
					sawEvent = true;
					if (this.statusValue !== "error") this.setStatus("streaming");
				}
			}
		} finally {
			if (this.consumeAbort === controller) {
				this.streamingIds = new Set();
				this.executions = new Map();
				if (this.statusValue !== "error") this.setStatus("ready");
			}
		}
	}

	async resumeStream(refetchRecordFirst = true): Promise<void> {
		this.consumeAbort?.abort();
		const controller = new AbortController();
		this.consumeAbort = controller;
		if (!refetchRecordFirst) {
			this.mutate(() => {
				this.incompleteUsageIds.clear();
				this.tail = [];
				this.streamingMessageId = null;
			});
		}
		this.setStatus("submitted");
		try {
			if (refetchRecordFirst) {
				const recordRes = await this.fetch(`/api/chats/${encodeURIComponent(this.chatId)}`, {
					signal: controller.signal,
				});
				if (this.consumeAbort !== controller) return;
				if (recordRes.ok) {
					const record = (await recordRes.json()) as { messages?: LhMessage[] };
					if (this.consumeAbort !== controller) return;
					if (Array.isArray(record.messages)) {
						this.mutate(() => {
							this.base = record.messages!;
							this.incompleteUsageIds.clear();
							this.tail = [];
						});
					}
				} else {
					this.mutate(() => {
						this.incompleteUsageIds.clear();
						this.tail = [];
						this.streamingMessageId = null;
					});
				}
			}
			const res = await this.fetch(`/api/chats/${encodeURIComponent(this.chatId)}/stream`, {
				signal: controller.signal,
			});
			if (this.consumeAbort !== controller) return;
			if (!res.ok) throw new Error((await res.text()) || "Failed to attach to the running turn.");
			await this.consumeStream(res, controller);
		} catch (err) {
			if (this.consumeAbort !== controller || (err as Error).name === "AbortError") return;
			this.setError((err as Error).message);
			this.setStatus("error");
		}
	}

	async send(input: ChatInput): Promise<void> {
		if (!this.readyRef) return;
		this.consumeAbort?.abort();
		const controller = new AbortController();
		this.consumeAbort = controller;
		this.setError(null);
		this.setStatus("submitted");
		const optimistic: LhMessage[] = [];
		if (input.type === "text") optimistic.push({ ...newUserMessage(input.text), id: localId() });
		else if (input.type === "thinking") {
			optimistic.push({ ...newThinkingMessage(input.problemCallId, input.text), id: localId() });
		} else if (input.type === "next") {
			optimistic.push({ ...newNextMessage(), id: localId() });
		} else if (input.type === "answer") {
			const tool = pendingCallTool([...this.base, ...this.tail], input.toolCallId) ?? "quiz";
			optimistic.push({ ...newAnswerResult(input.toolCallId, tool, input.answer), id: localId() });
		}
		if (optimistic.length > 0) this.mutate(() => {
			this.tail = [...this.tail, ...optimistic];
		});
		try {
			const res = await this.postInputEvent(input);
			if (res.status === 409) {
				this.setError("A turn is already running — try again in a moment.");
				this.setStatus("error");
				return;
			}
			if (!res.ok) {
				throw new Error((await res.text()) || `The send failed (${res.status}).`);
			}
			// One live view connection per page: the browser's 6-per-origin
			// connection pool is the scarce resource.
			await res.text().catch(() => {});
			if (this.consumeAbort !== controller) return;
			await this.resumeStream(true);
		} catch (err) {
			if ((err as Error).name === "AbortError") return;
			this.setError((err as Error).message);
			this.setStatus("error");
		}
	}

	async steer(text: string): Promise<void> {
		const t = text.trim();
		if (!t) return;
		const id = `steer_${localId()}`;
		this.steerQueueValue = [...this.steerQueueValue, { id, text: t }];
		this.onChange?.();
		const dropSteer = () => {
			this.steerQueueValue = this.steerQueueValue.filter((s) => s.id !== id);
			this.onChange?.();
		};
		try {
			const res = await this.fetch(`/api/chats/${this.chatId}/steer`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: { type: "steer", id, text: t } }),
			});
			if (res.ok) return;
			if (res.status === 409) {
				dropSteer();
				await this.send({ type: "text", text: t });
				return;
			}
			dropSteer();
			this.setError((await res.text()) || `The steer failed (${res.status}).`);
		} catch (err) {
			dropSteer();
			this.setError((err as Error).message);
		}
	}

	submitAnswer(tool: string, toolCallId: string, output: QuestionAnswerData): Promise<void> {
		void tool;
		return this.send({ type: "answer", toolCallId, answer: output });
	}

	async dismissQuestion(toolCallId: string, answer: QuestionAnswerData): Promise<void> {
		if (!this.readyRef) return;
		const tool = pendingCallTool([...this.base, ...this.tail], toolCallId) ?? "quiz";
		this.mutate(() => {
			this.tail = [...this.tail, { ...newAnswerResult(toolCallId, tool, answer), id: localId() }];
		});
		try {
			const res = await this.fetch(`/api/chats/${this.chatId}/dismiss`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: { type: "dismiss", toolCallId, answer } }),
			});
			if (!res.ok) throw new Error(`The dismissal failed (${res.status}).`);
		} catch (err) {
			this.setError((err as Error).message);
		}
	}

	async dismissProblem(problemCallId: string): Promise<void> {
		if (!this.readyRef) return;
		this.mutate(() => {
			this.tail = [...this.tail, { ...newProblemDismissedMarker(problemCallId), id: localId() }];
		});
		try {
			const res = await this.fetch(`/api/chats/${this.chatId}/dismiss`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: { type: "dismiss-problem", problemCallId } }),
			});
			if (!res.ok) throw new Error(`The dismissal failed (${res.status}).`);
		} catch (err) {
			this.setError((err as Error).message);
		}
	}

	stop(): void {
		this.consumeAbort?.abort();
		this.consumeAbort = null;
		this.streamingIds = new Set();
		this.streamingMessageId = null;
		this.executions = new Map();
		this.setStatus("ready");
	}

	setMessages(record: LhMessage[]): void {
		this.mutate(() => {
			this.base = record;
			this.incompleteUsageIds.clear();
			this.tail = [];
			this.streamingMessageId = null;
		});
	}

	adoptRecord(record: LhMessage[]): void {
		const recordIds = new Set(record.map((m) => (m as { id?: string }).id));
		const baseAbsorbed = this.base.some((m) => !recordIds.has((m as { id?: string }).id));
		if (baseAbsorbed) return;
		this.mutate(() => {
			this.base = record;
			this.tail = this.tail.filter((m) => !absorbed(m, record));
		});
	}

	static needsContinuation = needsContinuation;

	clearError(): void {
		this.setError(null);
	}
}
