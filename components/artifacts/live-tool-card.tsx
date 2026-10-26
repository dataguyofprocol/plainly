"use client";

import { BrailleSpinner } from "@/components/braille-spinner";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { toolActivityLabel } from "@/src/core";
import { toolHeadline } from "@/components/artifacts/tool-headline";
import { TOOL_ICON, ToolRow } from "@/components/artifacts/tool-call-card";
import type { ArtifactPartProps } from "@/src/core";

/**
 * The LIVE tool-input card (owner, streaming round 2026-10-01): what a
 * tool call looks like while the agent WRITES it. A tool part sits in
 * `input-streaming` for its whole execution (the bridge defers
 * input-available to tool_execution_end), so this card IS the working
 * state — spinner + shimmered activity label in the header (the retired
 * transcript bottom line's text, same recipe as the thinking row), and
 * the streaming input itself watchable on expand. The moment the call
 * settles, the part re-renders through the artifact registry and the
 * quiet settled card replaces this one.
 *
 * The one working-state grammar everywhere (owner): Braille spinner +
 * Shimmer(duration 1) — the thinking row, this card, the sidebar row.
 */
interface StreamingToolPart {
	type: string;
	state: string;
	toolCallId: string;
	input?: unknown;
}

export function LiveToolCard({ part }: ArtifactPartProps) {
	const p = part as StreamingToolPart;
	const tool = p.type.replace(/^tool-/, "");
	const inp = (p.input ?? {}) as Record<string, unknown>;
	// The headline argument (ToolCallCard's rule, shown as given): path for
	// read/ls, pattern for find/grep, session for list_propositions.
	let arg = "";
	if (typeof inp.path === "string" && inp.path) arg = inp.path;
	else if (typeof inp.pattern === "string" && inp.pattern) arg = inp.pattern;
	else if (typeof inp.session === "string" && inp.session) arg = inp.session;

	const hasInput = p.input != null && Object.keys(inp).length > 0;

	const head = toolHeadline(tool, p.input);
	return (
		<details data-testid="live-tool-card" data-tool={tool} className="ls-tool">
			<ToolRow
				icon={TOOL_ICON[head.icon]}
				status="running"
				leading={<BrailleSpinner label={`${toolActivityLabel(tool)} — live`} />}
				label={<Shimmer duration={1} as="span">{toolActivityLabel(tool)}</Shimmer>}
				detail={head.detail ?? (arg || null)}
			/>
			<div className="ls-tool-body">
				<div>
					<span className="over">Input (streaming)</span>
					<pre className="short">{hasInput ? JSON.stringify(p.input, null, 2) : "…"}</pre>
				</div>
			</div>
		</details>
	);
}
