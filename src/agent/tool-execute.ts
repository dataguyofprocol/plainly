import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import { CONCLUDE_ACK_TEXT } from "../core/contracts/chat.ts";

const TOOL_TIMEOUT_MS = 30_000;
export const toolTimeoutMs = { current: TOOL_TIMEOUT_MS };

const TOOL_ABORT_GRACE_MS = 250;

function runWithAbortGuard<T>(
	toolName: string,
	run: (signal: AbortSignal) => T | Promise<T>,
	parent: AbortSignal | undefined,
): Promise<T> {
	const controller = new AbortController();
	const forwardAbort = () => controller.abort();
	if (parent) {
		if (parent.aborted) controller.abort();
		else parent.addEventListener("abort", forwardAbort, { once: true });
	}
	const timeoutMs = toolTimeoutMs.current;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const humanTimeout = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	const cleanup = () => {
		clearTimeout(timer);
		if (graceTimer) clearTimeout(graceTimer);
		parent?.removeEventListener("abort", forwardAbort);
	};
	return new Promise<T>((resolve, reject) => {
		const settle = (fn: () => void) => {
			controller.signal.removeEventListener("abort", onAbort);
			if (graceTimer) clearTimeout(graceTimer);
			fn();
		};
		const onAbort = () => {
			graceTimer = setTimeout(
				() =>
					reject(
						new Error(
							parent?.aborted
								? "Operation aborted"
								: `Tool "${toolName}" timed out after ${humanTimeout} — the result was discarded`,
						),
					),
				TOOL_ABORT_GRACE_MS,
			);
		};
		controller.signal.addEventListener("abort", onAbort, { once: true });
		if (controller.signal.aborted) onAbort(); // an already-aborted signal never fires listeners
		Promise.resolve()
			.then(() => run(controller.signal))
			.then(
				(v) => settle(() => resolve(v)),
				(e) => settle(() => reject(e)),
			);
	})
		.finally(cleanup);
}

export function invalidInputResult(
	toolName: string,
	problems: string[],
): AgentToolResult<{ tool: string; problems: string[] }> {
	return {
		content: [
			{
				type: "text",
				text: `Invalid tool input for tool "${toolName}":\n${problems.map((p) => `- ${p}`).join("\n")}`,
			},
		],
		isError: true,
		details: { tool: toolName, problems },
	};
}

export interface ImageFileResult {
	text: string;
	images?: { data: string; mimeType: string }[];
	details?: unknown;
}

function isImageResult(v: unknown): v is ImageFileResult {
	return (
		typeof v === "object" && v !== null && "text" in v && typeof (v as ImageFileResult).text === "string"
	);
}

export function toToolResult(result: unknown): AgentToolResult<unknown> {
	if (isImageResult(result)) {
		return {
			content: [
				{ type: "text", text: result.text },
				...(result.images ?? []).map((img) => ({
					type: "image" as const,
					data: img.data,
					mimeType: img.mimeType,
				})),
			],
			details: result.details ?? null,
		};
	}
	return {
		content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
		details: result,
	};
}

export interface ToolExecuteContext {
	toolCallId: string;
	signal?: AbortSignal;
}

export function serverExecute<P extends TSchema>(
	toolName: string,
	schema: P,
	run: (input: Static<P>, ctx: ToolExecuteContext) => unknown,
): AgentTool<any>["execute"] {
	// The returned execute is deliberately typed loose (params: unknown) so
	// it satisfies every AgentTool slot — heterogeneous registries type
	// AgentTool<any>, whose Static is unknown, and strictFunctionTypes
	// rejects a params-narrower function against it. The loop has already
	// validated arguments against `schema` (runtime) and `run` keeps the
	// precise Static<P> input; `schema` exists in the signature precisely so
	// P infers from the call site, not the loose surface.
	return async (toolCallId, input: unknown, signal) =>
		toToolResult(
			await runWithAbortGuard(toolName, (toolSignal) => run(input as Static<P>, { toolCallId, signal: toolSignal }), signal),
		);
}

export function questionResult(): AgentToolResult<null> {
	return {
		content: [
			{
				type: "text",
				text: "Question posed — the turn ends here; the learner's graded answer arrives as this call's result.",
			},
		],
		details: null,
		terminate: true,
	};
}

export function problemResult(): AgentToolResult<null> {
	return {
		content: [
			{
				type: "text",
				text: "Problem posed — the turn ends here; the learner's thinking traces and answer commits arrive as labeled messages.",
			},
		],
		details: null,
		terminate: true,
	};
}

export function concludeResult(): AgentToolResult<null> {
	return {
		content: [{ type: "text", text: CONCLUDE_ACK_TEXT }],
		details: null,
	};
}
