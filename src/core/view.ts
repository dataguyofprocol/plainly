import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { LhMarkerMessage, LhMessage } from "./native-messages.ts";
import { modelSolutionForConclude, PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, practiceHintsUsed, problemInputForConclude } from "./native-messages.ts";
import { activeCompactionOf, type CompactionDetails } from "./compaction.ts";
import { QUESTION_TOOLS } from "./pending.ts";
import type { SubagentArtifactData, SubagentResultMeta } from "./contracts/jobs.ts";
import type { PlanBlockData } from "./contracts/chat.ts";

export interface LhViewPart extends Record<string, unknown> {
	type: string;
	id?: string;
	text?: string;
	state?: string;
	toolCallId?: string;
	input?: unknown;
	output?: unknown;
	rawInput?: unknown;
	errorText?: string;
	data?: unknown;
}

export interface LhViewMessage {
	id: string;
	role: "user" | "assistant";
	parts: LhViewPart[];
	metadata?: unknown;
}

export interface LiveExecution {
	isError: boolean;
	output?: unknown;
	errorText?: string;
}

export interface LiveTurnState {
	/** Keyed by toolCallId. */
	executions: ReadonlyMap<string, LiveExecution>;
	inFlight: boolean;
	/** Ids of the messages streaming in this turn. */
	streamingIds: ReadonlySet<string>;
}

function textPart(text: string): LhViewPart {
	return { type: "text", text, state: "done" };
}

function applyResult(part: LhViewPart, result: ToolResultMessage): void {
	if (result.isError) {
		part.state = "output-error";
		part.rawInput = part.input;
		const text = result.content.find((c) => c.type === "text");
		part.errorText = text && text.type === "text" ? text.text : "The tool call failed.";
	} else {
		part.state = "output-available";
		part.output = result.details;
	}
}

function lastSuccessfulPlanInit(parts: LhViewPart[]): number {
	let idx = -1;
	parts.forEach((p, i) => {
		if (p.type !== "tool-plan_init") return;
		const ok = (p.output as { ok?: unknown } | undefined)?.ok;
		if (ok === true) idx = i;
	});
	return idx;
}

/** One assistant view message per group of consecutive assistant and
 *  toolResult messages, bounded by user and marker messages; a group's id is
 *  its first assistant message's id. A toolResult attaches to its call's
 *  part, searching backward across groups. */
export function projectView(messages: readonly LhMessage[], live?: LiveTurnState): LhViewMessage[] {
	const out: LhViewMessage[] = [];

	const lastAssistant = (): LhViewMessage | undefined => {
		const last = out[out.length - 1];
		return last && last.role === "assistant" ? last : undefined;
	};
	const findToolPart = (toolCallId: string): LhViewPart | undefined => {
		for (let i = out.length - 1; i >= 0; i--) {
			// Newest first: legacy DeepSeek records reuse `call_0` in every
			// response, so a result must pair with the most recent call of its id.
			const parts = out[i]!.parts;
			for (let p = parts.length - 1; p >= 0; p--) {
				const part = parts[p]!;
				if (part.type.startsWith("tool-") && part.toolCallId === toolCallId) return part;
			}
		}
		return undefined;
	};

	const compaction = activeCompactionOf(messages);

	for (const m of messages) {
		const role = (m as { role?: string }).role;

		if (compaction && m.id === compaction.details.firstKeptMessageId) {
			out.push({
				id: `cut_${compaction.id}`,
				role: "user",
				parts: [
					{
						type: "data-compaction-cut",
						id: `cc_${compaction.id}`,
						data: { content: compaction.content, details: compaction.details },
					},
				],
			});
		}

		if (role === "user") {
			const content = m.content as string | Array<{ type: string; text?: string }>;
			const texts =
				typeof content === "string"
					? [content]
					: content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);
			out.push({ id: m.id, role: "user", parts: texts.map(textPart) });
			continue;
		}

		if (role === "custom") {
			projectMarker(m as LhMarkerMessage, out);
			continue;
		}

		if (role === "toolResult") {
			applyResultTo(findToolPart((m as ToolResultMessage).toolCallId), m as ToolResultMessage);
			continue;
		}

		if (role === "assistant") {
			const assistant = m as AssistantMessage;
			// Reasoning first: GLM emits a trailing reasoning burst after the
			// answer text.
			const rest: LhViewPart[] = [];
			const reasoning: LhViewPart[] = [];
			let textN = 0;
			let reasoningN = 0;
			const streamingMessage = live?.streamingIds.has(m.id) === true;
			for (const block of assistant.content) {
				if (block.type === "text") {
					rest.push({ type: "text", id: `${m.id}-t${textN++}`, text: block.text, state: "done" });
				} else if (block.type === "thinking") {
					reasoning.push({ type: "reasoning", id: `${m.id}-r${reasoningN++}`, text: block.thinking, state: "done" });
				} else if (block.type === "toolCall") {
					const part = toolPartOf(block, live, streamingMessage);
					if (block.name === PRACTICE_CONCLUDE_TOOL) {
						part.reveal = modelSolutionForConclude(messages, block.id);
						part.problemInput = problemInputForConclude(messages, block.id);
					}
					if (block.name === PRACTICE_PROBLEM_TOOL) part.hints = practiceHintsUsed(messages, block.id);
					rest.push(part);
				}
			}
			const parts: LhViewPart[] = [...reasoning, ...rest];
			if (parts.length === 0) {
				if (live?.streamingIds.has(m.id)) {
					parts.push({ type: "reasoning", id: `${m.id}-r0`, text: "", state: "done" });
				} else {
					continue;
				}
			}
			const group = lastAssistant();
			if (group) {
				group.parts.push({ type: "step-start" }, ...parts);
			} else {
				out.push({ id: m.id, role: "assistant", parts: [{ type: "step-start" }, ...parts] });
			}
			continue;
		}
	}

	return out;
}

