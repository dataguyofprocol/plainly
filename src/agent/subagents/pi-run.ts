import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { APP_IDENTITY, piEngineFor, type PiEngine } from "../models.ts";
import { usageWasAdmitted } from "../subscription-request-cycle.ts";
import { providerEventObserver } from "../provider-events.ts";
import type { ModelRole } from "../../../config.ts";

/** See docs/pi-engine-swap.md §6. */

export interface SubagentRunOptions {
	role: ModelRole;
	engine?: PiEngine;
	systemPrompt: string;
	messages?: AgentMessage[];
	prompt?: string;
	maxTurns: number;
	abortSignal?: AbortSignal;
	onUsage?: (usage: Usage) => void;
	onToolStart?: (toolName: string, args: unknown) => void;
	onAssistantMessage?: (message: AssistantMessage, step: number) => void;
	shouldStop?: (message: AssistantMessage, toolResults: ToolResultMessage[]) => boolean;
	chatId?: string;
}

export interface SubagentRunResult {
	newMessages: AgentMessage[];
	text: string;
}

export function subagentEngine(role: ModelRole, override?: PiEngine): PiEngine {
	return override ?? piEngineFor(role);
}

export async function runSubagent(tools: AgentTool<any, any>[], opts: SubagentRunOptions): Promise<SubagentRunResult> {
	const engine = subagentEngine(opts.role, opts.engine);
	let turns = 0;
	const providerEvents = opts.chatId ? providerEventObserver(opts.chatId, `job:${opts.role}`) : undefined;
	const agent = new Agent({
		identity: APP_IDENTITY,
		sessionId: randomUUID(),
		initialState: {
			systemPrompt: opts.systemPrompt,
			model: engine.model,
			thinkingLevel: engine.level,
			tools,
			messages: opts.messages ?? [],
		},
		streamFn: engine.streamFn,
		...(providerEvents ? { onProviderStreamEvent: providerEvents } : {}),
		finishTurn: (turn) => {
			turns++;
			return turns >= opts.maxTurns || opts.shouldStop?.(turn.message, turn.toolResults) === true
				? { action: "end" }
				: undefined;
		},
	});

	const onAbort = () => agent.abort();
	opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

	const before = opts.messages?.length ?? 0;
	let step = 0;
	let errorMessage: string | undefined;
	let aborted = false;

	try {
		agent.subscribe((event: AgentEvent) => {
			switch (event.type) {
				case "message_end":
					if ((event.message as { role?: string }).role === "assistant") {
						const m = event.message as AssistantMessage;
						if (m.stopReason === "aborted") {
								aborted = true;
							break;
						}
						if (!usageWasAdmitted(m.usage)) { if (m.stopReason === "error") errorMessage = m.errorMessage; break; }
						step++;
						opts.onUsage?.(m.usage);
						opts.onAssistantMessage?.(m, step);
						if (m.stopReason === "error") errorMessage = m.errorMessage;
					}
					break;
				case "tool_execution_start":
					opts.onToolStart?.(event.toolName, event.args);
					break;
			}
		});
		if (opts.prompt !== undefined) await agent.prompt({
			role: "user",
			content: opts.prompt,
			timestamp: Date.now(),
		});
		else await agent.continue();
	} finally {
		opts.abortSignal?.removeEventListener("abort", onAbort);
	}

	if (aborted || opts.abortSignal?.aborted) {
		const err = new Error("aborted");
		err.name = "AbortError";
		throw err;
	}
	if (errorMessage !== undefined) throw new Error(errorMessage);

	// 0.87.1: drop the seeded leading SystemMessage (transcript rework —
	// see ui-stream's settleWith) before slicing past the input count, or
	// the seed displaces the slice and the last INPUT message leaks in.
	const newMessages = agent.state.messages
		.filter((m) => (m as { role?: string }).role !== "system")
		.slice(before);
	const assistants = newMessages.filter((m) => (m as { role?: string }).role === "assistant") as AssistantMessage[];
	const last = assistants[assistants.length - 1];
	const text = last
		? last.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("")
		: "";
	return { newMessages, text };
}