"use client";

import { Icon, type IconName } from "@/components/ui/icon";
import { toolHeadline, type ToolIcon } from "@/components/artifacts/tool-headline";
import type { ArtifactPartProps } from "@/src/core";

/**
 * The generic tool-call card (sources v1, 2026-09-19; v4 chip 2026-10-26):
 * a quiet, collapsed chip per synchronous tool call — what it did, in
 * plain words (tool-headline.ts), plus its subject — expandable to the
 * tool's name and the full input and output. The user's spec:
 * "at least the tool name; for read, the file name; everything collapsed
 * by default; not distracting — background stuff." Unregistered tools
 * still render nothing (chat.tsx's registry default); this card is only
 * for the learner-filesystem set (read/ls/find/grep) where the call IS
 * worth a trace in the transcript.
 */

interface ToolCallPart {
	type: string;
	state: string;
	toolCallId: string;
	input?: unknown;
	output?: unknown;
	errorText?: string;
}

/** Render a tool result body: plain strings verbatim, image-bearing read
 *  results show their text + an attachment note (the image itself is the
 *  model's — the learner sees only that it happened). */
function outputText(output: unknown): string | null {
	if (output == null) return null;
	if (typeof output === "string") return output;
	if (typeof output === "object" && "text" in (output as Record<string, unknown>)) {
		const o = output as { text?: unknown; images?: unknown[] };
		const text = typeof o.text === "string" ? o.text : null;
		const n = Array.isArray(o.images) ? o.images.length : 0;
		return n > 0 ? `${text ?? ""}\n[${n} image${n > 1 ? "s" : ""} attached to the model]`.trim() : text;
	}
	try {
		return JSON.stringify(output, null, 2);
	} catch {
		return String(output);
	}
}

/** The tool kind's glyph (tool-headline.ts names the kind). */
export const TOOL_ICON: Record<ToolIcon, IconName> = {
	sessions: "history",
	ideas: "path",
	file: "file",
	folder: "import",
	search: "search",
};

/** THE ROW — the one grammar every call and job line in the transcript
 *  speaks (finesse pass, 2026-10-26): kind icon (a spinner while it
 *  runs), the verb label, the argument in mono, the status glyph, and a
 *  chevron when there is something to open. Rendered as the <summary> of
 *  an expandable row, or as a plain div for a static line. */
export function ToolRow({
	icon,
	label,
	detail,
	note,
	status,
	expandable = true,
	leading,
	trailing,
	as = "summary",
	testId,
}: {
	icon: IconName;
	label: React.ReactNode;
	detail?: string | null;
	/** Quiet words after the label ("delivered", "complete · 6 sources"). */
	note?: React.ReactNode;
	status: "running" | "done" | "failed" | "info";
	expandable?: boolean;
	/** Replaces the kind icon (the live card's spinner). */
	leading?: React.ReactNode;
	trailing?: React.ReactNode;
	as?: "summary" | "div";
	testId?: string;
}) {
	const Tag = as;
	return (
		<Tag className={`ls-row${status === "failed" ? " failed" : ""}`} data-testid={testId}>
			{leading ?? <Icon name={icon} size="sm" className="ls-kind" />}
			<span className="ls-label">{label}</span>
			{detail && <span className="ls-arg" title={detail}>{detail}</span>}
			{note && <span className="ls-note">{note}</span>}
			{status === "done" && <Icon name="status-ok" size="sm" className="text-good" label="Done" />}
			{status === "failed" && <Icon name="status-error" size="sm" className="text-danger" label="Failed" />}
			{trailing}
			{expandable && <Icon name="chevron-right" size="xs" className="ls-chev" />}
		</Tag>
	);
}

/** The settled chip's shell — kept for callers that only need the
 *  summary (the live card shares the row grammar). */
export function ToolChip({
	icon,
	label,
	detail,
	status,
}: {
	icon: ToolIcon;
	label: React.ReactNode;
	detail: string | null;
	status: "running" | "done" | "failed";
}) {
	return <ToolRow icon={TOOL_ICON[icon]} label={label} detail={detail} status={status} />;
}

export function ToolCallCard({ part }: ArtifactPartProps) {
	const p = part as ToolCallPart;
	const tool = p.type.replace(/^tool-/, "");
	const head = toolHeadline(tool, p.input);
	const out = outputText(p.output);
	const failed = p.state === "output-error" || typeof p.errorText === "string";
	return (
		<details data-testid="tool-call-card" data-tool={tool} className="ls-tool">
			<ToolChip icon={head.icon} label={failed ? `${head.label} — failed` : head.label} detail={head.detail} status={failed ? "failed" : p.state === "output-available" ? "done" : "running"} />
			<div className="ls-tool-body">
				{p.input != null && (
					<div>
						<span className="over">
							Input · <span className="mono">{tool}</span>
						</span>
						<pre className="short">{JSON.stringify(p.input, null, 2)}</pre>
					</div>
				)}
				{typeof p.errorText === "string" ? (
					<div>
						<span className="over">Error</span>
						<pre className="err">{p.errorText}</pre>
					</div>
				) : out != null ? (
					<div>
						<span className="over">Output</span>
						<pre>{out}</pre>
					</div>
				) : (
					p.state !== "output-available" && <span className="faint">Running…</span>
				)}
			</div>
		</details>
	);
}