function isPlaceholderResultTool(name: string): boolean {
	return (QUESTION_TOOLS as readonly string[]).includes(name) || name === "problem";
}

function toolPartOf(
	block: { id: string; name: string; arguments?: unknown },
	live: LiveTurnState | undefined,
	streamingMessage: boolean,
): LhViewPart {
	const part: LhViewPart = {
		type: `tool-${block.name}`,
		toolCallId: block.id,
		input: block.arguments,
	};
	const exec = live?.executions.get(block.id);
	const isQuestion = isPlaceholderResultTool(block.name);
	if (exec) {
		if (exec.isError) {
			part.state = "output-error";
			part.rawInput = block.arguments;
			part.errorText = exec.errorText ?? "The tool call failed.";
		} else if (isQuestion) {
			part.state = "input-available";
		} else {
			part.state = "output-available";
			part.output = exec.output;
		}
	} else {
		part.state = streamingMessage ? "input-streaming" : "input-available";
	}
	return part;
}

function applyResultTo(part: LhViewPart | undefined, result: ToolResultMessage): void {
	if (part) {
		const tool = part.type.startsWith("tool-") ? part.type.slice("tool-".length) : part.type;
		const isQuestion = isPlaceholderResultTool(tool);
		if (isQuestion && !result.isError && result.details == null) {
			part.state = "input-available";
			return;
		}
		applyResult(part, result);
	}
}

function projectMarker(marker: LhMarkerMessage, out: LhViewMessage[]): void {
	switch (marker.customType) {
		case "graph-context": {
			out.push({
				id: marker.id,
				role: "user",
				parts: [{ type: "data-graph-context", id: `gc_${marker.id}`, data: marker.details }],
			});
			return;
		}
		case "probe-handoff": {
			out.push({
				id: marker.id,
				role: "user",
				parts: [{ type: "data-probe-handoff", id: `ph_${marker.id}`, data: marker.details }],
			});
			return;
		}
		case "subagent-steer": {
			const meta = marker.details as SubagentResultMeta;
			const artifact = marker.details as {
				kind: SubagentArtifactData["kind"];
				result: SubagentArtifactData["result"];
				ui?: SubagentArtifactData["ui"];
			};
			out.push({
				id: marker.id,
				role: "user",
				metadata: { subagentResult: meta },
				parts: [
					textPart(marker.content),
					{
						type: "data-subagent-artifact",
						id: `sa_${marker.id}`,
						data: { kind: artifact.kind, result: artifact.result, ui: artifact.ui },
					},
				],
			});
			return;
		}
		case "subagent-abort": {
			const meta = marker.details as SubagentResultMeta & { aborted: true };
			out.push({
				id: marker.id,
				role: "user",
				metadata: { subagentResult: meta },
				parts: [textPart(marker.content), { type: "data-subagent-aborted", id: `sa_${marker.id}`, data: meta }],
			});
			return;
		}
		case "practice-thinking": {
			out.push({
				id: marker.id,
				role: "user",
				parts: [{ type: "data-practice-thinking", id: `pt_${marker.id}`, data: marker.details }],
			});
			return;
		}
		case "practice-next": {
			out.push({
				id: marker.id,
				role: "user",
				parts: [{ type: "data-practice-next", id: `pn_${marker.id}`, data: null }],
			});
			return;
		}
		case "problem-dismissed":
			return;
		case "compaction": {
			out.push({
				id: marker.id,
				role: "user",
				parts: [
					{
					type: "data-compaction",
					id: `cm_${marker.id}`,
					data: { content: marker.content, details: marker.details as CompactionDetails },
				},
				],
			});
			return;
		}
		case "plan-block": {
			const group = out[out.length - 1];
			if (!group || group.role !== "assistant") return;
			const idx = lastSuccessfulPlanInit(group.parts);
			if (idx === -1) return;
			const { block } = marker.details as { planCallId: string; block: PlanBlockData };
			group.parts.splice(idx + 1, 0, { type: "data-plan-block", id: marker.id, data: block });
			return;
		}
	}
}
