import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { invalidInputResult, toToolResult } from "../tool-execute.ts";
import type { ModelRole } from "../../../config.ts";
import type { PiEngine } from "../models.ts";
import { runSubagent } from "./pi-run.ts";
import { healToolRecord } from "../tools/heal.ts";
import { healEncodedArguments } from "../../core/argument-heal.ts";

// OpenRouter log evidence: weak models under a big submit payload often
// emit a whole array as ONE JSON-STRING instead of a native array
// ("propositions.0: must be object"). pi-agent-core runs
// `prepareArguments` BEFORE TypeBox validation — the sanctioned shim
// point (same doctrine as restoreMathEscapes at the display seam: heal
// weak-model wire behavior, don't punish it with a retry). Best-effort:
// heal only a string that parses to an array; anything else passes
// through untouched and fails validation exactly as before.
export function healStringifiedArrays(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return raw;
	const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
	for (const key of ["propositions", "chains"]) {
		const v = out[key];
		if (typeof v !== "string" || v.trim().length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(v);
			if (Array.isArray(parsed)) out[key] = parsed;
		} catch {
			// not a clean stringify (e.g. truncated) — leave for validation
		}
	}
	return out;
}

export async function runSubmitAgent<T>(opts: {
	role: ModelRole;
	toolName: string;
	toolDescription: string;
	parameters: TSchema;
	fill: (input: any) => T;
	systemPrompt: string;
	prompt: string;
	engine: PiEngine | undefined;
	signal: AbortSignal | undefined;
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void;
	neverSubmitted: string;
	extraTools?: Record<string, AgentTool<any>>;
	maxTurns?: number;
	chatId?: string;
	prepareArguments?: (args: unknown) => unknown;
	validate?: (value: T) => string | null;
}): Promise<T> {
	let submitted: T | undefined;
	const result = await runSubagent(
		[
		...(opts.extraTools ? Object.values(healToolRecord(opts.extraTools)) : []),
			{
				name: opts.toolName,
				label: opts.toolName,
				description: opts.toolDescription,
				parameters: opts.parameters,
				prepareArguments: (args) =>
					healEncodedArguments(
						opts.prepareArguments ? opts.prepareArguments(args) : args,
						opts.parameters,
					) as never,
				execute: async (_toolCallId, input) => {
					const value = opts.fill(input);
					const problem = opts.validate?.(value) ?? null;
					if (problem) return invalidInputResult(opts.toolName, [problem]);
					submitted = value;
					return toToolResult(submitted);
				},
			} satisfies AgentTool<any>,
		],
		{
			role: opts.role,
			engine: opts.engine,
			systemPrompt: opts.systemPrompt,
			prompt: opts.prompt,
			maxTurns: opts.maxTurns ?? 4,
			abortSignal: opts.signal,
			chatId: opts.chatId,
			onAssistantMessage: (message, step) =>
				opts.onStep(
					message.usage,
					`${message.provider}:${message.model}`,
					step,
					message.stopReason,
					message.content.filter((c) => c.type === "toolCall").map((c) => (c as { name: string }).name).join(", ") || "(none)",
				),
			shouldStop: (_message, toolResults) => toolResults.some((r) => r.toolName === opts.toolName && !r.isError),
		},
	);
	void result;
	if (!submitted) throw new Error(opts.neverSubmitted);
	return submitted;
}
